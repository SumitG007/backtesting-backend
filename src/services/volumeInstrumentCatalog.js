const { resolveSymbolConfig } = require('../utils/market');
const { loadInstrumentMaster, pickSecurityIdFromRow } = require('./dhanLiveService');

const PINNED_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'HDFCBANK', 'RELIANCE', 'ICICIBANK', 'TCS', 'INFY'];

let catalogCache = { map: null, builtAt: 0 };
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return null;
}

function normalizeExchangeSegment(row) {
  const exch = String(pickField(row, ['EXCH_ID', 'EXCHANGE']) || '').toUpperCase();
  const segment = String(pickField(row, ['SEGMENT', 'EXCHANGE_SEGMENT']) || '').toUpperCase();
  if (exch === 'NSE' && segment === 'D') return 'NSE_FNO';
  if (exch === 'NSE' && segment === 'E') return 'NSE_EQ';
  if (exch === 'NSE' && segment === 'I') return 'IDX_I';
  return segment || exch;
}

function cleanSymbol(raw) {
  const s = String(raw || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-EQ$/i, '')
    .replace(/-BE$/i, '');
  if (!s || s.length > 32 || !/^[A-Z0-9&]+$/.test(s)) return null;
  return s;
}

/** NSE/Dhan mock rows in the scrip master (e.g. O11NSETEST) — not real tradable names. */
function isTestOrMockSymbol(symbol, displayName = '') {
  const s = String(symbol || '').toUpperCase();
  const d = String(displayName || '').toUpperCase();
  if (!s) return true;
  if (/TEST|DUMMY|MOCK|SAMPLE/i.test(s) || /TEST|DUMMY|MOCK/i.test(d)) return true;
  if (/NSETEST|BSETEST/i.test(s)) return true;
  if (/^O\d+NSE/i.test(s)) return true;
  return false;
}

function toSearchResult(entry) {
  return {
    symbol: entry.symbol,
    displayName: entry.displayName,
    cash: entry.cash,
    future: entry.future,
    futureType: entry.futureType,
    label: entry.cash && entry.future
      ? `${entry.symbol} · cash + futures`
      : entry.future
        ? `${entry.symbol} · futures`
        : `${entry.symbol} · cash`,
  };
}

function equitySymbolFromRow(row) {
  const ul = cleanSymbol(pickField(row, ['UNDERLYING_SYMBOL', 'UNDERLYING']));
  if (ul) return ul;
  const name = pickField(row, ['SYMBOL_NAME', 'SEM_TRADING_SYMBOL', 'DISPLAY_NAME']) || '';
  return cleanSymbol(name.split('-')[0]);
}

async function buildCatalogMap() {
  if (catalogCache.map && Date.now() - catalogCache.builtAt < CATALOG_TTL_MS) {
    return catalogCache.map;
  }

  const rows = await loadInstrumentMaster();
  const map = new Map();

  const ensure = (symbol) => {
    if (!map.has(symbol)) {
      map.set(symbol, {
        symbol,
        cash: false,
        future: false,
        cashSecurityId: null,
        futureType: null,
        displayName: symbol,
      });
    }
    return map.get(symbol);
  };

  for (const row of rows) {
    const exch = normalizeExchangeSegment(row);
    const instr = String(pickField(row, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '').toUpperCase();

    if (instr === 'EQUITY' && exch === 'NSE_EQ') {
      const sym = equitySymbolFromRow(row);
      const sid = pickSecurityIdFromRow(row);
      if (!sym || !sid || isTestOrMockSymbol(sym)) continue;
      const entry = ensure(sym);
      entry.cash = true;
      entry.cashSecurityId = sid;
      const disp = pickField(row, ['DISPLAY_NAME', 'SYMBOL_NAME']);
      if (disp) entry.displayName = String(disp).split('-')[0].trim() || sym;
    }

    if (instr === 'FUTSTK' || instr === 'FUTIDX') {
      const ul = cleanSymbol(pickField(row, ['UNDERLYING_SYMBOL', 'SEM_TRADING_SYMBOL', 'SYMBOL_NAME']));
      if (!ul || isTestOrMockSymbol(ul)) continue;
      const entry = ensure(ul);
      entry.future = true;
      entry.futureType = instr;
    }
  }

  catalogCache = { map, builtAt: Date.now() };
  return map;
}

function scoreMatch(symbol, query) {
  const q = query.toUpperCase();
  const s = symbol.toUpperCase();
  if (!q) return 0;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 500 + (100 - Math.min(99, s.length));
  if (s.includes(q)) return 200;
  return 0;
}

async function searchInstruments(query, limit = 25) {
  const map = await buildCatalogMap();
  const q = String(query || '').trim().toUpperCase();
  const max = Math.max(1, Math.min(50, Number(limit) || 25));

  let candidates = [...map.values()].filter(
    (e) => (e.cash || e.future) && !isTestOrMockSymbol(e.symbol, e.displayName),
  );

  if (q.length >= 1) {
    candidates = candidates
      .filter((e) => e.symbol.includes(q) || e.displayName.toUpperCase().includes(q))
      .sort((a, b) => scoreMatch(b.symbol, q) - scoreMatch(a.symbol, q));
  } else {
    candidates = PINNED_SYMBOLS.map((sym) => map.get(sym)).filter(Boolean);
  }

  return candidates.slice(0, max).map(toSearchResult);
}

/** Quick pick row — only well-known names, never random CSV fillers. */
async function getFeaturedInstruments() {
  const map = await buildCatalogMap();
  return PINNED_SYMBOLS.map((sym) => map.get(sym))
    .filter((e) => e && (e.cash || e.future) && !isTestOrMockSymbol(e.symbol, e.displayName))
    .map(toSearchResult);
}

async function getInstrumentEntry(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const map = await buildCatalogMap();
  return map.get(upper) || null;
}

async function resolveCashFromCatalog(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const entry = await getInstrumentEntry(upper);
  if (entry?.cash && entry.cashSecurityId) {
    return {
      symbol: entry.symbol,
      securityId: entry.cashSecurityId,
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      product: 'cash',
      expiry: null,
      tradingSymbol: entry.displayName,
      displayName: `${entry.symbol} · NSE cash (equity)`,
    };
  }

  const preset = resolveSymbolConfig(upper);
  if (preset.securityId && preset.exchangeSegment === 'IDX_I') {
    return {
      symbol: upper,
      securityId: String(preset.securityId),
      exchangeSegment: 'IDX_I',
      instrument: preset.instrument || 'INDEX',
      product: 'cash',
      expiry: null,
      tradingSymbol: upper,
      displayName: `${upper} · NSE index`,
    };
  }

  throw new Error(`No NSE cash or index listing found for ${upper} in Dhan instrument master`);
}

function parseSymbolFilter(q = '') {
  const raw = String(q || '').trim().toUpperCase();
  if (!raw) return { mode: 'all', terms: [] };
  const terms = [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
  if (terms.length > 1) return { mode: 'multi', terms };
  return { mode: 'single', terms: [terms[0]] };
}

function matchesSymbolFilter(entry, filter) {
  if (!filter || filter.mode === 'all') return true;
  const sym = String(entry.symbol || '').toUpperCase();
  const name = String(entry.displayName || '').toUpperCase();
  return filter.terms.some((term) => {
    if (filter.mode === 'multi') {
      return sym === term || sym.startsWith(term) || name.includes(term);
    }
    return sym.includes(term) || name.includes(term);
  });
}

async function buildSymbolListForProduct({ product = 'cash', q = '' } = {}) {
  const map = await buildCatalogMap();
  const prod = String(product || 'cash').toLowerCase() === 'future' ? 'future' : 'cash';
  const filter = parseSymbolFilter(q);

  let list = [...map.values()].filter(
    (e) => !isTestOrMockSymbol(e.symbol, e.displayName),
  );

  if (prod === 'future') {
    list = list.filter((e) => e.future);
  } else {
    list = list.filter((e) => e.cash);
    for (const sym of ['NIFTY', 'BANKNIFTY']) {
      if (list.some((e) => e.symbol === sym)) continue;
      const preset = resolveSymbolConfig(sym);
      if (preset.securityId) {
        list.push({
          symbol: sym,
          displayName: sym,
          cash: true,
          future: Boolean(map.get(sym)?.future),
        });
      }
    }
  }

  if (filter.mode !== 'all') {
    list = list.filter((e) => matchesSymbolFilter(e, filter));
  }

  list.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { product: prod, list, filter };
}

async function listAllSymbolsByProduct({ product = 'cash', q = '' } = {}) {
  const { product: prod, list } = await buildSymbolListForProduct({ product, q });
  return {
    product: prod,
    symbols: list.map((e) => e.symbol),
    entries: list.map(toSearchResult),
    total: list.length,
  };
}

async function listSymbolsByProduct({
  product = 'cash',
  q = '',
  page = 1,
  pageSize = 25,
} = {}) {
  const { product: prod, list } = await buildSymbolListForProduct({ product, q });
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.max(1, Math.min(50, Number(pageSize) || 25));

  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const pageClamped = Math.min(safePage, totalPages);
  const start = (pageClamped - 1) * safeSize;
  const slice = list.slice(start, start + safeSize);

  return {
    product: prod,
    symbols: slice.map((e) => e.symbol),
    entries: slice.map(toSearchResult),
    total,
    page: pageClamped,
    pageSize: safeSize,
    totalPages,
  };
}

async function getCatalogMeta() {
  const map = await buildCatalogMap();
  let cashCount = 0;
  let futureCount = 0;
  let bothCount = 0;
  for (const e of map.values()) {
    if (e.cash) cashCount += 1;
    if (e.future) futureCount += 1;
    if (e.cash && e.future) bothCount += 1;
  }
  return {
    totalSymbols: map.size,
    cashCount,
    futureCount,
    bothCount,
    source: 'dhan-instrument-master',
    refreshedAt: catalogCache.builtAt ? new Date(catalogCache.builtAt).toISOString() : null,
  };
}

module.exports = {
  PINNED_SYMBOLS,
  buildCatalogMap,
  searchInstruments,
  getFeaturedInstruments,
  getInstrumentEntry,
  resolveCashFromCatalog,
  getCatalogMeta,
  listSymbolsByProduct,
  listAllSymbolsByProduct,
  parseSymbolFilter,
  isTestOrMockSymbol,
};

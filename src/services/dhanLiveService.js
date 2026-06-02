const axios = require('axios');
const WebSocket = require('ws');
const { readLatestAccessToken, isLikelyDhanAuthError, ensureValidDhanAccessToken } = require('./tokenService');
const { getDhanClientId } = require('./dhanTokenStore');
const { resolveSymbolConfig } = require('../utils/market');
const { parseDateOnly, formatDateOnly, addDays } = require('../utils/dateTime');
const { ensureNseHolidaysLoaded, isNseCashTradingDay } = require('./nseHolidayService');

const DHAN_BASE = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
const DHAN_WS_URL = 'wss://api-feed.dhan.co';
const INSTRUMENT_CSV_URL =
  process.env.DHAN_INSTRUMENT_CSV || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

// ----------------- Instrument Master (lot sizes, security ids) -----------------

const instrumentCache = {
  rows: null,
  loadedAt: 0,
  ttlMs: 6 * 60 * 60 * 1000,
};

async function loadInstrumentMaster({ force = false } = {}) {
  if (!force && instrumentCache.rows && Date.now() - instrumentCache.loadedAt < instrumentCache.ttlMs) {
    return instrumentCache.rows;
  }
  const response = await axios.get(INSTRUMENT_CSV_URL, { timeout: 60000, responseType: 'text' });
  const text = String(response.data || '');
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error('Empty instrument master CSV');
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = (cols[c] || '').trim();
    }
    rows.push(obj);
  }
  instrumentCache.rows = rows;
  instrumentCache.loadedAt = Date.now();
  return rows;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return null;
}

async function getCurrentLotSize(underlying) {
  const upper = String(underlying || '').toUpperCase();
  try {
    const rows = await loadInstrumentMaster();
    const today = new Date().toISOString().slice(0, 10);
    // Find current futures / options contracts for the underlying.
    const candidates = rows.filter((r) => {
      const instr = (pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '').toUpperCase();
      const ulName = (pickField(r, ['UNDERLYING_SYMBOL', 'SEM_TRADING_SYMBOL', 'SYMBOL_NAME']) || '').toUpperCase();
      if (!(instr === 'FUTIDX' || instr === 'FUTSTK' || instr === 'OPTIDX')) return false;
      // Match strictly by underlying symbol so NIFTY does not accidentally pick up MIDCPNIFTY etc.
      if (instr === 'FUTIDX' || instr === 'FUTSTK') return ulName === upper;
      // For OPTIDX the trading symbol starts with the underlying followed by a separator.
      return ulName === upper || ulName.startsWith(`${upper}-`) || ulName.startsWith(`${upper} `);
    });
    // Prefer the nearest expiry >= today.
    const withExpiry = candidates
      .map((r) => ({
        row: r,
        expiry: pickField(r, ['SEM_EXPIRY_DATE', 'EXPIRY_DATE', 'ExpiryDate']) || '',
        lotSize: Number(pickField(r, ['LOT_SIZE', 'SEM_LOT_UNITS', 'LotSize'])),
      }))
      .filter((c) => Number.isFinite(c.lotSize) && c.lotSize > 0);
    const future = withExpiry.filter((c) => c.expiry && c.expiry.slice(0, 10) >= today);
    const past = withExpiry.filter((c) => !future.includes(c));
    const sortedFuture = future.sort((a, b) => a.expiry.localeCompare(b.expiry));
    const sortedPast = past.sort((a, b) => b.expiry.localeCompare(a.expiry));
    const best = sortedFuture[0] || sortedPast[0];
    if (best) return best.lotSize;
  } catch {
    // ignore and fall back below
  }
  // Sensible 2025+ SEBI defaults if master file is unavailable.
  if (upper === 'NIFTY') return 65;
  if (upper === 'BANKNIFTY') return 30;
  return 1;
}

// ----------------- Option Chain -----------------

async function fetchExpiryList(symbol) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for option chain');
  }
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const body = {
    UnderlyingScrip: Number(resolved.securityId),
    UnderlyingSeg: resolved.exchangeSegment,
  };
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(`${DHAN_BASE}/optionchain/expirylist`, body, { headers, timeout: 20000 });
    const list = resp.data?.data || [];
    return Array.isArray(list) ? list : [];
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken('optionchain-expiry');
      const retry = await axios.post(
        `${DHAN_BASE}/optionchain/expirylist`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: 20000 }
      );
      const list = retry.data?.data || [];
      return Array.isArray(list) ? list : [];
    }
    throw error;
  }
}

const OPTION_CHAIN_MIN_INTERVAL_MS = 6000;
const OPTION_CHAIN_STALE_MAX_AGE_MS = 3 * 60 * 1000;
const OPTION_CHAIN_429_COOLDOWN_MS = 90 * 1000;
const optionChainCache = new Map();
const optionChainInflight = new Map();
let optionChainRateLimitedUntil = 0;

function isHttpRateLimitError(error) {
  const status = Number(error?.response?.status);
  if (status === 429) return true;
  const msg = String(error?.message || error?.response?.data?.errorMessage || '');
  return msg.includes('429') || /rate\s*limit/i.test(msg);
}

async function fetchOptionChain({ symbol, expiry }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for option chain');
  }
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const body = {
    UnderlyingScrip: Number(resolved.securityId),
    UnderlyingSeg: resolved.exchangeSegment,
    Expiry: String(expiry),
  };
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(`${DHAN_BASE}/optionchain`, body, { headers, timeout: 20000 });
    return resp.data?.data || {};
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken('optionchain-data');
      const retry = await axios.post(
        `${DHAN_BASE}/optionchain`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: 20000 }
      );
      return retry.data?.data || {};
    }
    throw error;
  }
}

/** Dhan option chain is heavily rate-limited — coalesce callers and reuse stale data on 429. */
async function fetchOptionChainCached({ symbol, expiry, allowStale = true } = {}) {
  const key = `${String(symbol).toUpperCase()}|${String(expiry)}`;
  const now = Date.now();
  const cached = optionChainCache.get(key);

  if (optionChainRateLimitedUntil && now < optionChainRateLimitedUntil) {
    if (cached && allowStale) return cached.data;
    const waitSec = Math.ceil((optionChainRateLimitedUntil - now) / 1000);
    throw new Error(`Dhan option chain rate limited — retry in ~${waitSec}s`);
  }

  if (cached && now - cached.at < OPTION_CHAIN_MIN_INTERVAL_MS) {
    return cached.data;
  }

  if (optionChainInflight.has(key)) {
    return optionChainInflight.get(key);
  }

  const task = (async () => {
    try {
      const data = await fetchOptionChain({ symbol, expiry });
      optionChainCache.set(key, { at: Date.now(), data });
      return data;
    } catch (error) {
      if (isHttpRateLimitError(error)) {
        optionChainRateLimitedUntil = Date.now() + OPTION_CHAIN_429_COOLDOWN_MS;
        if (cached && allowStale && now - cached.at < OPTION_CHAIN_STALE_MAX_AGE_MS) {
          return cached.data;
        }
      }
      throw error;
    } finally {
      optionChainInflight.delete(key);
    }
  })();

  optionChainInflight.set(key, task);
  return task;
}

function getOptionChainRateLimitStatus() {
  const now = Date.now();
  return {
    coolingDown: Boolean(optionChainRateLimitedUntil && now < optionChainRateLimitedUntil),
    until: optionChainRateLimitedUntil || null,
  };
}

async function getNearestWeeklyExpiry(symbol) {
  const list = await fetchExpiryList(symbol);
  if (list.length === 0) return null;
  // Dhan returns expiries as YYYY-MM-DD strings; sort ascending and pick first future expiry.
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...list].sort();
  for (const expiry of sorted) {
    if (expiry >= today) return expiry;
  }
  return sorted[sorted.length - 1];
}

/**
 * Last expiry date (YYYY-MM-DD) still blocked for new entries on `dateKey`.
 *
 * When tradingDaysAhead=1, this matches the old behavior: "skip expiry day + 1 day before"
 * using trading-day aware counting.
 */
function getNearExpiryCutoffDateKey(dateKey, tradingDaysAhead = 1) {
  const base = String(dateKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    return new Date().toISOString().slice(0, 10);
  }

  let cursor = parseDateOnly(base);
  if (Number.isNaN(cursor.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  // Move forward day-by-day and count only cash trading days.
  const target = Math.max(0, Number(tradingDaysAhead) || 0);
  let remaining = target;
  // Worst case: keep it bounded even if the holiday cache is stale.
  for (let guard = 0; guard < 60 && remaining > 0; guard += 1) {
    cursor = addDays(cursor, 1);
    const key = formatDateOnly(cursor);
    if (isNseCashTradingDay(key)) {
      remaining -= 1;
      if (remaining <= 0) return key;
    }
  }

  return formatDateOnly(cursor);
}

/** True when weekly expiry is within `tradingDaysAhead` (IST) — use next expiry for new trades. */
function isExpiryTooSoonForNewEntry(expiry, dateKey, tradingDaysAhead = 1) {
  const e = String(expiry || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return true;
  return e <= getNearExpiryCutoffDateKey(dateKey, tradingDaysAhead);
}

async function getTradableWeeklyExpiry(symbol, dateKey, tradingDaysAhead = 1) {
  // Ensure holiday cache is ready so trading-day aware cutoff works correctly.
  await ensureNseHolidaysLoaded();

  const list = await fetchExpiryList(symbol);
  if (list.length === 0) return null;
  const today = String(dateKey || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const cutoff = getNearExpiryCutoffDateKey(today, tradingDaysAhead);
  const sorted = [...list].sort();
  for (const expiry of sorted) {
    const e = String(expiry).slice(0, 10);
    if (e > cutoff) return e;
  }
  for (const expiry of sorted) {
    if (String(expiry).slice(0, 10) >= today) return String(expiry).slice(0, 10);
  }
  return String(sorted[sorted.length - 1]).slice(0, 10);
}

function pickLegHighMark(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const candidates = [
    Number(leg.last_price),
    Number(leg.top_ask_price),
    Number(leg.top_bid_price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function pickLegLowMark(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const candidates = [
    Number(leg.last_price),
    Number(leg.top_bid_price),
    Number(leg.top_ask_price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** Best-effort LTP from chain leg (last traded, else bid/ask mid). */
function pickLegLtp(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const last = Number(leg.last_price);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = Number(leg.top_bid_price);
  const ask = Number(leg.top_ask_price);
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    return Number(((bid + ask) / 2).toFixed(2));
  }
  if (Number.isFinite(ask) && ask > 0) return ask;
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function findStrikeRow(strikes, strike) {
  const target = Number(strike);
  if (!Number.isFinite(target)) return null;
  const keys = Object.keys(strikes || {});
  let bestKey = null;
  let bestDiff = Infinity;
  for (const k of keys) {
    const diff = Math.abs(Number(k) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = k;
    }
  }
  if (bestKey == null || bestDiff > 1) return null;
  return strikes[bestKey];
}

async function getAtmPremiums({ symbol, strike, expiry }) {
  const chain = await fetchOptionChainCached({ symbol, expiry });
  const spot = Number(chain.last_price);
  const strikes = chain.oc || {};
  const row = findStrikeRow(strikes, strike);
  if (!row) {
    return {
      spot,
      ceLtp: null,
      peLtp: null,
      ceMarkHigh: null,
      ceMarkLow: null,
      peMarkHigh: null,
      peMarkLow: null,
      chainSpot: spot,
    };
  }
  const ce = row.ce || {};
  const pe = row.pe || {};
  const ceLast = pickLegLtp(ce);
  const peLast = pickLegLtp(pe);
  return {
    spot,
    ceLtp: ceLast,
    peLtp: peLast,
    ceMarkHigh: pickLegHighMark(ce),
    ceMarkLow: pickLegLowMark(ce),
    peMarkHigh: pickLegHighMark(pe),
    peMarkLow: pickLegLowMark(pe),
    chainSpot: spot,
  };
}

function parseMarginFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const directCandidates = [
    payload.totalMargin,
    payload.marginRequired,
    payload.margin,
    payload.requiredMargin,
    payload.blockedMargin,
  ]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (directCandidates.length > 0) return Math.max(...directCandidates);

  const nestedKeys = ['data', 'result', 'summary'];
  for (const key of nestedKeys) {
    const nested = payload[key];
    if (nested && typeof nested === 'object') {
      const n = parseMarginFromPayload(nested);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  const listKeys = ['scripList', 'scripts', 'orders', 'orderMargins', 'items'];
  for (const key of listKeys) {
    const arr = payload[key];
    if (!Array.isArray(arr)) continue;
    const sum = arr.reduce((acc, row) => {
      const n = parseMarginFromPayload(row);
      return acc + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
    if (sum > 0) return sum;
  }
  return null;
}

async function postWithAuthRetry(path, body, authContext) {
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  try {
    return await axios.post(`${DHAN_BASE}${path}`, body, { headers, timeout: 20000 });
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken(authContext);
      return axios.post(`${DHAN_BASE}${path}`, body, {
        headers: { ...headers, 'access-token': renewed },
        timeout: 20000,
      });
    }
    throw error;
  }
}

/**
 * Calculate short straddle margin from Dhan margin calculator API (multi-leg / straddle).
 * Uses MARGIN (NRML) by default for overnight holds; pass INTRADAY for same-day strategies.
 * @returns {{ margin: number, source: 'dhan_multi' }}
 */
async function estimateShortStraddleMargin({
  symbol,
  expiry,
  strike,
  lotSize,
  lots = 1,
  cePrice,
  pePrice,
  productType = 'MARGIN',
}) {
  const resolved = resolveSymbolConfig(symbol);
  const clientId = getDhanClientId();
  if (!clientId) throw new Error('Missing dhanClientId');
  const qty = Math.max(1, Number(lotSize) || 1) * Math.max(1, Number(lots) || 1);
  const ceInstrument = await resolveOptionInstrument({
    symbol,
    strike,
    expiry,
    optionType: 'CE',
  });
  const peInstrument = await resolveOptionInstrument({
    symbol,
    strike,
    expiry,
    optionType: 'PE',
  });
  const segment = ceInstrument.exchangeSegment || resolved.exchangeSegment || 'NSE_FNO';
  const safeProductType = String(productType || 'MARGIN').toUpperCase() === 'INTRADAY' ? 'INTRADAY' : 'MARGIN';
  const mkOrder = (securityId, price) => ({
    exchangeSegment: segment,
    transactionType: 'SELL',
    quantity: qty,
    productType: safeProductType,
    securityId: String(securityId),
    price: Number.isFinite(Number(price)) ? Number(price) : 0,
    triggerPrice: 0,
  });

  const multiBody = {
    includePosition: false,
    includeOrder: false,
    dhanClientId: clientId,
    scripList: [
      mkOrder(ceInstrument.securityId, cePrice),
      mkOrder(peInstrument.securityId, pePrice),
    ],
  };

  const resp = await postWithAuthRetry('/margincalculator/multi', multiBody, 'margin-calc-multi');
  const margin = parseMarginFromPayload(resp.data);
  if (Number.isFinite(margin) && margin > 0) {
    return { margin: Number(margin.toFixed(2)), source: 'dhan_multi' };
  }
  throw new Error('Margin calculator multi response missing margin values');
}

// ----------------- WebSocket (Live Index Ticker) -----------------

const wsState = {
  ws: null,
  subscribers: new Map(),
  lastPrices: new Map(),
  connecting: false,
  reconnectAttempts: 0,
  intentionalClose: false,
  reconnectTimer: null,
  rateLimitedUntil: 0,
  lastErrorWasRateLimit: false,
};

function packInstrumentSubscription({ securityId, exchangeSegmentCode }) {
  // RequestCode 15 = Ticker packet; Message format per Dhan WS v2:
  // 1 byte feedRequestCode + 1 byte instrumentCount(=1) + 1 byte exchange + 20 bytes securityId
  const buf = Buffer.alloc(23);
  buf.writeUInt8(15, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt8(exchangeSegmentCode, 2);
  buf.write(String(securityId), 3, 20, 'utf8');
  return buf;
}

function exchangeSegmentToCode(seg) {
  // Per Dhan Marketfeed protocol:
  switch (String(seg || '').toUpperCase()) {
    case 'IDX_I':
      return 0;
    case 'NSE_EQ':
      return 1;
    case 'NSE_FNO':
      return 2;
    case 'NSE_CURRENCY':
      return 3;
    case 'BSE_EQ':
      return 4;
    case 'MCX_COMM':
      return 5;
    case 'BSE_CURRENCY':
      return 7;
    case 'BSE_FNO':
      return 8;
    default:
      return 0;
  }
}

function normalizeExchangeSegment(row) {
  const exch = String(pickField(row, ['EXCH_ID', 'EXCHANGE']) || '').toUpperCase();
  const segment = String(pickField(row, ['SEGMENT', 'EXCHANGE_SEGMENT']) || '').toUpperCase();
  if (exch === 'NSE' && segment === 'D') return 'NSE_FNO';
  if (exch === 'BSE' && segment === 'D') return 'BSE_FNO';
  if (exch === 'NSE' && segment === 'E') return 'NSE_EQ';
  if (exch === 'BSE' && segment === 'E') return 'BSE_EQ';
  return segment || exch;
}

async function resolveOptionInstrument({ symbol, strike, expiry, optionType }) {
  const upperSymbol = String(symbol || '').toUpperCase();
  const normalizedExpiry = String(expiry || '').slice(0, 10);
  const normalizedType = String(optionType || '').toUpperCase();
  const targetStrike = Number(strike);
  if (!upperSymbol || !normalizedExpiry || !Number.isFinite(targetStrike) || !normalizedType) {
    throw new Error('Missing option instrument inputs');
  }

  const rows = await loadInstrumentMaster();
  const match = rows.find((r) => {
    const instrument = String(pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE']) || '').toUpperCase();
    const underlying = String(pickField(r, ['UNDERLYING_SYMBOL', 'SYMBOL_NAME']) || '').toUpperCase();
    const rowExpiry = String(pickField(r, ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE']) || '').slice(0, 10);
    const rowStrike = Number(pickField(r, ['STRIKE_PRICE', 'STRIKE']));
    const rowType = String(pickField(r, ['OPTION_TYPE', 'OPT_TYPE']) || '').toUpperCase();
    return instrument === 'OPTIDX'
      && underlying === upperSymbol
      && rowExpiry === normalizedExpiry
      && Math.abs(rowStrike - targetStrike) < 0.5
      && rowType === normalizedType;
  });
  if (!match) {
    throw new Error(`Option instrument not found: ${upperSymbol} ${normalizedExpiry} ${targetStrike} ${normalizedType}`);
  }

  return {
    securityId: String(pickField(match, ['SECURITY_ID', 'SEM_SMST_SECURITY_ID'])),
    exchangeSegment: normalizeExchangeSegment(match),
    tradingSymbol: pickField(match, ['SYMBOL_NAME', 'DISPLAY_NAME']) || '',
  };
}

function decodeTickerPacket(buffer) {
  // Header (8 bytes) + Ticker payload: LTP (4 byte float) + LTT (4 byte int)
  if (buffer.length < 16) return null;
  const responseCode = buffer.readUInt8(0);
  if (responseCode !== 2) return null;
  const exchangeSegmentCode = buffer.readUInt8(3);
  const securityId = String(buffer.readInt32LE(4));
  const ltp = buffer.readFloatLE(8);
  const ltt = buffer.readInt32LE(12);
  return { ltp, ltt, responseCode, exchangeSegmentCode, securityId };
}

function ensureWsConnection() {
  const now = Date.now();
  if (wsState.rateLimitedUntil && now < wsState.rateLimitedUntil) {
    return null;
  }
  if (wsState.ws && (wsState.ws.readyState === WebSocket.OPEN || wsState.ws.readyState === WebSocket.CONNECTING)) {
    return wsState.ws;
  }
  if (wsState.connecting) return null;

  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) {
    console.warn('[DhanLive] WS skipped — missing credentials');
    return null;
  }

  wsState.connecting = true;
  wsState.intentionalClose = false;
  const url = `${DHAN_WS_URL}?version=2&token=${accessToken}&clientId=${clientId}&authType=2`;
  const ws = new WebSocket(url);
  wsState.ws = ws;

  ws.on('open', () => {
    console.log('[DhanLive] WS connected');
    wsState.connecting = false;
    wsState.reconnectAttempts = 0;
    wsState.rateLimitedUntil = 0;
    wsState.lastErrorWasRateLimit = false;
    for (const sub of wsState.subscribers.values()) {
      try {
        ws.send(packInstrumentSubscription(sub));
      } catch (err) {
        console.error('[DhanLive] WS resub failed:', err.message);
      }
    }
  });

  ws.on('message', (data) => {
    if (!(data instanceof Buffer)) return;
    const decoded = decodeTickerPacket(data);
    if (!decoded || !Number.isFinite(decoded.ltp) || decoded.ltp <= 0) return;
    for (const [key, sub] of wsState.subscribers.entries()) {
      if (
        String(sub.securityId) !== decoded.securityId
        || Number(sub.exchangeSegmentCode) !== Number(decoded.exchangeSegmentCode)
      ) {
        continue;
      }
      wsState.lastPrices.set(key, { ltp: decoded.ltp, ts: Date.now() });
      if (typeof sub.onTick === 'function') {
        try {
          sub.onTick({ ltp: decoded.ltp, ltt: decoded.ltt });
        } catch (err) {
          console.error('[DhanLive] tick handler error:', err.message);
        }
      }
    }
  });

  ws.on('error', (err) => {
    const message = String(err?.message || err);
    wsState.lastErrorWasRateLimit = message.includes('429');
    if (wsState.lastErrorWasRateLimit) {
      wsState.rateLimitedUntil = Date.now() + 2 * 60 * 1000;
      console.error('[DhanLive] WS rate-limited (429). Cooling down reconnects for 2 minutes.');
      return;
    }
    console.error('[DhanLive] WS error:', message);
  });

  ws.on('close', (code) => {
    console.log('[DhanLive] WS closed', code);
    wsState.ws = null;
    wsState.connecting = false;
    if (wsState.intentionalClose) return;
    if (wsState.subscribers.size === 0) return;
    wsState.reconnectAttempts = Math.min(10, wsState.reconnectAttempts + 1);
    const rateLimitBackoff = Math.max(0, wsState.rateLimitedUntil - Date.now());
    const normalBackoff = Math.min(120000, 1000 * 2 ** wsState.reconnectAttempts);
    const backoff = wsState.lastErrorWasRateLimit ? Math.max(rateLimitBackoff, 120000) : normalBackoff;
    if (wsState.reconnectTimer) clearTimeout(wsState.reconnectTimer);
    wsState.reconnectTimer = setTimeout(() => {
      wsState.reconnectTimer = null;
      ensureWsConnection();
    }, backoff);
  });

  return ws;
}

function subscribeLiveSymbol({ key, symbol, onTick }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for live subscription');
  }
  wsState.subscribers.set(key, {
    securityId: resolved.securityId,
    exchangeSegmentCode: exchangeSegmentToCode(resolved.exchangeSegment),
    onTick,
  });
  if (wsState.rateLimitedUntil && Date.now() < wsState.rateLimitedUntil) {
    return;
  }
  const ws = ensureWsConnection();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(packInstrumentSubscription({
        securityId: resolved.securityId,
        exchangeSegmentCode: exchangeSegmentToCode(resolved.exchangeSegment),
      }));
    } catch (err) {
      console.error('[DhanLive] WS sub failed:', err.message);
    }
  }
}

function subscribeLiveInstrument({ key, securityId, exchangeSegment, onTick }) {
  const exchangeSegmentCode = exchangeSegmentToCode(exchangeSegment);
  wsState.subscribers.set(key, {
    securityId: String(securityId),
    exchangeSegmentCode,
    onTick,
  });
  if (wsState.rateLimitedUntil && Date.now() < wsState.rateLimitedUntil) {
    return;
  }
  const ws = ensureWsConnection();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(packInstrumentSubscription({
        securityId: String(securityId),
        exchangeSegmentCode,
      }));
    } catch (err) {
      console.error('[DhanLive] WS sub failed:', err.message);
    }
  }
}

function unsubscribeLiveSymbol(key) {
  wsState.subscribers.delete(key);
  wsState.lastPrices.delete(key);
  if (wsState.subscribers.size === 0 && wsState.ws) {
    wsState.intentionalClose = true;
    try {
      wsState.ws.close();
    } catch {
      // ignore
    }
    wsState.ws = null;
  }
}

function getLastPrice(key) {
  return wsState.lastPrices.get(key) || null;
}

module.exports = {
  loadInstrumentMaster,
  getCurrentLotSize,
  fetchExpiryList,
  fetchOptionChain,
  getNearestWeeklyExpiry,
  getTradableWeeklyExpiry,
  getNearExpiryCutoffDateKey,
  isExpiryTooSoonForNewEntry,
  getAtmPremiums,
  resolveOptionInstrument,
  estimateShortStraddleMargin,
  subscribeLiveInstrument,
  subscribeLiveSymbol,
  unsubscribeLiveSymbol,
  getLastPrice,
  getOptionChainRateLimitStatus,
};

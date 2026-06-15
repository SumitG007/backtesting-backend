const { CACHE_TTL_MS } = require('../config/constants');
const {
  postDhanHistorical,
  buildDhanHistoricalBody,
  buildDhanHistoricalBodyWithExpiryCode,
  isDh905Error,
  fetchIntradayDayStats,
} = require('./dhanDataService');
const { ensureNseHolidaysLoaded, isNseCashTradingDay } = require('./nseHolidayService');
const { listFutureExpiries, resolveFutureInstrument } = require('./dhanLiveService');
const { resolveSymbolConfig } = require('../utils/market');
const {
  searchInstruments,
  getFeaturedInstruments,
  getInstrumentEntry,
  resolveCashFromCatalog,
  getCatalogMeta,
  listSymbolsByProduct,
  listAllSymbolsByProduct,
  parseSymbolFilter,
} = require('./volumeInstrumentCatalog');
const {
  loadMetricsMap,
  upsertMetricRow,
  getLatestBatchUpdatedAt,
  countMetrics,
  syncVolumeMetricsIndexes,
} = require('./volumeMetricsStore');
const {
  getIstClock,
  normalizeTimestamp,
  parseDateOnly,
  formatDateOnly,
  addDays,
} = require('../utils/dateTime');

const LOOKBACK_PRESETS = {
  5: { id: 5, label: 'Last 5 trading days', tradingDays: 5, hint: 'Excludes weekends & NSE holidays' },
  10: { id: 10, label: 'Last 10 trading days', tradingDays: 10, hint: 'Excludes weekends & NSE holidays' },
  30: { id: 30, label: 'Last 30 trading days', tradingDays: 30, hint: 'Excludes weekends & NSE holidays' },
};

const DEFAULT_LOOKBACK_DAYS = 30;

const analysisCache = new Map();

function getActualTodayKey() {
  return getIstClock(new Date()).dateKey;
}

function resolveSessionDateKey(sessionDate) {
  const actualToday = getActualTodayKey();
  const key = sessionDate ? String(sessionDate).slice(0, 10) : actualToday;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error('Invalid session date — use YYYY-MM-DD');
  }
  if (key > actualToday) {
    throw new Error('Session date cannot be in the future');
  }
  return key;
}

function isHistoricalSession(sessionDateKey) {
  return sessionDateKey !== getActualTodayKey();
}

function parseDailyBars(raw) {
  const timestamps = raw.timestamp || [];
  const closes = raw.close || [];
  const volumes = raw.volume || [];
  const bars = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const ts = normalizeTimestamp(timestamps[i]);
    if (Number.isNaN(ts.getTime())) continue;
    const { dateKey } = getIstClock(ts);
    const volume = Number(volumes[i]);
    const close = Number(closes[i]);
    bars.push({
      dateKey,
      volume: Number.isFinite(volume) ? volume : 0,
      close: Number.isFinite(close) ? close : null,
    });
  }

  const byDate = new Map();
  for (const bar of bars) {
    byDate.set(bar.dateKey, bar);
  }
  return [...byDate.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

function average(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round2(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function formatExpiryLabel(expiry) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(expiry || '').slice(0, 10));
  if (!match) return expiry || '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(match[3])}-${months[Number(match[2]) - 1]}-${match[1]}`;
}

function formatIstDateLabel(dateKey, { isToday = false, isYesterday = false } = {}) {
  if (!dateKey) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
  if (isToday) return label;
  if (isYesterday) return `Yesterday · ${label}`;
  return label;
}

function isYesterdayDateKey(dateKey, todayKey) {
  const today = parseDateOnly(todayKey);
  const day = parseDateOnly(dateKey);
  if (Number.isNaN(today.getTime()) || Number.isNaN(day.getTime())) return false;
  const yesterday = formatDateOnly(addDays(today, -1));
  return dateKey === yesterday;
}

function buildCompareMetrics(todayBar, priorBars) {
  const todayVolume = todayBar?.volume ?? null;
  const avgVolume = average(priorBars.map((b) => b.volume));
  const ratio = avgVolume > 0 && Number.isFinite(todayVolume) ? todayVolume / avgVolume : null;
  const pctVsAvg = ratio != null ? round2((ratio - 1) * 100) : null;
  let signal = 'UNAVAILABLE';
  if (ratio != null) {
    if (ratio >= 1.35) signal = 'HIGH';
    else if (ratio >= 1.1) signal = 'ABOVE_AVERAGE';
    else if (ratio <= 0.75) signal = 'LOW';
    else if (ratio <= 0.9) signal = 'BELOW_AVERAGE';
    else signal = 'NEAR_AVERAGE';
  }
  return {
    todayVolume,
    avgVolume: avgVolume != null ? Math.round(avgVolume) : null,
    ratio: round2(ratio),
    pctVsAvg,
    signal,
    sampleDays: priorBars.length,
    requestedSampleDays: null,
  };
}

function buildDisplayTable(todayBar, priorBars, compare, todayKey) {
  const rows = [];
  const actualTodayKey = getActualTodayKey();

  rows.push({
    rowType: 'today',
    dateKey: todayKey,
    dayLabel: formatIstDateLabel(todayKey, { isToday: todayKey === actualTodayKey }),
    volume: todayBar.volume,
  });

  for (let i = priorBars.length - 1; i >= 0; i -= 1) {
    const bar = priorBars[i];
    rows.push({
      rowType: 'prior',
      dateKey: bar.dateKey,
      dayLabel: formatIstDateLabel(bar.dateKey, {
        isYesterday: isYesterdayDateKey(bar.dateKey, todayKey),
      }),
      volume: bar.volume,
    });
  }

  rows.push({
    rowType: 'average',
    dateKey: null,
    dayLabel: `Average of ${compare.sampleDays} day${compare.sampleDays === 1 ? '' : 's'} before today`,
    volume: compare.avgVolume,
  });

  return rows;
}

async function resolveAnalysisInstrument({ symbol, product, expiryDate }) {
  const upper = String(symbol || '').toUpperCase();
  const prod = String(product || 'cash').toLowerCase();

  if (prod === 'future') {
    const expiry = String(expiryDate || '').slice(0, 10);
    if (!expiry) throw new Error('Select a futures expiry date');
    const fut = await resolveFutureInstrument({ symbol: upper, expiry });
    return {
      symbol: fut.symbol,
      securityId: fut.securityId,
      exchangeSegment: fut.exchangeSegment,
      instrument: fut.instrument,
      product: 'future',
      expiry: fut.expiry,
      tradingSymbol: fut.tradingSymbol,
      displayName: `${fut.symbol} future · expiry ${formatExpiryLabel(fut.expiry)}`,
    };
  }

  return resolveCashFromCatalog(upper);
}

async function getUnderlyingSecurityIdForFno(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const cfg = resolveSymbolConfig(upper);
  if (cfg.securityId && cfg.exchangeSegment === 'IDX_I') {
    return { securityId: String(cfg.securityId) };
  }
  const entry = await getInstrumentEntry(upper);
  if (entry?.cashSecurityId) {
    return { securityId: entry.cashSecurityId };
  }
  if (cfg.securityId) {
    return { securityId: String(cfg.securityId) };
  }
  throw new Error(`No underlying security id for ${upper}`);
}

async function resolveFutureExpiryCode(symbol, expiry) {
  const expiries = await listFutureExpiries(symbol, { includePastDays: 0 });
  const idx = expiries.findIndex((e) => e.expiry === expiry);
  return idx >= 0 ? Math.min(idx, 2) : 0;
}

async function fetchDailyBars(resolved, calendarSpanDays, sessionDateKey) {
  const todayKey = sessionDateKey || getActualTodayKey();
  const fromDate = formatDateOnly(addDays(parseDateOnly(todayKey), -calendarSpanDays));
  const toDate = formatDateOnly(addDays(parseDateOnly(todayKey), 1));

  let raw;
  if (resolved.product === 'future') {
    const underlying = await getUnderlyingSecurityIdForFno(resolved.symbol);
    const expiryCode = await resolveFutureExpiryCode(resolved.symbol, resolved.expiry);
    const fnoBody = buildDhanHistoricalBodyWithExpiryCode({
      securityId: underlying.securityId,
      exchangeSegment: 'NSE_FNO',
      instrument: resolved.instrument,
      expiryCode,
      fromDate,
      toDate,
    });
    try {
      raw = await postDhanHistorical(fnoBody);
    } catch (fnoErr) {
      if (!isDh905Error(fnoErr)) {
        throw fnoErr;
      }
      const contractBody = buildDhanHistoricalBody({
        securityId: resolved.securityId,
        exchangeSegment: resolved.exchangeSegment,
        instrument: resolved.instrument,
        fromDate,
        toDate,
      });
      raw = await postDhanHistorical(contractBody);
    }
  } else {
    const cashBody = buildDhanHistoricalBody({
      securityId: resolved.securityId,
      exchangeSegment: resolved.exchangeSegment,
      instrument: resolved.instrument,
      fromDate,
      toDate,
    });
    raw = await postDhanHistorical(cashBody);
  }

  return {
    bars: parseDailyBars(raw),
    todayKey,
  };
}

/**
 * Dhan daily historical often omits the current session until EOD.
 * Use intraday sum for the IST calendar day instead of mislabeling yesterday as today.
 */
async function resolveTodayBar(bars, todayKey, resolved, { allowIntraday = true } = {}) {
  const fromDaily = bars.find((b) => b.dateKey === todayKey);
  if (fromDaily) {
    return { todayBar: fromDaily, partialToday: false };
  }

  if (!allowIntraday) {
    throw new Error(`No daily data for session ${todayKey}`);
  }

  await ensureNseHolidaysLoaded();
  if (isNseCashTradingDay(todayKey)) {
    try {
      const stats = await fetchIntradayDayStats({
        dateKey: todayKey,
        securityId: resolved.securityId,
        exchangeSegment: resolved.exchangeSegment,
        instrument: resolved.instrument,
      });
      return {
        todayBar: {
          dateKey: todayKey,
          volume: stats.volume,
          close: Number.isFinite(stats.lastClose) ? stats.lastClose : null,
        },
        partialToday: true,
      };
    } catch {
      return {
        todayBar: { dateKey: todayKey, volume: 0, close: null },
        partialToday: true,
      };
    }
  }

  const lastBar = bars[bars.length - 1];
  return { todayBar: lastBar, partialToday: false };
}

async function getFutureExpiriesForSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const entry = await getInstrumentEntry(upper);
  if (!entry?.future) {
    return { symbol: upper, expiries: [], futureSupported: false };
  }
  const expiries = await listFutureExpiries(upper, { includePastDays: 14 });
  return { symbol: upper, expiries, futureSupported: true };
}

async function runVolumeAnalysis({
  symbol,
  lookbackDays = 5,
  product = 'cash',
  expiryDate = null,
  sessionDate = null,
}) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[5];
  const tradingDays = preset.tradingDays;
  const sessionDateKey = resolveSessionDateKey(sessionDate);
  const resolved = await resolveAnalysisInstrument({ symbol, product, expiryDate });
  const { bars, todayKey } = await fetchDailyBars(resolved, tradingDays * 2 + 25, sessionDateKey);
  const cacheKey = `${resolved.symbol}:${resolved.product}:${resolved.expiry || ''}:${tradingDays}:${todayKey}`;
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return {
      ...cached.payload,
      fromCache: true,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
    };
  }

  if (!bars.length) {
    throw new Error(
      resolved.product === 'future'
        ? 'No daily data for this futures contract — it may be too new; try another expiry.'
        : 'No daily candles returned from Dhan for this symbol',
    );
  }

  const { todayBar, partialToday } = await resolveTodayBar(bars, todayKey, resolved, {
    allowIntraday: !isHistoricalSession(sessionDateKey),
  });
  const priorBars = bars.filter((b) => b.dateKey < todayKey).slice(-tradingDays);
  const compare = buildCompareMetrics(todayBar, priorBars);
  compare.requestedSampleDays = tradingDays;

  const lastPriorBar = priorBars[priorBars.length - 1];
  const prevDayClose = Number.isFinite(lastPriorBar?.close) ? round2(lastPriorBar.close) : null;
  const todayPrice = Number.isFinite(todayBar?.close) ? round2(todayBar.close) : null;
  const priceChangePct = prevDayClose > 0 && todayPrice != null
    ? round2(((todayPrice / prevDayClose) - 1) * 100)
    : null;

  const shortSample = priorBars.length < tradingDays;
  const tableRows = buildDisplayTable(todayBar, priorBars, compare, todayKey);
  const chartDays = [...priorBars, todayBar];
  const maxVolume = Math.max(...chartDays.map((b) => b.volume), compare.avgVolume || 0, 1);

  const payload = {
    symbol: resolved.symbol,
    product: resolved.product,
    expiry: resolved.expiry,
    tradingSymbol: resolved.tradingSymbol,
    instrumentLabel: resolved.displayName,
    instrument: resolved.instrument,
    exchangeSegment: resolved.exchangeSegment,
    lookback: preset,
    compare,
    summary: {
      headline: compare.ratio != null
        ? `Session volume (${todayKey}) is ${compare.ratio}× the average of the previous ${compare.sampleDays} trading day${compare.sampleDays === 1 ? '' : 's'} on this contract (${compare.pctVsAvg >= 0 ? '+' : ''}${compare.pctVsAvg}%).`
        : 'Not enough prior days on this contract to compute an average.',
      todayDate: todayKey,
      sessionDate: todayKey,
      partialToday,
      todayVolume: compare.todayVolume,
      averageVolume: compare.avgVolume,
      averageOfDays: compare.sampleDays,
      requestedDays: tradingDays,
      shortSample,
      prevDayClose,
      todayPrice,
      priceChangePct,
      prevDayDate: lastPriorBar?.dateKey || null,
    },
    tableRows,
    chart: {
      maxVolume,
      bars: chartDays.map((b) => ({
        dateKey: b.dateKey,
        volume: b.volume,
        isToday: b.dateKey === todayKey,
      })),
    },
    notes: resolved.product === 'future'
      ? [
        'Futures mode: volume is for the selected expiry contract only (e.g. HDFCBANK 03-Jun-2026), not the cash stock.',
        shortSample
          ? `Only ${priorBars.length} prior day(s) of data on this contract — average uses what is available (requested ${tradingDays}).`
          : null,
        'When the contract rolls, choose the new expiry from the list.',
      ].filter(Boolean)
      : ['Cash mode: daily volume on the NSE equity share.'],
    fromCache: false,
    fetchedAt: new Date().toISOString(),
  };

  analysisCache.set(cacheKey, { fetchedAt: Date.now(), payload });
  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SCAN_SYMBOL_DELAY_MS = 300;
const SCAN_CONCURRENCY = 4;
const TOP_SCAN_ROWS = 10;

function sortRowsByPctVsAvg(rows) {
  return [...rows].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    const ap = a.pctVsAvg;
    const bp = b.pctVsAvg;
    if (ap == null && bp == null) return a.symbol.localeCompare(b.symbol);
    if (ap == null) return 1;
    if (bp == null) return -1;
    if (bp !== ap) return bp - ap;
    return a.symbol.localeCompare(b.symbol);
  });
}

function isAboveAverageRow(row) {
  return row?.ok && row.pctVsAvg != null && Number(row.pctVsAvg) > 0;
}

function matchesScannerCriteria(row) {
  return isAboveAverageRow(row);
}

function shouldPersistVolumeRow(row) {
  return matchesScannerCriteria(row);
}

function filterScannerRows(rows) {
  return rows.filter(matchesScannerCriteria);
}

function pickTopScannerRows(rows, limit = TOP_SCAN_ROWS) {
  return filterScannerRows(sortRowsByPctVsAvg(rows)).slice(0, limit);
}

async function refreshSymbolsIntoStore({
  symbols = [],
  product,
  expiryDate = null,
  lookbackDays = 10,
  sessionDate = null,
  persist = true,
} = {}) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[10];
  const tradingDays = preset.tradingDays;
  const prod = String(product || 'future').toLowerCase() === 'future' ? 'future' : 'cash';
  const sessionDateKey = resolveSessionDateKey(sessionDate);
  const unique = [...new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map((s) => String(s || '').trim().toUpperCase())
      .filter(Boolean),
  )];

  const clock = getIstClock(new Date());
  const rows = [];
  let scanned = 0;
  let savedAboveAvg = 0;

  async function fetchOneSymbol(symbol) {
    try {
      return await analyzeSymbolRow({
        symbol,
        product: prod,
        expiryDate,
        tradingDays,
        clock,
        sessionDate: sessionDateKey,
      });
    } catch (err) {
      const entry = await getInstrumentEntry(symbol);
      return {
        ok: false,
        symbol,
        cashSupported: Boolean(entry?.cash) || Boolean(resolveSymbolConfig(symbol).securityId),
        futureSupported: Boolean(entry?.future),
        error: isRateLimitError(err) ? 'Rate limited — retry' : (err.message || 'Failed'),
      };
    }
  }

  for (let i = 0; i < unique.length; i += SCAN_CONCURRENCY) {
    const chunk = unique.slice(i, i + SCAN_CONCURRENCY);
    const chunkRows = await Promise.all(chunk.map((symbol) => fetchOneSymbol(symbol)));
    if (persist) {
      const toSave = chunkRows.filter((row) => shouldPersistVolumeRow(row));
      await Promise.all(toSave.map((row) => upsertMetricRow({
        product: prod,
        expiryDate,
        lookbackDays,
        sessionDate: sessionDateKey,
        row,
      })));
      savedAboveAvg += toSave.length;
    }
    rows.push(...chunkRows);
    scanned += chunkRows.length;
    if (i + SCAN_CONCURRENCY < unique.length) await sleep(SCAN_SYMBOL_DELAY_MS);
  }

  return {
    rows: sortRowsByPctVsAvg(rows.filter((row) => shouldPersistVolumeRow(row))),
    lookback: preset,
    todayDate: sessionDateKey,
    sessionDate: sessionDateKey,
    product: prod,
    expiryDate: prod === 'future' ? expiryDate : null,
    scanned,
    savedAboveAvg,
    skippedBelowAvg: scanned - savedAboveAvg,
    updated: savedAboveAvg,
    total: unique.length,
  };
}

function buildRowsFromMetrics(symbols, metricsMap) {
  return symbols.map((symbol) => {
    const row = metricsMap.get(symbol);
    if (row) return row;
    return {
      ok: false,
      symbol,
      error: 'Not in database — click Search to fetch',
      updatedAt: null,
    };
  });
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '');
  const code = err?.cause?.response?.data?.errorCode || err?.response?.data?.errorCode;
  return code === 'DH-904' || /rate limit|too many requests/i.test(msg);
}

async function runVolumeAnalysisWithRetry(args, maxAttempts = 4) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await runVolumeAnalysis(args);
    } catch (err) {
      lastErr = err;
      if (isRateLimitError(err) && attempt < maxAttempts - 1) {
        await sleep((attempt + 1) * 2500);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function buildBatchRow(result, clock, entryFlags = {}) {
  const priorRows = Array.isArray(result.tableRows)
    ? result.tableRows.filter((r) => r && r.rowType === 'prior')
    : [];

  return {
    ok: true,
    symbol: result.symbol,
    product: result.product,
    expiry: result.expiry || null,
    cashSupported: entryFlags.cashSupported,
    futureSupported: entryFlags.futureSupported,
    avgVolume: result.compare?.avgVolume ?? null,
    todayVolume: result.compare?.todayVolume ?? null,
    ratio: result.compare?.ratio ?? null,
    pctVsAvg: result.compare?.pctVsAvg ?? null,
    signal: result.compare?.signal ?? 'UNAVAILABLE',
    sampleDays: result.compare?.sampleDays ?? 0,
    todayDate: result.summary?.todayDate ?? clock.dateKey,
    partialToday: Boolean(result.summary?.partialToday),
    priorDays: priorRows.map((r) => ({
      dateKey: r.dateKey,
      dayLabel: r.dayLabel,
      volume: r.volume,
    })),
    prevDayClose: result.summary?.prevDayClose ?? null,
    todayPrice: result.summary?.todayPrice ?? null,
    priceChangePct: result.summary?.priceChangePct ?? null,
    prevDayDate: result.summary?.prevDayDate ?? null,
  };
}

async function analyzeSymbolRow({
  symbol,
  product,
  expiryDate,
  tradingDays,
  clock,
  sessionDate = null,
}) {
  const entry = await getInstrumentEntry(symbol);
  const futureSupported = Boolean(entry?.future);
  const cashSupported = Boolean(entry?.cash) || Boolean(resolveSymbolConfig(symbol).securityId);
  const flags = { cashSupported, futureSupported };

  if (product === 'future' && !futureSupported) {
    throw new Error('No futures for this symbol');
  }
  if (product === 'cash' && !cashSupported) {
    throw new Error('No cash listing for this symbol');
  }

  const result = await runVolumeAnalysisWithRetry({
    symbol,
    lookbackDays: tradingDays,
    product,
    expiryDate,
    sessionDate,
  });
  return buildBatchRow(result, clock, flags);
}

async function loadSavedVolumeRows({
  product,
  expiryDate,
  lookbackDays,
  sessionDateKey,
} = {}) {
  const metricsMap = await loadMetricsMap({
    product,
    expiryDate,
    lookbackDays,
    sessionDate: sessionDateKey,
  });
  return sortRowsByPctVsAvg([...metricsMap.values()].filter((row) => shouldPersistVolumeRow(row)));
}

async function ensureMetricsForSymbols({
  symbols = [],
  product,
  expiryDate,
  lookbackDays,
  sessionDateKey,
  fetchMissing = true,
} = {}) {
  let metricsMap = await loadMetricsMap({
    product,
    expiryDate,
    lookbackDays,
    sessionDate: sessionDateKey,
  });

  const missing = symbols.filter((sym) => !metricsMap.has(sym));
  let scannedLive = 0;
  let savedAboveAvg = 0;

  if (fetchMissing && missing.length > 0) {
    const refreshResult = await refreshSymbolsIntoStore({
      symbols: missing,
      product,
      expiryDate,
      lookbackDays,
      sessionDate: sessionDateKey,
      persist: true,
    });
    scannedLive = refreshResult.scanned;
    savedAboveAvg = refreshResult.savedAboveAvg;
    metricsMap = await loadMetricsMap({
      product,
      expiryDate,
      lookbackDays,
      sessionDate: sessionDateKey,
    });
  }

  return {
    metricsMap,
    scannedLive,
    savedAboveAvg,
    cachedCount: metricsMap.size,
    pendingScanCount: missing.length,
  };
}

async function runVolumeAnalysisScan({
  product = 'future',
  lookbackDays = 10,
  expiryDate = null,
  sessionDate = null,
  q = '',
  cacheOnly = false,
} = {}) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[DEFAULT_LOOKBACK_DAYS];
  const prod = String(product || 'future').toLowerCase() === 'future' ? 'future' : 'cash';
  const query = String(q || '').trim();
  const sessionDateKey = resolveSessionDateKey(sessionDate);
  const dbOnly = Boolean(cacheOnly);

  if (prod === 'future' && !expiryDate) {
    throw new Error('Select a futures expiry');
  }

  await ensureNseHolidaysLoaded();
  if (!dbOnly && !isNseCashTradingDay(sessionDateKey)) {
    throw new Error(`${sessionDateKey} is not an NSE trading session`);
  }

  const listing = await listAllSymbolsByProduct({ product: prod, q: query });
  const symbols = listing.symbols;

  const {
    scannedLive,
    savedAboveAvg,
    cachedCount,
    pendingScanCount,
  } = await ensureMetricsForSymbols({
    symbols,
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDateKey,
    fetchMissing: !dbOnly,
  });

  const allRows = await loadSavedVolumeRows({
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDateKey,
  });
  const total = allRows.length;

  const latestUpdatedAt = await getLatestBatchUpdatedAt({
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDate: sessionDateKey,
  });
  const dbCount = await countMetrics({
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDate: sessionDateKey,
  });

  let hint = null;
  if (dbOnly && cachedCount === 0) {
    hint = 'No volume-above-average stocks saved for this session yet. Click Fetch live to scan from Dhan.';
  } else if (dbOnly && cachedCount > 0) {
    hint = `${cachedCount} stocks with volume above average (saved in database). Click Fetch live to scan for more.`;
  } else if (scannedLive > 0) {
    hint = `Scanned ${scannedLive} symbols from Dhan — saved ${savedAboveAvg} with volume above average (${scannedLive - savedAboveAvg} below avg not stored).`;
  } else if (cachedCount > 0) {
    hint = `${cachedCount} stocks with volume above average from database.`;
  }

  return {
    rows: allRows,
    lookback: preset,
    todayDate: sessionDateKey,
    sessionDate: sessionDateKey,
    product: prod,
    expiryDate: prod === 'future' ? expiryDate : null,
    sortedBy: 'pctVsAvg',
    showAll: true,
    aboveAverageOnly: true,
    cacheOnly: dbOnly,
    source: dbOnly ? 'mongodb' : (scannedLive > 0 ? 'mongodb+live' : 'mongodb'),
    fromCache: scannedLive === 0,
    scannedLive,
    savedAboveAvg,
    fetchedLive: savedAboveAvg,
    cachedCount,
    pendingScanCount,
    hint,
    dbCount,
    universeTotal: listing.total,
    total,
    query,
    fetchedAt: latestUpdatedAt ? latestUpdatedAt.toISOString() : null,
  };
}

async function runVolumeAnalysisBatch({
  symbols = [],
  lookbackDays = 10,
  product = 'cash',
  expiryDate = null,
  sessionDate = null,
}) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[10];
  const sessionDateKey = resolveSessionDateKey(sessionDate);
  const unique = [...new Set(
    (Array.isArray(symbols) ? symbols : [symbols])
      .map((s) => String(s || '').trim().toUpperCase())
      .filter(Boolean),
  )].slice(0, 40);

  if (!unique.length) {
    throw new Error('Add at least one symbol to the watchlist');
  }

  const clock = getIstClock(new Date());
  const rows = [];

  for (let i = 0; i < unique.length; i += 1) {
    const symbol = unique[i];
    try {
      rows.push(await analyzeSymbolRow({
        symbol,
        product,
        expiryDate,
        tradingDays: preset.tradingDays,
        clock,
        sessionDate: sessionDateKey,
      }));
    } catch (err) {
      const entry = await getInstrumentEntry(symbol);
      rows.push({
        ok: false,
        symbol,
        cashSupported: Boolean(entry?.cash) || Boolean(resolveSymbolConfig(symbol).securityId),
        futureSupported: Boolean(entry?.future),
        error: err.message || 'Failed',
      });
    }
    if (i < unique.length - 1) await sleep(SCAN_SYMBOL_DELAY_MS);
  }

  return {
    rows,
    lookback: preset,
    todayDate: sessionDateKey,
    sessionDate: sessionDateKey,
    product,
    fetchedAt: new Date().toISOString(),
  };
}

async function runVolumeAnalysisExport({
  product = 'future',
  lookbackDays = 10,
  expiryDate = null,
  sessionDate = null,
} = {}) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[DEFAULT_LOOKBACK_DAYS];
  const prod = String(product || 'future').toLowerCase() === 'future' ? 'future' : 'cash';
  const sessionDateKey = resolveSessionDateKey(sessionDate);

  if (prod === 'future' && !expiryDate) {
    throw new Error('Select a futures expiry');
  }

  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(sessionDateKey)) {
    throw new Error(`${sessionDateKey} is not an NSE trading session`);
  }

  const listing = await listAllSymbolsByProduct({ product: prod, q: '' });
  const symbols = listing.symbols;

  await ensureMetricsForSymbols({
    symbols,
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDateKey,
    fetchMissing: true,
  });

  const rows = await loadSavedVolumeRows({
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDateKey,
  });
  const latestUpdatedAt = await getLatestBatchUpdatedAt({
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDate: sessionDateKey,
  });
  const dbCount = await countMetrics({
    product: prod,
    expiryDate,
    lookbackDays,
    sessionDate: sessionDateKey,
  });

  return {
    rows,
    lookback: preset,
    todayDate: sessionDateKey,
    sessionDate: sessionDateKey,
    product: prod,
    expiryDate: prod === 'future' ? expiryDate : null,
    sortedBy: 'pctVsAvg',
    exportAll: true,
    aboveAverageOnly: true,
    source: 'mongodb',
    dbCount,
    universeTotal: listing.total,
    total: rows.length,
    fetchedAt: latestUpdatedAt ? latestUpdatedAt.toISOString() : null,
  };
}

async function getVolumeAnalysisMeta() {
  const catalog = await getCatalogMeta();
  const featured = await getFeaturedInstruments();
  return {
    catalog,
    featured,
    lookbackPresets: Object.values(LOOKBACK_PRESETS),
    products: [
      { id: 'future', label: 'Futures', hint: 'NSE futures volume by expiry' },
    ],
    module: 'volume-analysis',
    description: 'Search futures volume by session date. Results are cached in the database per session.',
  };
}

module.exports = {
  LOOKBACK_PRESETS,
  DEFAULT_LOOKBACK_DAYS,
  TOP_SCAN_ROWS,
  pickTopScannerRows,
  matchesScannerCriteria,
  resolveSessionDateKey,
  getActualTodayKey,
  isHistoricalSession,
  runVolumeAnalysis,
  runVolumeAnalysisBatch,
  runVolumeAnalysisScan,
  runVolumeAnalysisExport,
  refreshSymbolsIntoStore,
  ensureMetricsForSymbols,
  syncVolumeMetricsIndexes,
  listSymbolsByProduct,
  getVolumeAnalysisMeta,
  getFutureExpiriesForSymbol,
  searchInstruments,
};

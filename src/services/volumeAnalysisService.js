const { CACHE_TTL_MS } = require('../config/constants');
const {
  postDhanHistorical,
  buildDhanHistoricalBody,
  buildDhanHistoricalBodyWithExpiryCode,
  isDh905Error,
  fetchIntradayDayVolume,
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
} = require('./volumeInstrumentCatalog');
const {
  getIstClock,
  normalizeTimestamp,
  parseDateOnly,
  formatDateOnly,
  addDays,
} = require('../utils/dateTime');

const LOOKBACK_PRESETS = {
  5: { id: 5, label: 'Last 5 trading days', tradingDays: 5, hint: '~1 week' },
  10: { id: 10, label: 'Last 10 trading days', tradingDays: 10, hint: '~2 weeks' },
  22: { id: 22, label: 'Last 22 trading days', tradingDays: 22, hint: '~1 month' },
  44: { id: 44, label: 'Last 44 trading days', tradingDays: 44, hint: '~2 months' },
};

const analysisCache = new Map();

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

  rows.push({
    rowType: 'today',
    dateKey: todayKey,
    dayLabel: formatIstDateLabel(todayKey, { isToday: true }),
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

async function fetchDailyBars(resolved, calendarSpanDays) {
  const clock = getIstClock(new Date());
  const todayKey = clock.dateKey;
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
async function resolveTodayBar(bars, todayKey, resolved) {
  const fromDaily = bars.find((b) => b.dateKey === todayKey);
  if (fromDaily) {
    return { todayBar: fromDaily, partialToday: false };
  }

  await ensureNseHolidaysLoaded();
  if (isNseCashTradingDay(todayKey)) {
    try {
      const volume = await fetchIntradayDayVolume({
        dateKey: todayKey,
        securityId: resolved.securityId,
        exchangeSegment: resolved.exchangeSegment,
        instrument: resolved.instrument,
      });
      return {
        todayBar: { dateKey: todayKey, volume, close: null },
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

async function runVolumeAnalysis({ symbol, lookbackDays = 5, product = 'cash', expiryDate = null }) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[5];
  const tradingDays = preset.tradingDays;
  const resolved = await resolveAnalysisInstrument({ symbol, product, expiryDate });
  const { bars, todayKey } = await fetchDailyBars(resolved, tradingDays * 2 + 25);
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

  const { todayBar, partialToday } = await resolveTodayBar(bars, todayKey, resolved);
  const priorBars = bars.filter((b) => b.dateKey < todayKey).slice(-tradingDays);
  const compare = buildCompareMetrics(todayBar, priorBars);
  compare.requestedSampleDays = tradingDays;

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
        ? `Today’s volume is ${compare.ratio}× the average of the previous ${compare.sampleDays} trading day${compare.sampleDays === 1 ? '' : 's'} on this contract (${compare.pctVsAvg >= 0 ? '+' : ''}${compare.pctVsAvg}%).`
        : 'Not enough prior days on this contract to compute an average.',
      todayDate: todayKey,
      partialToday,
      todayVolume: compare.todayVolume,
      averageVolume: compare.avgVolume,
      averageOfDays: compare.sampleDays,
      requestedDays: tradingDays,
      shortSample,
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

async function runVolumeAnalysisBatch({
  symbols = [],
  lookbackDays = 10,
  product = 'cash',
  expiryDate = null,
}) {
  const preset = LOOKBACK_PRESETS[lookbackDays] || LOOKBACK_PRESETS[10];
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
    const entry = await getInstrumentEntry(symbol);
    const futureSupported = Boolean(entry?.future);
    const cashSupported = Boolean(entry?.cash) || Boolean(resolveSymbolConfig(symbol).securityId);

    try {
      if (product === 'future' && !futureSupported) {
        throw new Error('No futures listed for this symbol');
      }
      if (product === 'cash' && !cashSupported) {
        throw new Error('No cash or index listing for this symbol');
      }

      const result = await runVolumeAnalysis({
        symbol,
        lookbackDays: preset.tradingDays,
        product,
        expiryDate,
      });

      const priorRows = Array.isArray(result.tableRows)
        ? result.tableRows.filter((r) => r && r.rowType === 'prior')
        : [];

      rows.push({
        ok: true,
        symbol: result.symbol,
        product: result.product,
        expiry: result.expiry || null,
        cashSupported,
        futureSupported,
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
      });
    } catch (err) {
      rows.push({
        ok: false,
        symbol,
        cashSupported,
        futureSupported,
        error: err.message || 'Failed',
      });
    }
    if (i < unique.length - 1) await sleep(180);
  }

  return {
    rows,
    lookback: preset,
    todayDate: clock.dateKey,
    product,
    fetchedAt: new Date().toISOString(),
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
      { id: 'cash', label: 'Cash (equity)', hint: 'NSE share volume' },
      { id: 'future', label: 'Futures', hint: 'Choose expiry from live list' },
    ],
    module: 'volume-analysis',
    description: 'Search any NSE symbol from Dhan. Volume and expiries are live.',
  };
}

module.exports = {
  LOOKBACK_PRESETS,
  runVolumeAnalysis,
  runVolumeAnalysisBatch,
  getVolumeAnalysisMeta,
  getFutureExpiriesForSymbol,
  searchInstruments,
};

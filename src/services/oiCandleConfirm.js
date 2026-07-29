/**
 * Shared OI Wall–style favorable candle confirm (closed FUT + option bars).
 * Used by OI Universe Scanner; mirrors Morning OI / OI Wall Entry rules.
 */

const {
  getIstClock,
  buildIstWallClockTimestamp,
  istCashSessionBucketStart,
  wallClockIsoFromMinutes,
} = require('../utils/dateTime');
const { fetchIntradayCandlesBySecurity } = require('./dhanDataService');
const { resolveOptionInstrument } = require('./dhanLiveService');

const CONFIRM_CANDLE_REFRESH_MIN_GAP_MS = 15000;
const ONE_MIN_REFRESH_MIN_GAP_MS = 8000;

function candleShapeFromOhlc(open, high, low, close, prevClose, meta = {}) {
  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (!(close > open || close < open)) return null; // reject flat/doji
  return {
    open,
    high,
    low,
    close,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    green: close > open,
    red: close < open,
    closed: true,
    ...meta,
  };
}

function barOpenMs(bar) {
  const t = new Date(bar?.[0]).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** Build confirm-interval OHLC from FUT 1m bars on the NSE 09:15 grid. */
function aggregateConfirmBarsFrom1m(rows1m, intervalMinutes = 5) {
  const step = Math.max(1, Number(intervalMinutes) || 5);
  const byKey = new Map();
  for (let i = 0; i < (rows1m || []).length; i += 1) {
    const bar = rows1m[i];
    const clock = getIstClock(bar[0]);
    if (!clock?.dateKey) continue;
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    const bucket = istCashSessionBucketStart(clock.minutes, step);
    const key = `${clock.dateKey}:${bucket}`;
    const o = Number(bar[1]);
    const h = Number(bar[2]);
    const l = Number(bar[3]);
    const c = Number(bar[4]);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        dateKey: clock.dateKey,
        bucket,
        open: o,
        high: h,
        low: l,
        close: c,
        barKey: wallClockIsoFromMinutes(clock.dateKey, bucket),
        oneMinCount: 1,
      });
    } else {
      existing.high = Math.max(existing.high, h);
      existing.low = Math.min(existing.low, l);
      existing.close = c;
      existing.oneMinCount += 1;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
    return a.bucket - b.bucket;
  });
}

/**
 * Latest fully closed confirm bucket only (exact previous grid bar).
 * Example: at 10:31 with 5m → only the 10:25–10:30 bar.
 */
function readExactClosedConfirmFromAgg(aggBars, {
  intervalMinutes = 5,
  clock,
  minBarOpenMinutes = null,
} = {}) {
  if (!clock || !Array.isArray(aggBars) || aggBars.length === 0) return null;
  const step = Math.max(1, Number(intervalMinutes) || 5);
  const currentBucket = istCashSessionBucketStart(clock.minutes, step);
  const expectedOpen = currentBucket - step;
  if (!Number.isFinite(expectedOpen)) return null;
  if (minBarOpenMinutes != null && expectedOpen < minBarOpenMinutes) return null;
  if (clock.minutes < expectedOpen + step) return null;

  let idx = -1;
  for (let i = 0; i < aggBars.length; i += 1) {
    const b = aggBars[i];
    if (b.dateKey === clock.dateKey && b.bucket === expectedOpen) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const bar = aggBars[idx];
  if (bar.oneMinCount < step) return null;
  const prev = idx > 0 && aggBars[idx - 1].dateKey === bar.dateKey ? aggBars[idx - 1] : null;
  return candleShapeFromOhlc(bar.open, bar.high, bar.low, bar.close, prev ? prev.close : null, {
    barKey: bar.barKey,
    openMs: new Date(bar.barKey).getTime(),
    closeMs: buildIstWallClockTimestamp(bar.dateKey, bar.bucket + step),
    intervalMinutes: step,
    bucket: bar.bucket,
    oneMinCount: bar.oneMinCount,
    source: 'FUT_1M_AGG',
  });
}

function readExactClosedConfirmFromRows(rows, {
  intervalMinutes = 5,
  clock,
  minBarOpenMinutes = null,
  matchBucket = null,
} = {}) {
  if (!clock || !Array.isArray(rows) || rows.length === 0) return null;
  const step = Math.max(1, Number(intervalMinutes) || 5);
  const currentBucket = istCashSessionBucketStart(clock.minutes, step);
  const expectedOpen = matchBucket != null ? matchBucket : currentBucket - step;
  if (!Number.isFinite(expectedOpen)) return null;
  if (minBarOpenMinutes != null && expectedOpen < minBarOpenMinutes) return null;
  if (clock.minutes < expectedOpen + step) return null;

  let idx = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const c = getIstClock(rows[i][0]);
    if (c.dateKey !== clock.dateKey) continue;
    const barBucket = istCashSessionBucketStart(c.minutes, step);
    if (barBucket === expectedOpen) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const bar = rows[idx];
  const prev = idx > 0 ? rows[idx - 1] : null;
  const open = Number(bar[1]);
  const high = Number(bar[2]);
  const low = Number(bar[3]);
  const close = Number(bar[4]);
  const prevClose = prev != null ? Number(prev[4]) : null;
  return candleShapeFromOhlc(open, high, low, close, prevClose, {
    barKey: String(bar[0] || ''),
    openMs: barOpenMs(bar),
    closeMs: buildIstWallClockTimestamp(clock.dateKey, expectedOpen + step),
    intervalMinutes: step,
    bucket: expectedOpen,
    source: 'VENDOR_TF',
  });
}

/**
 * FUT closed confirm — wall reaction:
 * CE: wick tags support, closes GREEN at/above wall.
 * PE: wick tags resistance, closes RED at/below wall.
 */
function futCandleConfirms(signal, candle, proximityPoints) {
  if (!signal || !candle || !candle.closed) return false;
  const level = Number(signal.levelStrike);
  const prox = Number(proximityPoints);
  if (!Number.isFinite(level) || !Number.isFinite(prox) || prox <= 0) return false;

  if (signal.optionType === 'CE') {
    const taggedSupport = candle.low <= level + prox && candle.low >= level - prox;
    const closedAboveWall = candle.close >= level;
    const bounce = Number.isFinite(candle.prevClose) ? candle.close >= candle.prevClose : true;
    return Boolean(taggedSupport && closedAboveWall && candle.green && bounce);
  }

  const taggedResist = candle.high >= level - prox && candle.high <= level + prox;
  const closedBelowWall = candle.close <= level;
  const reject = Number.isFinite(candle.prevClose) ? candle.close <= candle.prevClose : true;
  return Boolean(taggedResist && closedBelowWall && candle.red && reject);
}

/** Long option premium confirm — closed green candle only (same bucket as FUT). */
function optionPremiumCandleConfirms(candle) {
  if (!candle || !candle.closed) return false;
  const bounce = Number.isFinite(candle.prevClose) ? candle.close >= candle.prevClose : true;
  return Boolean(candle.green && bounce);
}

/** Confirm candle just closed → entry only for the next N IST minutes. */
function isConfirmFreshForEntry(futCandle, clock, windowMinutes = 2) {
  if (!futCandle || !clock || !Number.isFinite(Number(futCandle.bucket))) return false;
  const step = Math.max(1, Number(futCandle.intervalMinutes) || 5);
  const closeMin = Number(futCandle.bucket) + step;
  const windowMin = Math.max(1, Math.min(15, Number(windowMinutes) || 2));
  return clock.minutes >= closeMin && clock.minutes < closeMin + windowMin;
}

/**
 * Favorable confirm on BOTH closed bars (never forming):
 * FUT (1m aggregate preferred, else vendor TF) + option vendor TF same bucket.
 *
 * @param {object} opts
 * @param {object} opts.cache — mutable per-symbol cache on the scanner slot
 */
async function hasReactionConfirmation({
  clock,
  signal,
  spot,
  strike,
  expiry,
  symbol,
  futInstrument,
  proximityPoints,
  intervalMinutes = 5,
  confirmEntryWindowMinutes = 2,
  tradeFromMinutes = 560,
  usedSameBar = false,
  cache = {},
  force = false,
} = {}) {
  const step = Number(intervalMinutes) === 15 ? 15 : 5;
  const interval = String(step);
  const optionType = signal?.optionType === 'PE' ? 'PE' : 'CE';
  const minBarOpenMinutes = tradeFromMinutes;
  let candleError = null;

  const now = Date.now();
  let rows1m = cache.bars1m || [];
  let bars1mSource = cache.bars1mSource || null;

  if (
    force
    || !rows1m.length
    || now - (cache.bars1mFetchAt || 0) >= ONE_MIN_REFRESH_MIN_GAP_MS
  ) {
    try {
      if (!futInstrument?.securityId) throw new Error('FUT instrument missing');
      const { rows } = await fetchIntradayCandlesBySecurity({
        securityId: futInstrument.securityId,
        exchangeSegment: futInstrument.exchangeSegment || 'NSE_FNO',
        instrument: futInstrument.instrument || 'FUTIDX',
        interval: '1',
        dateKey: clock.dateKey,
      });
      rows1m = Array.isArray(rows) ? rows : [];
      bars1mSource = 'FUT';
      cache.bars1m = rows1m;
      cache.bars1mSource = 'FUT';
      cache.bars1mFetchAt = now;
      cache.candleError = null;
    } catch (err) {
      candleError = err.message || 'FUT 1m candles failed';
      cache.candleError = candleError;
      // Do not fall back to index/spot for confirm.
      bars1mSource = cache.bars1mSource || null;
      rows1m = cache.bars1m || [];
    }
  }

  let futCandle = null;
  if (bars1mSource === 'FUT' && rows1m.length > 0) {
    const agg = aggregateConfirmBarsFrom1m(rows1m, step);
    futCandle = readExactClosedConfirmFromAgg(agg, {
      intervalMinutes: step,
      clock,
      minBarOpenMinutes,
    });
  } else if (!rows1m.length) {
    candleError = candleError || 'FUT 1m candles empty';
  }

  if (!futCandle && bars1mSource !== 'INDEX') {
    let futRows = cache.confirmBarsFut || [];
    if (
      force
      || !futRows.length
      || now - (cache.confirmFutFetchAt || 0) >= CONFIRM_CANDLE_REFRESH_MIN_GAP_MS
    ) {
      try {
        if (!futInstrument?.securityId) throw new Error('FUT instrument missing');
        const { rows } = await fetchIntradayCandlesBySecurity({
          securityId: futInstrument.securityId,
          exchangeSegment: futInstrument.exchangeSegment || 'NSE_FNO',
          instrument: futInstrument.instrument || 'FUTIDX',
          interval,
          dateKey: clock.dateKey,
        });
        futRows = Array.isArray(rows) ? rows : [];
        cache.confirmBarsFut = futRows;
        cache.confirmFutFetchAt = now;
      } catch (err) {
        candleError = err.message || `${step}m FUT candles failed`;
        cache.candleError = candleError;
      }
    }
    futCandle = readExactClosedConfirmFromRows(futRows, {
      intervalMinutes: step,
      clock,
      minBarOpenMinutes,
    });
    if (!futCandle && !candleError) {
      candleError = `${step}m FUT confirm bar missing`;
    }
  }

  const futOk = futCandleConfirms(signal, futCandle, proximityPoints);

  let optionRows = [];
  let optionStrike = Number.isFinite(Number(strike)) ? Number(strike) : null;
  let optionExpiry = expiry || null;
  const optCacheKey = `${symbol}:${optionExpiry}:${optionStrike}:${optionType}:${interval}:${clock.dateKey}`;

  if (optionStrike && optionExpiry) {
    if (
      !force
      && cache.confirmOptionCacheKey === optCacheKey
      && Array.isArray(cache.confirmBarsOption)
      && cache.confirmBarsOption.length > 0
      && now - (cache.confirmOptionFetchAt || 0) < CONFIRM_CANDLE_REFRESH_MIN_GAP_MS
    ) {
      optionRows = cache.confirmBarsOption;
    } else {
      try {
        const instrument = await resolveOptionInstrument({
          symbol,
          strike: optionStrike,
          expiry: optionExpiry,
          optionType,
        });
        const { rows } = await fetchIntradayCandlesBySecurity({
          securityId: instrument.securityId,
          exchangeSegment: instrument.exchangeSegment || 'NSE_FNO',
          instrument: instrument.instrument || 'OPTIDX',
          interval,
          dateKey: clock.dateKey,
        });
        optionRows = Array.isArray(rows) ? rows : [];
        cache.confirmBarsOption = optionRows;
        cache.confirmOptionFetchAt = now;
        cache.confirmOptionCacheKey = optCacheKey;
      } catch (err) {
        candleError = err.message || `${step}m option candles failed`;
        cache.candleError = candleError;
        cache.confirmBarsOption = [];
        cache.confirmOptionCacheKey = null;
        optionRows = [];
      }
    }
  }

  const optionCandle = futCandle
    ? readExactClosedConfirmFromRows(optionRows, {
      intervalMinutes: step,
      clock,
      minBarOpenMinutes,
      matchBucket: futCandle.bucket,
    })
    : null;
  const optionOk = optionPremiumCandleConfirms(optionCandle);
  const confirmFresh = Boolean(futCandle && isConfirmFreshForEntry(futCandle, clock, confirmEntryWindowMinutes));
  const ok = Boolean(
    futOk
    && optionOk
    && !usedSameBar
    && optionStrike
    && futCandle
    && confirmFresh,
  );

  return {
    ok,
    futOk: Boolean(futOk),
    optionOk: Boolean(optionOk),
    confirmFresh,
    usedSameBar: Boolean(usedSameBar),
    interval,
    confirmEntryWindowMinutes: Math.max(1, Math.min(15, Number(confirmEntryWindowMinutes) || 2)),
    strike: optionStrike,
    optionType,
    futCandle,
    optionCandle,
    candleError: candleError || cache.candleError || null,
    spot: Number(spot) || null,
  };
}

module.exports = {
  candleShapeFromOhlc,
  aggregateConfirmBarsFrom1m,
  readExactClosedConfirmFromAgg,
  readExactClosedConfirmFromRows,
  futCandleConfirms,
  optionPremiumCandleConfirms,
  isConfirmFreshForEntry,
  hasReactionConfirmation,
};

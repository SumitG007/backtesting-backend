const { getIstClock } = require('../utils/dateTime');

const M915 = 555;
const M930 = 570;
const M945 = 585;
const M1000 = 600; // 10:00
const M1030 = 630;
const M1100 = 660;
const M1300 = 780; // 13:00
const M1530 = 930; // 15:30

/**
 * Per-session intraday statistics (1m / 5m / 15m). Uses bar OHLC only.
 * @param {{ maxMinutes?: number }} [options] — when set, only bars at or before this IST minute are used (no lookahead).
 */
function computeDayMetrics(bars, prevDay, options = {}) {
  const maxMinutes = Number.isFinite(options.maxMinutes) ? options.maxMinutes : null;

  if (!bars?.length) return null;

  const open = Number(bars[0][1]);
  if (!Number.isFinite(open)) return null;

  let high = -Infinity;
  let low = Infinity;
  let close = open;
  let first15High = -Infinity;
  let first15Low = Infinity;
  let first30High = -Infinity;
  let first30Low = Infinity;
  let holdAboveOpenUntil945 = true;
  let holdBelowOpenUntil945 = true;
  let brokeFirst30HighBefore11 = false;
  let brokeFirst30LowBefore11 = false;

  let firstHourHigh = -Infinity;
  let firstHourLow = Infinity;
  let firstHourClose = open;
  let morningHigh = -Infinity;
  let morningLow = Infinity;
  let afternoonHigh = -Infinity;
  let afternoonLow = Infinity;

  for (const c of bars) {
    const clock = getIstClock(c[0]);
    const m = clock.minutes;
    if (maxMinutes != null && m > maxMinutes) break;
    const h = Number(c[2]);
    const l = Number(c[3]);
    const cl = Number(c[4]);
    if (![h, l, cl].every(Number.isFinite)) continue;

    high = Math.max(high, h);
    low = Math.min(low, l);
    close = cl;

    if (m >= M915 && m < M930) {
      first15High = Math.max(first15High, h);
      first15Low = Math.min(first15Low, l);
    }
    if (m >= M915 && m <= M945) {
      first30High = Math.max(first30High, h);
      first30Low = Math.min(first30Low, l);
      if (l < open) holdAboveOpenUntil945 = false;
      if (h > open) holdBelowOpenUntil945 = false;
    }
    if (m > M945 && m < M1100) {
      if (Number.isFinite(first30High) && h > first30High) brokeFirst30HighBefore11 = true;
      if (Number.isFinite(first30Low) && l < first30Low) brokeFirst30LowBefore11 = true;
    }

    if (m >= M915 && m < M1000) {
      firstHourHigh = Math.max(firstHourHigh, h);
      firstHourLow = Math.min(firstHourLow, l);
      firstHourClose = cl;
    }
    if (m >= M915 && m < M1300) {
      morningHigh = Math.max(morningHigh, h);
      morningLow = Math.min(morningLow, l);
    }
    if (m >= M1300 && m <= M1530) {
      afternoonHigh = Math.max(afternoonHigh, h);
      afternoonLow = Math.min(afternoonLow, l);
    }
  }

  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
  if (!Number.isFinite(first30High) || !Number.isFinite(first30Low)) return null;

  const dateKey = getIstClock(bars[0][0]).dateKey;
  const prevClose = prevDay ? Number(prevDay.close) : null;
  const gapPct =
    prevClose && Number.isFinite(prevClose) && prevClose > 0
      ? ((open - prevClose) / prevClose) * 100
      : null;

  const prevHigh = prevDay ? Number(prevDay.high) : null;
  const prevLow = prevDay ? Number(prevDay.low) : null;
  const prevDayRange =
    prevHigh != null && prevLow != null && Number.isFinite(prevHigh) && Number.isFinite(prevLow)
      ? prevHigh - prevLow
      : null;

  const gapFilledUp =
    gapPct != null && gapPct > 0.03 && prevClose != null && low <= prevClose;
  const gapFilledDown =
    gapPct != null && gapPct < -0.03 && prevClose != null && high >= prevClose;

  const insideDay =
    prevHigh != null && prevLow != null && high < prevHigh && low > prevLow;
  const outsideDay = prevHigh != null && prevLow != null && high > prevHigh && low < prevLow;

  const firstHourGreen = Number.isFinite(firstHourClose) && firstHourClose > open;
  const firstHourRed = Number.isFinite(firstHourClose) && firstHourClose < open;

  const morningRange =
    morningHigh > -Infinity && morningLow < Infinity ? morningHigh - morningLow : 0;
  const afternoonRange =
    afternoonHigh > -Infinity && afternoonLow < Infinity ? afternoonHigh - afternoonLow : 0;

  const dayRange = high - low;
  const bodyAbsPct = open > 0 ? (Math.abs(close - open) / open) * 100 : 0;
  const rangePct = open > 0 ? (dayRange / open) * 100 : 0;

  return {
    dateKey,
    open,
    high,
    low,
    close,
    dayPoints: close - open,
    bodyAbsPct: Number(bodyAbsPct.toFixed(3)),
    rangePct: Number(rangePct.toFixed(3)),
    isGreenDay: close > open,
    isRedDay: close < open,
    dayRange,
    gapPct,
    gapFilledUp,
    gapFilledDown,
    first15Range: first15High - first15Low,
    first30Range: first30High - first30Low,
    first30High,
    first30Low,
    firstHourHigh,
    firstHourLow,
    firstHourClose,
    firstHourGreen,
    firstHourRed,
    morningRange,
    afternoonRange,
    holdAboveOpenUntil945,
    holdBelowOpenUntil945,
    brokeFirst30HighBefore11,
    brokeFirst30LowBefore11,
    brokePrevDayHigh: prevHigh != null && high > prevHigh,
    brokePrevDayLow: prevLow != null && low < prevLow,
    insideDay,
    outsideDay,
    prevDayRange,
    brokePDHBefore1030: false,
    brokePDLBefore1030: false,
    _bars: bars,
    _prevHigh: prevHigh,
    _prevLow: prevLow,
  };
}

function applyEarlyBreakFlags(metrics, options = {}) {
  if (!metrics?._bars) return metrics;
  const maxMinutes = Number.isFinite(options.maxMinutes) ? options.maxMinutes : null;
  const { _bars: bars, _prevHigh: prevHigh, _prevLow: prevLow } = metrics;
  let brokePDHBefore1030 = false;
  let brokePDLBefore1030 = false;
  for (const c of bars) {
    const clock = getIstClock(c[0]);
    if (clock.minutes >= M1030) break;
    if (maxMinutes != null && clock.minutes > maxMinutes) break;
    const h = Number(c[2]);
    const l = Number(c[3]);
    if (prevHigh != null && h > prevHigh) brokePDHBefore1030 = true;
    if (prevLow != null && l < prevLow) brokePDLBefore1030 = true;
  }
  const { _bars, _prevHigh, _prevLow, ...rest } = metrics;
  return { ...rest, brokePDHBefore1030, brokePDLBefore1030 };
}

/** Metrics using only candles known at or before `maxMinutes` IST (avoids signal lookahead). */
function computeDayMetricsAtTime(bars, prevDay, maxMinutes) {
  const raw = computeDayMetrics(bars, prevDay, { maxMinutes });
  if (!raw) return null;
  return applyEarlyBreakFlags(raw, { maxMinutes });
}

function attachChainFields(sortedMetrics) {
  for (let i = 1; i < sortedMetrics.length; i += 1) {
    const prev = sortedMetrics[i - 1];
    sortedMetrics[i].prevDayRangeChained = prev.dayRange;
  }
}

function buildAllDayMetrics(intraByDay, dailyMap) {
  const sorted = Array.from(dailyMap.keys()).sort();
  const out = [];
  for (const dateKey of sorted) {
    const bars = intraByDay.get(dateKey);
    if (!bars?.length) continue;
    let prevDay = null;
    for (let i = sorted.indexOf(dateKey) - 1; i >= 0; i -= 1) {
      const pk = sorted[i];
      if (dailyMap.has(pk)) {
        prevDay = dailyMap.get(pk);
        break;
      }
    }
    const raw = computeDayMetrics(bars, prevDay);
    if (raw) out.push(applyEarlyBreakFlags(raw));
  }
  attachChainFields(out);
  return out;
}

module.exports = {
  buildAllDayMetrics,
  computeDayMetrics,
  computeDayMetricsAtTime,
  applyEarlyBreakFlags,
};

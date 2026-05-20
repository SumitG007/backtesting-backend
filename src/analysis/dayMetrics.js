const { getIstClock } = require('../utils/dateTime');

const M915 = 555;
const M930 = 570;
const M945 = 585;
const M1030 = 630;
const M1100 = 660;

/**
 * Per-session intraday statistics for pattern mining (1m / 5m / 15m).
 * Uses bar high/low inside each window — on 15m the first 30m is two bars (9:15, 9:30).
 */
function computeDayMetrics(bars, prevDay) {
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

  for (const c of bars) {
    const clock = getIstClock(c[0]);
    const h = Number(c[2]);
    const l = Number(c[3]);
    const cl = Number(c[4]);
    if (![h, l, cl].every(Number.isFinite)) continue;

    high = Math.max(high, h);
    low = Math.min(low, l);
    close = cl;

    if (clock.minutes >= M915 && clock.minutes < M930) {
      first15High = Math.max(first15High, h);
      first15Low = Math.min(first15Low, l);
    }
    if (clock.minutes >= M915 && clock.minutes <= M945) {
      first30High = Math.max(first30High, h);
      first30Low = Math.min(first30Low, l);
      if (l < open) holdAboveOpenUntil945 = false;
      if (h > open) holdBelowOpenUntil945 = false;
    }
    if (clock.minutes > M945 && clock.minutes < M1100) {
      if (Number.isFinite(first30High) && h > first30High) brokeFirst30HighBefore11 = true;
      if (Number.isFinite(first30Low) && l < first30Low) brokeFirst30LowBefore11 = true;
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

  return {
    dateKey,
    open,
    high,
    low,
    close,
    dayPoints: close - open,
    isGreenDay: close > open,
    isRedDay: close < open,
    dayRange: high - low,
    gapPct,
    first15Range: first15High - first15Low,
    first30Range: first30High - first30Low,
    first30High,
    first30Low,
    holdAboveOpenUntil945,
    holdBelowOpenUntil945,
    brokeFirst30HighBefore11,
    brokeFirst30LowBefore11,
    brokePrevDayHigh: prevHigh != null && high > prevHigh,
    brokePrevDayLow: prevLow != null && low < prevLow,
    brokePDHBefore1030: false,
    brokePDLBefore1030: false,
    _bars: bars,
    _prevHigh: prevHigh,
    _prevLow: prevLow,
  };
}

function applyEarlyBreakFlags(metrics) {
  if (!metrics?._bars) return metrics;
  const { _bars: bars, _prevHigh: prevHigh, _prevLow: prevLow } = metrics;
  let brokePDHBefore1030 = false;
  let brokePDLBefore1030 = false;
  for (const c of bars) {
    const clock = getIstClock(c[0]);
    if (clock.minutes >= M1030) break;
    const h = Number(c[2]);
    const l = Number(c[3]);
    if (prevHigh != null && h > prevHigh) brokePDHBefore1030 = true;
    if (prevLow != null && l < prevLow) brokePDLBefore1030 = true;
  }
  const { _bars, _prevHigh, _prevLow, ...rest } = metrics;
  return { ...rest, brokePDHBefore1030, brokePDLBefore1030 };
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
  return out;
}

module.exports = {
  buildAllDayMetrics,
  computeDayMetrics,
};

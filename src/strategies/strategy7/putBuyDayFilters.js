/**
 * Strategy 3 — PE confirm routes bearish days to put (PE), other days to call (CE).
 */

const { getIstClock } = require('../../utils/dateTime');
const { computeDayMetrics, applyEarlyBreakFlags } = require('../../analysis/dayMetrics');

const M1000 = 600;

function buildPrevDayMap(sortedKeys, intraByDay) {
  const map = new Map();
  for (const dayKey of sortedKeys) {
    const bars = intraByDay.get(dayKey);
    if (!bars?.length) continue;
    let high = -Infinity;
    let low = Infinity;
    for (const b of bars) {
      high = Math.max(high, Number(b[2]));
      low = Math.min(low, Number(b[3]));
    }
    const last = bars[bars.length - 1];
    map.set(dayKey, {
      close: Number(last[4]),
      high,
      low,
    });
  }
  return map;
}

function buildPutBuyFilterContext(sortedKeys, intraByDay) {
  return {
    sortedKeys,
    prevDayByKey: buildPrevDayMap(sortedKeys, intraByDay),
  };
}

function buildDayMetricsForKey(dayKey, dayBars, ctx) {
  let prevDay = null;
  for (let i = ctx.sortedKeys.indexOf(dayKey) - 1; i >= 0; i -= 1) {
    const pk = ctx.sortedKeys[i];
    if (ctx.prevDayByKey.has(pk)) {
      prevDay = ctx.prevDayByKey.get(pk);
      break;
    }
  }
  const raw = computeDayMetrics(dayBars, prevDay);
  if (!raw) return null;
  const metrics = applyEarlyBreakFlags(raw);
  metrics._prevLow = prevDay?.low ?? null;
  return metrics;
}

function brokePdlBefore(dayBars, prevLow, asOfMinutes) {
  if (prevLow == null || !Number.isFinite(prevLow)) return false;
  for (const c of dayBars) {
    const m = getIstClock(c[0]).minutes;
    if (m > asOfMinutes) break;
    if (Number(c[3]) < prevLow) return true;
  }
  return false;
}

function evaluatePeConfirm(metrics, dayBars, entryIdx) {
  const entryBar = dayBars[entryIdx];
  if (!entryBar) return false;

  const asOfMinutes = getIstClock(entryBar[0]).minutes;
  const open = Number(dayBars[0][1]);
  const entryClose = Number(entryBar[4]);
  const prevLow = metrics._prevLow ?? null;

  if (Number.isFinite(open) && Number.isFinite(entryClose) && entryClose < open) {
    return true;
  }

  if (brokePdlBefore(dayBars, prevLow, asOfMinutes)) {
    return true;
  }

  if (
    metrics.gapPct != null &&
    metrics.gapPct < -0.03 &&
    metrics.gapPct >= -0.6 &&
    metrics.holdBelowOpenUntil945
  ) {
    return true;
  }

  if (asOfMinutes >= M1000 && metrics.firstHourRed) {
    return true;
  }

  if (metrics.brokeFirst30LowBefore11 && !metrics.brokeFirst30HighBefore11) {
    return true;
  }

  const entryOpen = Number(entryBar[1]);
  const entryHigh = Number(entryBar[2]);
  if (
    Number.isFinite(entryOpen) &&
    Number.isFinite(entryClose) &&
    entryClose < entryOpen &&
    Number.isFinite(entryHigh) &&
    Number.isFinite(open) &&
    open > 0 &&
    ((entryOpen - entryClose) / open) * 100 >= 0.03
  ) {
    return true;
  }

  return false;
}

function findEntryBarIndex(dayBars, entryFromMin, entryToMin) {
  for (let j = 0; j < dayBars.length; j += 1) {
    const m = getIstClock(dayBars[j][0]).minutes;
    if (m >= entryFromMin && m <= entryToMin) return j;
  }
  return null;
}

function resolvePutBuyEntry({ dayBars, filterPeConfirm, metrics, entryFromMin, entryToMin }) {
  const entryIdx = findEntryBarIndex(dayBars, entryFromMin, entryToMin);
  if (entryIdx == null || entryIdx >= dayBars.length - 1) {
    return { skip: true, skipReason: 'no_entry_bar', entryIdx: null, optionType: null };
  }

  if (!filterPeConfirm) {
    return { skip: false, skipReason: null, entryIdx, optionType: 'PE' };
  }

  const bearish = metrics && evaluatePeConfirm(metrics, dayBars, entryIdx);
  return {
    skip: false,
    skipReason: null,
    entryIdx,
    optionType: bearish ? 'PE' : 'CE',
  };
}

function parsePutBuyFilterSettings(settings = {}) {
  return {
    filterPeConfirm: settings.filterPeConfirm !== false,
  };
}

module.exports = {
  buildPutBuyFilterContext,
  buildDayMetricsForKey,
  evaluatePeConfirm,
  resolvePutBuyEntry,
  parsePutBuyFilterSettings,
};

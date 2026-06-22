/**
 * Strategy 3 — scored PE vs CE confirm at entry.
 * Stronger bearish bias → long PE; stronger bullish bias → long CE; else skip.
 */

const { getIstClock } = require('../../utils/dateTime');
const { computeDayMetrics, applyEarlyBreakFlags } = require('../../analysis/dayMetrics');

const M1000 = 600;
const DEFAULT_MIN_DIRECTION_SCORE = 2;

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
  metrics._prevHigh = prevDay?.high ?? null;
  metrics._prevLow = prevDay?.low ?? null;
  return metrics;
}

function brokeLevelBefore(dayBars, level, asOfMinutes, side) {
  if (level == null || !Number.isFinite(level)) return false;
  for (const c of dayBars) {
    const m = getIstClock(c[0]).minutes;
    if (m > asOfMinutes) break;
    const h = Number(c[2]);
    const l = Number(c[3]);
    if (side === 'high' && h > level) return true;
    if (side === 'low' && l < level) return true;
  }
  return false;
}

function entryBarBodyPct(entryBar, dayOpen) {
  const entryOpen = Number(entryBar[1]);
  const entryClose = Number(entryBar[4]);
  if (!Number.isFinite(entryOpen) || !Number.isFinite(entryClose) || !Number.isFinite(dayOpen) || dayOpen <= 0) {
    return 0;
  }
  return (Math.abs(entryClose - entryOpen) / dayOpen) * 100;
}

/**
 * Score bearish (PE) and bullish (CE) signals at entry. Higher score = stronger case.
 */
function scoreDirectionalBias(metrics, dayBars, entryIdx) {
  const entryBar = dayBars[entryIdx];
  if (!entryBar || !metrics) {
    return { peScore: 0, ceScore: 0, peSignals: [], ceSignals: [] };
  }

  const asOfMinutes = getIstClock(entryBar[0]).minutes;
  const open = Number(dayBars[0][1]);
  const entryClose = Number(entryBar[4]);
  const entryOpen = Number(entryBar[1]);
  const prevHigh = metrics._prevHigh ?? null;
  const prevLow = metrics._prevLow ?? null;
  const bodyPct = entryBarBodyPct(entryBar, open);

  const peSignals = [];
  const ceSignals = [];

  if (Number.isFinite(open) && Number.isFinite(entryClose)) {
    if (entryClose < open) peSignals.push('below_open');
    if (entryClose > open) ceSignals.push('above_open');
  }

  if (brokeLevelBefore(dayBars, prevLow, asOfMinutes, 'low')) {
    peSignals.push('pdl_break');
  }
  if (brokeLevelBefore(dayBars, prevHigh, asOfMinutes, 'high')) {
    ceSignals.push('pdh_break');
  }

  if (
    metrics.gapPct != null &&
    metrics.gapPct < -0.03 &&
    metrics.gapPct >= -0.6 &&
    metrics.holdBelowOpenUntil945
  ) {
    peSignals.push('gap_down_hold');
  }
  if (
    metrics.gapPct != null &&
    metrics.gapPct > 0.03 &&
    metrics.gapPct <= 0.6 &&
    metrics.holdAboveOpenUntil945
  ) {
    ceSignals.push('gap_up_hold');
  }

  if (metrics.gapPct != null && metrics.gapPct < -0.03 && metrics.gapPct >= -0.6) {
    peSignals.push('gap_down');
  }
  if (metrics.gapPct != null && metrics.gapPct > 0.03 && metrics.gapPct <= 0.6) {
    ceSignals.push('gap_up');
  }

  if (metrics.brokeFirst30LowBefore11 && !metrics.brokeFirst30HighBefore11) {
    peSignals.push('orb_low_break');
  }
  if (metrics.brokeFirst30HighBefore11 && !metrics.brokeFirst30LowBefore11) {
    ceSignals.push('orb_high_break');
  }

  if (asOfMinutes >= M1000 && metrics.firstHourRed) {
    peSignals.push('first_hour_red');
  }
  if (asOfMinutes >= M1000 && metrics.firstHourGreen) {
    ceSignals.push('first_hour_green');
  }

  if (Number.isFinite(entryOpen) && Number.isFinite(entryClose) && entryClose < entryOpen && bodyPct >= 0.03) {
    peSignals.push('red_entry_bar');
  }
  if (Number.isFinite(entryOpen) && Number.isFinite(entryClose) && entryClose > entryOpen && bodyPct >= 0.03) {
    ceSignals.push('green_entry_bar');
  }

  // Mild gap fade: gap up filled to prev close often turns red; gap down filled often turns green.
  if (metrics.gapFilledUp) peSignals.push('gap_up_fade');
  if (metrics.gapFilledDown) ceSignals.push('gap_down_fade');

  return {
    peScore: peSignals.length,
    ceScore: ceSignals.length,
    peSignals,
    ceSignals,
  };
}

/** @deprecated use scoreDirectionalBias — kept for tests */
function evaluatePeConfirm(metrics, dayBars, entryIdx) {
  const { peScore, ceScore } = scoreDirectionalBias(metrics, dayBars, entryIdx);
  return peScore > 0 && peScore >= ceScore;
}

function findEntryBarIndex(dayBars, entryFromMin, entryToMin) {
  for (let j = 0; j < dayBars.length; j += 1) {
    const m = getIstClock(dayBars[j][0]).minutes;
    if (m >= entryFromMin && m <= entryToMin) return j;
  }
  return null;
}

function resolvePutBuyEntry({ dayBars, metrics, entryFromMin, entryToMin, minDirectionScore = DEFAULT_MIN_DIRECTION_SCORE }) {
  const entryIdx = findEntryBarIndex(dayBars, entryFromMin, entryToMin);
  if (entryIdx == null || entryIdx >= dayBars.length - 1) {
    return { skip: true, skipReason: 'no_entry_bar', entryIdx: null, optionType: null };
  }

  const bias = scoreDirectionalBias(metrics, dayBars, entryIdx);
  const minScore = Math.max(1, Number(minDirectionScore) || DEFAULT_MIN_DIRECTION_SCORE);

  if (bias.peScore >= minScore && bias.peScore > bias.ceScore) {
    return {
      skip: false,
      skipReason: null,
      entryIdx,
      optionType: 'PE',
      peScore: bias.peScore,
      ceScore: bias.ceScore,
      signals: bias.peSignals,
    };
  }

  if (bias.ceScore >= minScore && bias.ceScore > bias.peScore) {
    return {
      skip: false,
      skipReason: null,
      entryIdx,
      optionType: 'CE',
      peScore: bias.peScore,
      ceScore: bias.ceScore,
      signals: bias.ceSignals,
    };
  }

  return {
    skip: true,
    skipReason: bias.peScore === bias.ceScore && bias.peScore >= minScore ? 'direction_tie' : 'neutral_day',
    entryIdx: null,
    optionType: null,
    peScore: bias.peScore,
    ceScore: bias.ceScore,
  };
}

function parseDirectionSettings(settings = {}) {
  const rawMin = Number(settings.minDirectionScore);
  const minDirectionScore =
    Number.isFinite(rawMin) && rawMin >= 1 ? Math.min(6, Math.floor(rawMin)) : DEFAULT_MIN_DIRECTION_SCORE;

  return { minDirectionScore };
}

module.exports = {
  DEFAULT_MIN_DIRECTION_SCORE,
  buildPutBuyFilterContext,
  buildDayMetricsForKey,
  scoreDirectionalBias,
  evaluatePeConfirm,
  resolvePutBuyEntry,
  parseDirectionSettings,
};

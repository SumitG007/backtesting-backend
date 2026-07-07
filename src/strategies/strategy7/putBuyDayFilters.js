/**
 * Strategy 3 — scored PE vs CE confirm at entry.
 * Stronger bearish bias → long PE; stronger bullish bias → long CE; else skip.
 */

const { getIstClock } = require('../../utils/dateTime');
const { computeDayMetrics, applyEarlyBreakFlags } = require('../../analysis/dayMetrics');

const { isBlockedSignalCombo } = require('./badComboBlocklist');

const DEFAULT_BAR_INTERVAL_MINUTES = 5;
const DEFAULT_MIN_DIRECTION_SCORE = 2;

const ALL_PE_SIGNALS = [
  'below_open',
  'pdl_break',
  'gap_down_hold',
  'gap_down',
  'orb_low_break',
  'gap_up_fade',
];

const ALL_CE_SIGNALS = [
  'above_open',
  'pdh_break',
  'gap_up_hold',
  'gap_up',
  'orb_high_break',
  'gap_down_fade',
];

function parseEnabledSignalList(raw, allowed) {
  if (raw == null) return [...allowed];
  if (Array.isArray(raw)) {
    const set = new Set(raw.map((id) => String(id)));
    return allowed.filter((id) => set.has(id));
  }
  if (typeof raw === 'object') {
    return allowed.filter((id) => raw[id] !== false && raw[id] !== 'false' && raw[id] !== 0);
  }
  return [...allowed];
}

function filterSignalsByEnabled(signals, enabledList) {
  const enabled = new Set(enabledList);
  return signals.filter((id) => enabled.has(id));
}

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

/**
 * Score bearish (PE) and bullish (CE) signals at entry. Higher score = stronger case.
 */
function scoreDirectionalBias(
  metrics,
  dayBars,
  entryIdx,
  decisionMinutes,
  barIntervalMinutes = DEFAULT_BAR_INTERVAL_MINUTES,
  enabledPeSignals = ALL_PE_SIGNALS,
  enabledCeSignals = ALL_CE_SIGNALS,
) {
  const entryBar = dayBars[entryIdx];
  if (!entryBar || !metrics) {
    return { peScore: 0, ceScore: 0, peSignals: [], ceSignals: [] };
  }

  const barOpenMinutes = getIstClock(entryBar[0]).minutes;
  const asOfMinutes =
    Number.isFinite(decisionMinutes) ? decisionMinutes : barOpenMinutes + barIntervalMinutes;
  const open = Number(dayBars[0][1]);
  const entryClose = Number(entryBar[4]);
  const prevHigh = metrics._prevHigh ?? null;
  const prevLow = metrics._prevLow ?? null;

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

  // Mild gap fade: gap up filled to prev close often turns red; gap down filled often turns green.
  if (metrics.gapFilledUp) peSignals.push('gap_up_fade');
  if (metrics.gapFilledDown) ceSignals.push('gap_down_fade');

  const filteredPe = filterSignalsByEnabled(peSignals, enabledPeSignals);
  const filteredCe = filterSignalsByEnabled(ceSignals, enabledCeSignals);

  return {
    peScore: filteredPe.length,
    ceScore: filteredCe.length,
    peSignals: filteredPe,
    ceSignals: filteredCe,
  };
}

/** @deprecated use scoreDirectionalBias — kept for tests */
function evaluatePeConfirm(metrics, dayBars, entryIdx) {
  const { peScore, ceScore } = scoreDirectionalBias(metrics, dayBars, entryIdx);
  return peScore > 0 && peScore >= ceScore;
}

/**
 * Last 5m bar fully closed at decision clock time.
 * Entry at 11:15 IST → use 11:10 bar (closes 11:15), not the forming 11:15–11:20 bar.
 */
function findLastCompletedBarIndex(dayBars, decisionMinutes, barIntervalMinutes = DEFAULT_BAR_INTERVAL_MINUTES) {
  if (!Number.isFinite(decisionMinutes) || !dayBars?.length) return null;
  let bestIdx = null;
  for (let j = 0; j < dayBars.length; j += 1) {
    const barOpenMinutes = getIstClock(dayBars[j][0]).minutes;
    const barEndMinutes = barOpenMinutes + barIntervalMinutes;
    if (barEndMinutes <= decisionMinutes) bestIdx = j;
    else break;
  }
  return bestIdx;
}

/** Candles + day metrics knowable at entry clock — excludes forming / future bars. */
function sliceBarsAsOfDecision(dayBars, decisionMinutes, barIntervalMinutes = DEFAULT_BAR_INTERVAL_MINUTES) {
  const lastIdx = findLastCompletedBarIndex(dayBars, decisionMinutes, barIntervalMinutes);
  if (lastIdx == null) return [];
  return dayBars.slice(0, lastIdx + 1);
}

function evaluatePutBuyDirection({
  dayKey,
  dayBars,
  filterCtx,
  entryDecisionMinutes,
  minDirectionScore,
  enabledPeSignals = ALL_PE_SIGNALS,
  enabledCeSignals = ALL_CE_SIGNALS,
  barIntervalMinutes = DEFAULT_BAR_INTERVAL_MINUTES,
  requireFollowingBar = true,
  followingBarsDayBars = null,
}) {
  const barsAsOfEntry = sliceBarsAsOfDecision(dayBars, entryDecisionMinutes, barIntervalMinutes);
  if (!barsAsOfEntry.length) {
    return { skip: true, skipReason: 'no_entry_bar', entryIdx: null, optionType: null, peScore: 0, ceScore: 0 };
  }
  const metrics = buildDayMetricsForKey(dayKey, barsAsOfEntry, filterCtx);
  if (!metrics) {
    return { skip: true, skipReason: 'no_metrics', entryIdx: null, optionType: null, peScore: 0, ceScore: 0 };
  }
  return resolvePutBuyEntry({
    dayBars: barsAsOfEntry,
    followingBarsDayBars: followingBarsDayBars || dayBars,
    metrics,
    entryDecisionMinutes,
    minDirectionScore,
    enabledPeSignals,
    enabledCeSignals,
    barIntervalMinutes,
    requireFollowingBar,
  });
}

/** @deprecated use findLastCompletedBarIndex */
function findEntryBarIndex(dayBars, entryFromMin, entryToMin) {
  return findLastCompletedBarIndex(dayBars, entryToMin, DEFAULT_BAR_INTERVAL_MINUTES);
}

function resolvePutBuyEntry({
  dayBars,
  metrics,
  /** IST clock minute when the entry decision is made (e.g. 675 for 11:15). */
  entryDecisionMinutes,
  /** @deprecated alias for entryDecisionMinutes */
  entryFromMin,
  entryToMin,
  minDirectionScore = DEFAULT_MIN_DIRECTION_SCORE,
  enabledPeSignals = ALL_PE_SIGNALS,
  enabledCeSignals = ALL_CE_SIGNALS,
  barIntervalMinutes = DEFAULT_BAR_INTERVAL_MINUTES,
  /** Backtest exit sim needs at least one bar after the signal bar; live uses real ticks. */
  requireFollowingBar = true,
  /** Full session bars for following-bar check when dayBars is sliced at entry. */
  followingBarsDayBars = null,
}) {
  const decisionMinutes = Number.isFinite(entryDecisionMinutes)
    ? entryDecisionMinutes
    : Number.isFinite(entryToMin)
      ? entryToMin
      : entryFromMin;
  const entryIdx = findLastCompletedBarIndex(dayBars, decisionMinutes, barIntervalMinutes);
  const barsForFollowing = followingBarsDayBars || dayBars;
  const missingFollowingBar = requireFollowingBar && entryIdx != null && entryIdx >= barsForFollowing.length - 1;
  if (entryIdx == null || missingFollowingBar) {
    return { skip: true, skipReason: 'no_entry_bar', entryIdx: null, optionType: null };
  }

  const bias = scoreDirectionalBias(
    metrics,
    dayBars,
    entryIdx,
    decisionMinutes,
    barIntervalMinutes,
    enabledPeSignals,
    enabledCeSignals,
  );
  const minScore = Math.max(1, Number(minDirectionScore) || DEFAULT_MIN_DIRECTION_SCORE);

  if (bias.peScore >= minScore && bias.peScore > bias.ceScore) {
    if (isBlockedSignalCombo('PE', bias.peSignals)) {
      return {
        skip: true,
        skipReason: 'bad_combo',
        entryIdx: null,
        optionType: null,
        peScore: bias.peScore,
        ceScore: bias.ceScore,
        signals: bias.peSignals,
      };
    }
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
    if (isBlockedSignalCombo('CE', bias.ceSignals)) {
      return {
        skip: true,
        skipReason: 'bad_combo',
        entryIdx: null,
        optionType: null,
        peScore: bias.peScore,
        ceScore: bias.ceScore,
        signals: bias.ceSignals,
      };
    }
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

  const enabledPeSignals = parseEnabledSignalList(
    settings.enabledPeSignals ?? settings.peSignalFilters,
    ALL_PE_SIGNALS,
  );
  const enabledCeSignals = parseEnabledSignalList(
    settings.enabledCeSignals ?? settings.ceSignalFilters,
    ALL_CE_SIGNALS,
  );

  return { minDirectionScore, enabledPeSignals, enabledCeSignals };
}

module.exports = {
  ALL_PE_SIGNALS,
  ALL_CE_SIGNALS,
  DEFAULT_BAR_INTERVAL_MINUTES,
  DEFAULT_MIN_DIRECTION_SCORE,
  buildPutBuyFilterContext,
  buildDayMetricsForKey,
  scoreDirectionalBias,
  evaluatePeConfirm,
  findLastCompletedBarIndex,
  sliceBarsAsOfDecision,
  evaluatePutBuyDirection,
  findEntryBarIndex,
  resolvePutBuyEntry,
  parseDirectionSettings,
};

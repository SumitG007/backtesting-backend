/**
 * Configurable morning pattern stack — one trade/day, no-lookahead signals, premium exits.
 */

const { isWeekendDateKey, buildIstWallClockTimestamp } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
} = require('../shared/intradayOptions');
const { buildDailyFromIntraday } = require('../../analysis/candleGroups');
const { buildAllDayMetrics, computeDayMetricsAtTime } = require('../../analysis/dayMetrics');
const { getIstClock } = require('../../utils/dateTime');

const EOD_EXIT = 920;

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return Infinity;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function findBarAtOrBefore(bars, targetMinutes, barInterval) {
  let best = null;
  for (let j = 0; j < bars.length; j += 1) {
    const openMin = getIstClock(bars[j][0]).minutes;
    if (openMin <= targetMinutes) best = j;
    else break;
  }
  if (best == null) return null;
  const openMin = getIstClock(bars[best][0]).minutes;
  if (openMin + barInterval > targetMinutes && best > 0) return best - 1;
  return best;
}

function signalCutoffMinutes(entryMinutes, barIntervalMinutes) {
  const interval = Math.max(1, Number(barIntervalMinutes) || 5);
  return entryMinutes - interval;
}

function makeEntry(bars, entryMinutes, optionType, signalId, barIntervalMinutes) {
  const signalIdx = findBarAtOrBefore(bars, entryMinutes, barIntervalMinutes);
  if (signalIdx == null) return { skip: true, skipReason: 'no_signal_bar' };
  const entryIdx = signalIdx + 1;
  if (entryIdx >= bars.length) return { skip: true, skipReason: 'no_entry_bar' };
  return {
    skip: false,
    optionType,
    signalId,
    entryMinutes: getIstClock(bars[entryIdx][0]).minutes,
    entryIdx,
  };
}

/** All mined rules — predicate receives (metrics, ctx, prevDay). */
const PATTERN_RULES = {
  orb_high: {
    label: 'Narrow OR break high',
    entry: 615,
    side: 'CE',
    test: (m, ctx) =>
      m.first30Range <= ctx.first30Median &&
      m.brokeFirst30HighBefore11 &&
      !m.brokeFirst30LowBefore11,
  },
  orb_low: {
    label: 'Narrow OR break low',
    entry: 615,
    side: 'PE',
    test: (m, ctx) =>
      m.first30Range <= ctx.first30Median &&
      m.brokeFirst30LowBefore11 &&
      !m.brokeFirst30HighBefore11,
  },
  pdl: {
    label: 'PDL break before 10:30',
    entry: 615,
    side: 'PE',
    test: (m) => m.brokePDLBefore1030,
  },
  pdh: {
    label: 'PDH break before 10:30',
    entry: 615,
    side: 'CE',
    test: (m) => m.brokePDHBefore1030,
  },
  gap_up: {
    label: 'Gap up + hold above open until 9:45',
    entry: 615,
    side: 'CE',
    test: (m) =>
      m.gapPct != null && m.gapPct > 0.03 && m.gapPct <= 0.6 && m.holdAboveOpenUntil945,
  },
  gap_down: {
    label: 'Gap down + hold below open until 9:45',
    entry: 615,
    side: 'PE',
    test: (m) =>
      m.gapPct != null && m.gapPct < -0.03 && m.gapPct >= -0.6 && m.holdBelowOpenUntil945,
  },
  fh_green: {
    label: 'First hour green',
    entry: 720,
    side: 'CE',
    test: (m) => m.firstHourGreen,
  },
  fh_red: {
    label: 'First hour red',
    entry: 720,
    side: 'PE',
    test: (m) => m.firstHourRed,
  },
  prev_green: {
    label: 'Prev day green continuation',
    entry: 720,
    side: 'CE',
    test: (m, ctx, prev) => prev && prev.isGreenDay && m.firstHourGreen,
  },
  prev_red: {
    label: 'Prev day red continuation',
    entry: 720,
    side: 'PE',
    test: (m, ctx, prev) => prev && prev.isRedDay && m.firstHourRed,
  },
  inside_break_high: {
    label: 'Inside day + broke PDH',
    entry: 720,
    side: 'CE',
    test: (m) => m.insideDay && m.brokePrevDayHigh,
  },
  inside_break_low: {
    label: 'Inside day + broke PDL',
    entry: 720,
    side: 'PE',
    test: (m) => m.insideDay && m.brokePrevDayLow,
  },
  wide_prev_green: {
    label: 'Wide prev day + first hour green',
    entry: 720,
    side: 'CE',
    test: (m, ctx, prev) =>
      prev && prev.dayRange >= ctx.dayRangeMedian && m.firstHourGreen,
  },
  wide_prev_red: {
    label: 'Wide prev day + first hour red',
    entry: 720,
    side: 'PE',
    test: (m, ctx, prev) =>
      prev && prev.dayRange >= ctx.dayRangeMedian && m.firstHourRed,
  },
};

function passesFilters(metrics, filters, symbol) {
  if (filters.skipBothOrb && metrics.brokeFirst30HighBefore11 && metrics.brokeFirst30LowBefore11) {
    return false;
  }
  const minRange = filters.minMorningRange;
  if (Number.isFinite(minRange) && minRange > 0) {
    const sym = String(symbol || 'NIFTY').toUpperCase();
    const floor = sym === 'BANKNIFTY' ? Math.max(minRange, 90) : minRange;
    if (Number.isFinite(metrics.morningRange) && metrics.morningRange < floor) return false;
  }
  if (filters.minFirst30Range != null && metrics.first30Range < filters.minFirst30Range) return false;
  if (filters.maxGapPct != null && metrics.gapPct != null && Math.abs(metrics.gapPct) > filters.maxGapPct) {
    return false;
  }
  return true;
}

function buildStackContext(sortedKeys, intraByDay) {
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const allMetrics = buildAllDayMetrics(intraByDay, dailyMap);
  const metricsByKey = new Map(allMetrics.map((m) => [m.dateKey, m]));
  const sorted = [...sortedKeys].sort();

  const prevDayByKey = new Map();
  const prevMetricsByKey = new Map();
  for (const dayKey of sorted) {
    let prevDay = null;
    let prevMetrics = null;
    for (let i = sorted.indexOf(dayKey) - 1; i >= 0; i -= 1) {
      const pk = sorted[i];
      if (dailyMap.has(pk)) {
        prevDay = dailyMap.get(pk);
        prevMetrics = metricsByKey.get(pk) || null;
        break;
      }
    }
    prevDayByKey.set(dayKey, prevDay);
    prevMetricsByKey.set(dayKey, prevMetrics);
  }

  const first30MedianByDay = new Map();
  const dayRangeMedianByDay = new Map();
  const rolling30 = [];
  const rollingRange = [];
  for (const dayKey of sorted) {
    const m = metricsByKey.get(dayKey);
    if (m && Number.isFinite(m.first30Range)) rolling30.push(m.first30Range);
    if (m && Number.isFinite(m.dayRange)) rollingRange.push(m.dayRange);
    first30MedianByDay.set(dayKey, median(rolling30.slice(-20)));
    dayRangeMedianByDay.set(dayKey, median(rollingRange.slice(-20)));
  }

  return { prevDayByKey, prevMetricsByKey, first30MedianByDay, dayRangeMedianByDay };
}

function resolveStackPattern({
  dayKey,
  bars,
  stackCtx,
  barIntervalMinutes,
  ruleIds,
  filters,
  symbol,
}) {
  if (!bars?.length || !ruleIds?.length) return { skip: true, skipReason: 'no_rules' };

  const prevDay = stackCtx.prevDayByKey.get(dayKey) ?? null;
  const prevMetrics = stackCtx.prevMetricsByKey.get(dayKey) ?? null;
  const ctx = {
    first30Median: stackCtx.first30MedianByDay.get(dayKey) ?? Infinity,
    dayRangeMedian: stackCtx.dayRangeMedianByDay.get(dayKey) ?? Infinity,
  };

  for (const ruleId of ruleIds) {
    const rule = PATTERN_RULES[ruleId];
    if (!rule) continue;

    const cutoff = signalCutoffMinutes(rule.entry, barIntervalMinutes);
    const metrics = computeDayMetricsAtTime(bars, prevDay, cutoff);
    if (!metrics) continue;
    if (!passesFilters(metrics, filters || {}, symbol)) continue;
    if (!rule.test(metrics, ctx, prevMetrics)) continue;

    const entry = makeEntry(bars, rule.entry, rule.side, ruleId, barIntervalMinutes);
    if (!entry.skip) return entry;
  }

  return { skip: true, skipReason: 'no_pattern' };
}

function runPatternStackBacktest({ candles, settings, stackCtx: externalCtx, intraByDay: externalIntra }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 10);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  const rawSl = Number(settings.stopLossPoints);
  const hasStopLoss = Number.isFinite(rawSl) && rawSl > 0;
  const stopLossPoints = hasStopLoss ? Math.min(5000, Math.max(0.01, rawSl)) : 15;

  const rawTg = Number(settings.targetProfitPoints);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetPoints = hasTarget ? Math.min(5000, Math.max(0.01, rawTg)) : 55;

  const barIntervalMinutes = Math.max(1, Number(settings.interval) || Number(settings.barIntervalMinutes) || 5);
  const ruleIds = settings.ruleIds || [];
  const filters = settings.filters || {};

  const intraByDay = externalIntra || buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const stackCtx = externalCtx || buildStackContext(sortedKeys, intraByDay);

  const trades = [];
  const signalCounts = {};
  let skippedDays = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 2) {
      skippedDays += 1;
      continue;
    }

    const decision = resolveStackPattern({
      dayKey,
      bars: dayBars,
      stackCtx,
      barIntervalMinutes,
      ruleIds,
      filters,
      symbol,
    });

    if (decision.skip) {
      skippedDays += 1;
      continue;
    }

    const entryIdx = decision.entryIdx;
    const optionType = decision.optionType || 'PE';
    const entrySpot = Number(dayBars[entryIdx][1]) || Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) {
      skippedDays += 1;
      continue;
    }

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
    const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;
    const targetPremium = hasTarget ? entryPremium + targetPoints : null;

    const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
      dayBars,
      entryIdx,
      optionType,
      entrySpot,
      entryPremium,
      strike,
      strikeStep,
      premiumLeverage,
      hasStopLoss,
      stopPremium,
      hasTarget,
      targetPremium,
      useIndexExits: false,
      stopIndex: null,
      targetIndex: null,
      eodExitMinutes: EOD_EXIT,
    });

    const trade = buildLongOptionTrade({
      symbol,
      lotSize,
      lotCount,
      perTradeCost,
      dayBars,
      entryIdx,
      optionType,
      strike,
      entrySpot,
      entryPremium,
      exitIdx,
      exitSpot,
      exitPremium,
      reason,
      hasStopLoss,
      stopPremium,
      hasTarget,
      targetPremium,
      entryTime: new Date(
        buildIstWallClockTimestamp(dayKey, decision.entryMinutes),
      ).toISOString(),
    });

    trade.signal = decision.signalId;
    trades.push(trade);
    signalCounts[decision.signalId] = (signalCounts[decision.signalId] || 0) + 1;
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.signalCounts = signalCounts;
  return { trades, summary, stackCtx };
}

module.exports = {
  PATTERN_RULES,
  buildStackContext,
  resolveStackPattern,
  runPatternStackBacktest,
};

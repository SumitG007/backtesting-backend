/**
 * Daily-candle + morning-structure patterns with timed index entries.
 * High-frequency rules mined across 2022–2026.
 */

const { buildAllDayMetrics } = require('../analysis/dayMetrics');
const { buildDailyFromIntraday } = require('../analysis/candleGroups');
const { getIstClock } = require('../utils/dateTime');
const { isWeekendDateKey } = require('../utils/dateTime');
const { isNseCashTradingDay } = require('../services/nseHolidayService');
const { measureForwardOutcome } = require('./forwardOutcomes');
const { aggregateOutcomes } = require('./forwardOutcomes');

const ENTRY_SLOTS = [
  { id: '1015', minutes: 615, label: '10:15 IST' },
  { id: '1115', minutes: 675, label: '11:15 IST' },
  { id: '1200', minutes: 720, label: '12:00 IST' },
];

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

function measureFromEntryBar(bars, entryBarIdx, outcomeOpts) {
  if (entryBarIdx == null || entryBarIdx >= bars.length - 1) return null;
  return measureForwardOutcome(bars, entryBarIdx, outcomeOpts);
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function buildDayContext(days) {
  const first30Median = median(days.map((d) => d.first30Range));
  const dayRangeMedian = median(days.map((d) => d.dayRange));
  return { first30Median, dayRangeMedian };
}

/** @returns {{ id: string, label: string, side: 'CE'|'PE', predicate: (d, ctx) => boolean }[]} */
function buildDailyRules() {
  return [
    {
      id: 'first_hour_green',
      label: 'First hour green (close before 10:00 > open)',
      side: 'CE',
      predicate: (d) => d.firstHourGreen,
    },
    {
      id: 'first_hour_red',
      label: 'First hour red (close before 10:00 < open)',
      side: 'PE',
      predicate: (d) => d.firstHourRed,
    },
    {
      id: 'gap_up_hold_945',
      label: 'Gap up 0.03–0.6% + holds above open until 9:45',
      side: 'CE',
      predicate: (d) =>
        d.gapPct != null && d.gapPct > 0.03 && d.gapPct <= 0.6 && d.holdAboveOpenUntil945,
    },
    {
      id: 'gap_down_hold_945',
      label: 'Gap down −0.6% to −0.03% + holds below open until 9:45',
      side: 'PE',
      predicate: (d) =>
        d.gapPct != null && d.gapPct < -0.03 && d.gapPct >= -0.6 && d.holdBelowOpenUntil945,
    },
    {
      id: 'orb_break_high_narrow30',
      label: 'Narrow first 30m + break OR high before 11:00 (no low break)',
      side: 'CE',
      predicate: (d, ctx) =>
        d.first30Range <= ctx.first30Median &&
        d.brokeFirst30HighBefore11 &&
        !d.brokeFirst30LowBefore11,
    },
    {
      id: 'orb_break_low_narrow30',
      label: 'Narrow first 30m + break OR low before 11:00 (no high break)',
      side: 'PE',
      predicate: (d, ctx) =>
        d.first30Range <= ctx.first30Median &&
        d.brokeFirst30LowBefore11 &&
        !d.brokeFirst30HighBefore11,
    },
    {
      id: 'pdh_break_1030',
      label: 'Break previous day high before 10:30',
      side: 'CE',
      predicate: (d) => d.brokePDHBefore1030,
    },
    {
      id: 'pdl_break_1030',
      label: 'Break previous day low before 10:30',
      side: 'PE',
      predicate: (d) => d.brokePDLBefore1030,
    },
    {
      id: 'prev_day_red_continuation',
      label: 'Previous day red close → bearish bias',
      side: 'PE',
      predicate: (d, ctx, prev) => prev && prev.isRedDay,
    },
    {
      id: 'prev_day_green_continuation',
      label: 'Previous day green close → bullish bias',
      side: 'CE',
      predicate: (d, ctx, prev) => prev && prev.isGreenDay,
    },
    {
      id: 'inside_day_break_high',
      label: 'Inside previous day range + broke PDH intraday',
      side: 'CE',
      predicate: (d) => d.insideDay && d.brokePrevDayHigh,
    },
    {
      id: 'inside_day_break_low',
      label: 'Inside previous day range + broke PDL intraday',
      side: 'PE',
      predicate: (d) => d.insideDay && d.brokePrevDayLow,
    },
    {
      id: 'wide_day_prev',
      label: 'Previous day range above median (expansion follow-through)',
      side: 'CE',
      predicate: (d, ctx, prev) =>
        prev && prev.dayRange >= ctx.dayRangeMedian && d.firstHourGreen,
    },
    {
      id: 'wide_day_prev_bear',
      label: 'Previous day wide range + first hour red',
      side: 'PE',
      predicate: (d, ctx, prev) =>
        prev && prev.dayRange >= ctx.dayRangeMedian && d.firstHourRed,
    },
    {
      id: 'both_orb_chop_skip_inverse',
      label: 'Both OR sides broke before 11:00 → fade first hour (contrarian)',
      side: 'PE',
      predicate: (d) => d.brokeFirst30HighBefore11 && d.brokeFirst30LowBefore11 && d.firstHourGreen,
    },
    {
      id: 'both_orb_chop_fade_bull',
      label: 'Both OR sides broke + first hour red → CE fade',
      side: 'CE',
      predicate: (d) => d.brokeFirst30HighBefore11 && d.brokeFirst30LowBefore11 && d.firstHourRed,
    },
  ];
}

function mineDailyPatterns({ intraByDay, outcomeOpts, minSamples, barIntervalMinutes }) {
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const dayMetrics = buildAllDayMetrics(intraByDay, dailyMap);
  const ctx = buildDayContext(dayMetrics);
  const rules = buildDailyRules();
  const metricsByKey = new Map(dayMetrics.map((d) => [d.dateKey, d]));
  const sortedKeys = dayMetrics.map((d) => d.dateKey);

  const prevByKey = new Map();
  for (let i = 1; i < sortedKeys.length; i += 1) {
    prevByKey.set(sortedKeys[i], metricsByKey.get(sortedKeys[i - 1]));
  }

  const results = [];

  for (const rule of rules) {
    for (const slot of ENTRY_SLOTS) {
      const samples = [];

      for (const d of dayMetrics) {
        const dayKey = d.dateKey;
        if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

        const prev = prevByKey.get(dayKey) || null;
        if (!rule.predicate(d, ctx, prev)) continue;

        const bars = intraByDay.get(dayKey);
        if (!bars?.length) continue;

        const signalIdx = findBarAtOrBefore(bars, slot.minutes, barIntervalMinutes);
        const outcome = measureFromEntryBar(bars, signalIdx, outcomeOpts);
        if (!outcome) continue;

        samples.push({ dayKey, outcome, forcedSide: rule.side });
      }

      const stats = aggregateOutcomes(samples);
      if (stats.sampleSize < minSamples) continue;

      const side = rule.side;
      const winRate = side === 'CE' ? stats.longWinRate : stats.shortWinRate;
      const wins = side === 'CE' ? stats.longWins : stats.shortWins;
      const losses = side === 'CE' ? stats.longLosses : stats.shortLosses;

      const yearPositive = Object.values(stats.byYear).filter((y) => {
        const wr = side === 'CE' ? y.longWinRate : y.shortWinRate;
        return wr != null && wr >= 50;
      }).length;
      const yearCount = Object.keys(stats.byYear).length;

      results.push({
        id: `daily_${rule.id}@${slot.id}`,
        category: 'daily_structure',
        label: `${rule.label} → entry ${slot.label} → ${side}`,
        ruleId: rule.id,
        entrySlot: slot.id,
        entryLabel: slot.label,
        sequence: rule.id,
        context: 'daily_structure',
        sequenceLength: 0,
        bestSide: side,
        bestWinRate: winRate,
        sampleSize: stats.sampleSize,
        wins,
        losses,
        longWinRate: stats.longWinRate,
        shortWinRate: stats.shortWinRate,
        avgNext1Points: stats.avgNext1Points,
        avgHorizonPoints: stats.avgHorizonPoints,
        byYear: stats.byYear,
        yearsPositive: yearPositive,
        yearsTotal: yearCount,
        yearStabilityPct: yearCount ? Number(((yearPositive / yearCount) * 100).toFixed(1)) : null,
        occurrencesPerMonth: Number((stats.sampleSize / 53).toFixed(1)),
        tradeable:
          winRate != null &&
          winRate >= 52 &&
          stats.sampleSize >= minSamples &&
          yearPositive >= Math.max(3, yearCount - 1),
      });
    }
  }

  return results;
}

module.exports = {
  ENTRY_SLOTS,
  buildDailyRules,
  mineDailyPatterns,
};

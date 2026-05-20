const { getWeekdayFromDateKey } = require('../utils/dateTime');

function rate(count, total) {
  if (!total) return null;
  return Number(((count / total) * 100).toFixed(1));
}

function sortedCopy(nums) {
  return nums.filter(Number.isFinite).sort((a, b) => a - b);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * (sortedAsc.length - 1)));
  return Number(sortedAsc[idx].toFixed(2));
}

function mean(arr) {
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  return Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(2));
}

/**
 * Deeper aggregates for intraday strategy research (not trade advice).
 * @param {Array<Record<string, unknown>>} days
 */
function computeSupplementaryStats(days) {
  const ranges = sortedCopy(days.map((d) => d.dayRange));
  const bodies = sortedCopy(days.map((d) => d.bodyAbsPct));
  const rangePcts = sortedCopy(days.map((d) => d.rangePct));

  const pctDaysWithBodyAtLeast = (t) =>
    rate(days.filter((d) => Number(d.bodyAbsPct) >= t).length, days.length);

  const pctDaysWithRangeAtLeast = (tPct) =>
    rate(days.filter((d) => Number(d.rangePct) >= tPct).length, days.length);

  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byWd = {};
  for (const d of days) {
    const wd = getWeekdayFromDateKey(d.dateKey);
    if (wd < 1 || wd > 5) continue;
    const label = weekdayNames[wd];
    if (!byWd[label]) {
      byWd[label] = { wd, days: 0, green: 0, red: 0, sumRange: 0, sumBody: 0 };
    }
    byWd[label].days += 1;
    if (d.isGreenDay) byWd[label].green += 1;
    if (d.isRedDay) byWd[label].red += 1;
    byWd[label].sumRange += d.dayRange;
    byWd[label].sumBody += Number(d.bodyAbsPct) || 0;
  }
  const weekdayBreakdown = Object.values(byWd)
    .sort((a, b) => a.wd - b.wd)
    .map((v) => ({
      weekday: weekdayNames[v.wd],
      tradingDays: v.days,
      greenRate: rate(v.green, v.days),
      redRate: rate(v.red, v.days),
      avgDayRange: v.days ? Number((v.sumRange / v.days).toFixed(1)) : 0,
      avgAbsBodyPct: v.days ? Number((v.sumBody / v.days).toFixed(3)) : 0,
    }));

  const byMonth = {};
  for (const d of days) {
    const ym = d.dateKey.slice(0, 7);
    if (!byMonth[ym]) byMonth[ym] = { ym, days: 0, green: 0, red: 0, sumRange: 0, sumBody: 0 };
    byMonth[ym].days += 1;
    if (d.isGreenDay) byMonth[ym].green += 1;
    if (d.isRedDay) byMonth[ym].red += 1;
    byMonth[ym].sumRange += d.dayRange;
    byMonth[ym].sumBody += Number(d.bodyAbsPct) || 0;
  }
  const monthlyBreakdown = Object.values(byMonth)
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((v) => ({
      month: v.ym,
      tradingDays: v.days,
      greenRate: rate(v.green, v.days),
      redRate: rate(v.red, v.days),
      avgDayRange: v.days ? Number((v.sumRange / v.days).toFixed(1)) : 0,
      avgAbsBodyPct: v.days ? Number((v.sumBody / v.days).toFixed(3)) : 0,
    }));

  let fhAgree = 0;
  let fhSample = 0;
  for (const d of days) {
    if (d.firstHourGreen || d.firstHourRed) {
      fhSample += 1;
      if ((d.firstHourGreen && d.isGreenDay) || (d.firstHourRed && d.isRedDay)) fhAgree += 1;
    }
  }

  const gapUps = days.filter((d) => d.gapPct != null && d.gapPct > 0.03);
  const gapDowns = days.filter((d) => d.gapPct != null && d.gapPct < -0.03);

  const morningRanges = days.map((d) => d.morningRange).filter(Number.isFinite);
  const afternoonRanges = days.map((d) => d.afternoonRange).filter(Number.isFinite);
  let sumAfternoonShare = 0;
  let nShare = 0;
  for (const d of days) {
    if (d.dayRange > 0 && Number.isFinite(d.afternoonRange)) {
      sumAfternoonShare += d.afternoonRange / d.dayRange;
      nShare += 1;
    }
  }

  const insideCount = days.filter((d) => d.insideDay).length;
  const outsideCount = days.filter((d) => d.outsideDay).length;

  return {
    distribution: {
      dayRangeP50: percentile(ranges, 50),
      dayRangeP75: percentile(ranges, 75),
      dayRangeP90: percentile(ranges, 90),
      absCloseMinusOpenPctP50: percentile(bodies, 50),
      absCloseMinusOpenPctP75: percentile(bodies, 75),
      absCloseMinusOpenPctP90: percentile(bodies, 90),
      rangeAsPercentOfOpenP50: percentile(rangePcts, 50),
      rangeAsPercentOfOpenP90: percentile(rangePcts, 90),
    },
    moveThresholds: {
      pctDaysAbsBodyGte_0_15: pctDaysWithBodyAtLeast(0.15),
      pctDaysAbsBodyGte_0_35: pctDaysWithBodyAtLeast(0.35),
      pctDaysAbsBodyGte_0_5: pctDaysWithBodyAtLeast(0.5),
      pctDaysAbsBodyGte_1_0: pctDaysWithBodyAtLeast(1.0),
      pctDaysRangePctGte_0_5: pctDaysWithRangeAtLeast(0.5),
      pctDaysRangePctGte_0_8: pctDaysWithRangeAtLeast(0.8),
      pctDaysRangePctGte_1_2: pctDaysWithRangeAtLeast(1.2),
    },
    weekdayBreakdown,
    monthlyBreakdown,
    sessionProfile: {
      avgMorningRange: mean(morningRanges),
      avgAfternoonRange: mean(afternoonRanges),
      afternoonShareOfDayRangePct:
        nShare > 0 ? Number(((sumAfternoonShare / nShare) * 100).toFixed(1)) : null,
      note: 'Morning = 09:15–13:00 IST; afternoon = 13:00–15:30 IST (bar timestamps).',
    },
    gapFill: {
      gapUpDaysOver003: gapUps.length,
      gapUpClosedIntoPrevCloseRate: rate(gapUps.filter((d) => d.gapFilledUp).length, gapUps.length),
      gapDownDaysOver003: gapDowns.length,
      gapDownClosedIntoPrevCloseRate: rate(gapDowns.filter((d) => d.gapFilledDown).length, gapDowns.length),
      note: 'Fill = session touches previous close (full gap fill proxy, bar highs/lows only).',
    },
    firstHourVsRestOfDay: {
      daysWithClearFirstHour: fhSample,
      firstHourSameColorAsDayClose: rate(fhAgree, fhSample),
      note: 'First hour = candles with timestamp before 10:00 IST.',
    },
    dayStructure: {
      insideDays: insideCount,
      outsideDays: outsideCount,
      insideRate: rate(insideCount, days.length),
      outsideRate: rate(outsideCount, days.length),
      note: 'Inside day = high < prev high and low > prev low. Outside = engulfs prior range.',
    },
    goalRealityCheck: {
      lines: [
        'This panel describes how the index moved in the past — not how much your account can grow.',
        'Targets like “double capital in a month” or a fixed “50% max” require live risk limits, slippage, and drawdowns — they cannot be guaranteed from historical stats.',
        'Use distribution + patterns to design entries, then backtest with your real position sizing and costs.',
      ],
    },
  };
}

module.exports = {
  computeSupplementaryStats,
};

const MIN_SAMPLE = 35;

function rate(count, total) {
  if (!total) return null;
  return Number(((count / total) * 100).toFixed(1));
}

function bucketGap(gapPct) {
  if (gapPct == null || !Number.isFinite(gapPct)) return 'unknown';
  if (gapPct > 0.6) return 'gap_up_large';
  if (gapPct > 0.15) return 'gap_up_med';
  if (gapPct > 0.03) return 'gap_up_small';
  if (gapPct < -0.6) return 'gap_down_large';
  if (gapPct < -0.15) return 'gap_down_med';
  if (gapPct < -0.03) return 'gap_down_small';
  return 'flat';
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function evalPattern(days, predicate, outcomeFn) {
  const matched = days.filter(predicate);
  const n = matched.length;
  if (n < MIN_SAMPLE) {
    return { sampleSize: n, winRate: null, avgDayPoints: null, skipped: true, reason: `Need at least ${MIN_SAMPLE} days` };
  }
  let wins = 0;
  let pointSum = 0;
  for (const d of matched) {
    const outcome = outcomeFn(d);
    if (outcome > 0) wins += 1;
    pointSum += outcome;
  }
  return {
    sampleSize: n,
    winRate: rate(wins, n),
    avgDayPoints: Number((pointSum / n).toFixed(2)),
    skipped: false,
  };
}

/**
 * @param {ReturnType<import('./dayMetrics').buildAllDayMetrics>} days
 */
function computePatternStats(days) {
  const first30Median = median(days.map((d) => d.first30Range));
  const narrowOr30 = (d) => d.first30Range <= first30Median;

  const patterns = [
    {
      id: 'gap_up_hold_945_long',
      tradeable: true,
      label: 'Gap up (0.03–0.6%) + holds above open until 9:45 → green day',
      description: 'Mild gap up with early strength; target bullish close.',
      ...evalPattern(
        days,
        (d) =>
          d.gapPct != null &&
          d.gapPct > 0.03 &&
          d.gapPct <= 0.6 &&
          d.holdAboveOpenUntil945,
        (d) => (d.isGreenDay ? 1 : -1)
      ),
    },
    {
      id: 'gap_down_hold_945_short',
      tradeable: true,
      label: 'Gap down (−0.6% to −0.03%) + holds below open until 9:45 → red day',
      description: 'Mild gap down with early weakness; target bearish close.',
      ...evalPattern(
        days,
        (d) =>
          d.gapPct != null &&
          d.gapPct < -0.03 &&
          d.gapPct >= -0.6 &&
          d.holdBelowOpenUntil945,
        (d) => (d.isRedDay ? 1 : -1)
      ),
    },
    {
      id: 'orb30_break_high_long',
      tradeable: true,
      label: 'Narrow first 30m + break first-30 high before 11:00 → green day',
      description: 'Opening-range breakout to upside after compressed open.',
      ...evalPattern(
        days,
        (d) => narrowOr30(d) && d.brokeFirst30HighBefore11 && !d.brokeFirst30LowBefore11,
        (d) => (d.isGreenDay ? 1 : -1)
      ),
    },
    {
      id: 'orb30_break_low_short',
      tradeable: true,
      label: 'Narrow first 30m + break first-30 low before 11:00 → red day',
      description: 'Opening-range breakdown after compressed open.',
      ...evalPattern(
        days,
        (d) => narrowOr30(d) && d.brokeFirst30LowBefore11 && !d.brokeFirst30HighBefore11,
        (d) => (d.isRedDay ? 1 : -1)
      ),
    },
    {
      id: 'pdh_break_before_1030_long',
      tradeable: true,
      label: 'Break previous day high before 10:30 → green day',
      description: 'Early continuation above prior session high.',
      ...evalPattern(
        days,
        (d) => d.brokePDHBefore1030,
        (d) => (d.isGreenDay ? 1 : -1)
      ),
    },
    {
      id: 'pdl_break_before_1030_short',
      tradeable: true,
      label: 'Break previous day low before 10:30 → red day',
      description: 'Early breakdown below prior session low.',
      ...evalPattern(
        days,
        (d) => d.brokePDLBefore1030,
        (d) => (d.isRedDay ? 1 : -1)
      ),
    },
    {
      id: 'flat_open_trend_day',
      tradeable: false,
      label: 'Flat gap (|gap| ≤ 0.03%) + |day move| > 0.35% of open',
      description:
        'Research only: flags a big move day, not up vs down. Not used for suggested trades (no entry rule).',
      ...evalPattern(
        days,
        (d) => d.gapPct != null && Math.abs(d.gapPct) <= 0.03 && Math.abs(d.dayPoints) > d.open * 0.0035,
        (d) => (Math.abs(d.dayPoints) > 0 ? 1 : 0)
      ),
    },
  ];

  const gapBuckets = {};
  for (const d of days) {
    const b = bucketGap(d.gapPct);
    if (!gapBuckets[b]) gapBuckets[b] = { count: 0, green: 0, red: 0 };
    gapBuckets[b].count += 1;
    if (d.isGreenDay) gapBuckets[b].green += 1;
    if (d.isRedDay) gapBuckets[b].red += 1;
  }
  const gapSummary = Object.entries(gapBuckets).map(([bucket, v]) => ({
    bucket,
    days: v.count,
    greenRate: rate(v.green, v.count),
    redRate: rate(v.red, v.count),
  }));

  const byYear = {};
  for (const d of days) {
    const y = d.dateKey.slice(0, 4);
    if (!byYear[y]) byYear[y] = { days: 0, green: 0, red: 0, avgRange: 0 };
    byYear[y].days += 1;
    if (d.isGreenDay) byYear[y].green += 1;
    if (d.isRedDay) byYear[y].red += 1;
    byYear[y].avgRange += d.dayRange;
  }
  const yearBreakdown = Object.entries(byYear)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, v]) => ({
      year,
      tradingDays: v.days,
      greenRate: rate(v.green, v.days),
      redRate: rate(v.red, v.days),
      avgDayRange: v.days ? Number((v.avgRange / v.days).toFixed(1)) : 0,
    }));

  const greenDays = days.filter((d) => d.isGreenDay).length;
  const redDays = days.filter((d) => d.isRedDay).length;

  return {
    minSample: MIN_SAMPLE,
    first30RangeMedian: Number(first30Median.toFixed(2)),
    overview: {
      tradingDays: days.length,
      greenDays,
      redDays,
      greenRate: rate(greenDays, days.length),
      redRate: rate(redDays, days.length),
      avgDayRange: days.length
        ? Number((days.reduce((a, d) => a + d.dayRange, 0) / days.length).toFixed(1))
        : 0,
      avgAbsGapPct: (() => {
        const gaps = days.map((d) => d.gapPct).filter(Number.isFinite);
        if (!gaps.length) return null;
        return Number((gaps.reduce((a, g) => a + Math.abs(g), 0) / gaps.length).toFixed(3));
      })(),
    },
    gapSummary,
    patterns: patterns.sort((a, b) => {
      if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
      const aw = a.skipped ? -1 : a.winRate ?? 0;
      const bw = b.skipped ? -1 : b.winRate ?? 0;
      return bw - aw;
    }),
    yearBreakdown,
  };
}

module.exports = {
  computePatternStats,
  MIN_SAMPLE,
};

/**
 * Data-mined intraday rules (2022–26 NIFTY study) → CE/PE entry timing.
 */

const { buildIntradayByDay, buildDailyFromIntraday } = require('../../analysis/candleGroups');
const { buildAllDayMetrics } = require('../../analysis/dayMetrics');
const { getIstClock } = require('../../utils/dateTime');

const PATTERN_RULES = {
  gap_up_hold_945_long: {
    optionType: 'CE',
    signal: 'GAP_UP_HOLD_945',
    entryMinutes: 585,
    matches: (d) =>
      d.gapPct != null &&
      d.gapPct > 0.03 &&
      d.gapPct <= 0.6 &&
      d.holdAboveOpenUntil945,
  },
  gap_down_hold_945_short: {
    optionType: 'PE',
    signal: 'GAP_DOWN_HOLD_945',
    entryMinutes: 585,
    matches: (d) =>
      d.gapPct != null &&
      d.gapPct < -0.03 &&
      d.gapPct >= -0.6 &&
      d.holdBelowOpenUntil945,
  },
  orb30_break_high_long: {
    optionType: 'CE',
    signal: 'ORB30_BREAK_HIGH',
    entryMinutes: 660,
    matches: (d, ctx) =>
      d.first30Range <= ctx.first30Median &&
      d.brokeFirst30HighBefore11 &&
      !d.brokeFirst30LowBefore11,
  },
  orb30_break_low_short: {
    optionType: 'PE',
    signal: 'ORB30_BREAK_LOW',
    entryMinutes: 660,
    matches: (d, ctx) =>
      d.first30Range <= ctx.first30Median &&
      d.brokeFirst30LowBefore11 &&
      !d.brokeFirst30HighBefore11,
  },
  pdh_break_before_1030_long: {
    optionType: 'CE',
    signal: 'PDH_BREAK_1030',
    entryMinutes: 630,
    matches: (d) => d.brokePDHBefore1030,
  },
  pdl_break_before_1030_short: {
    optionType: 'PE',
    signal: 'PDL_BREAK_1030',
    entryMinutes: 630,
    matches: (d) => d.brokePDLBefore1030,
  },
  first_hour_green_long: {
    optionType: 'CE',
    signal: 'FIRST_HOUR_GREEN',
    entryMinutes: 600,
    matches: (d) => d.firstHourGreen,
  },
  first_hour_red_short: {
    optionType: 'PE',
    signal: 'FIRST_HOUR_RED',
    entryMinutes: 600,
    matches: (d) => d.firstHourRed,
  },
};

const MODE_TO_PATTERNS = {
  orb30_pe: ['orb30_break_low_short'],
  orb30_ce: ['orb30_break_high_long'],
  first_hour_pe: ['first_hour_red_short'],
  first_hour_ce: ['first_hour_green_long'],
  pdh_ce: ['pdh_break_before_1030_long'],
  pdl_pe: ['pdl_break_before_1030_short'],
  gap_pe: ['gap_down_hold_945_short'],
  gap_ce: ['gap_up_hold_945_long'],
  pe_pack: ['orb30_break_low_short', 'pdl_break_before_1030_short', 'first_hour_red_short', 'gap_down_hold_945_short'],
  ce_pack: ['orb30_break_high_long', 'pdh_break_before_1030_long', 'first_hour_green_long', 'gap_up_hold_945_long'],
  combined: [
    'first_hour_red_short',
    'first_hour_green_long',
    'pdl_break_before_1030_short',
    'pdh_break_before_1030_long',
    'orb30_break_low_short',
    'orb30_break_high_long',
  ],
};

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function findEntryIdx(dayBars, entryMinutes) {
  for (let i = 0; i < dayBars.length; i += 1) {
    if (getIstClock(dayBars[i][0]).minutes >= entryMinutes) return i;
  }
  return dayBars.length > 0 ? dayBars.length - 1 : -1;
}

function buildDayContext(execCandles) {
  const intraByDay = buildIntradayByDay(Array.isArray(execCandles) ? execCandles : []);
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const dayMetrics = buildAllDayMetrics(intraByDay, dailyMap);
  const dayByKey = new Map(dayMetrics.map((d) => [d.dateKey, d]));
  const first30Median = median(dayMetrics.map((d) => d.first30Range));
  return {
    intraByDay,
    sortedDays: Array.from(intraByDay.keys()).sort(),
    dayByKey,
    first30Median,
  };
}

function resolvePatternIds(settings) {
  const mode = String(settings.patternMode || 'combined').toLowerCase();
  if (settings.dataPatternId && PATTERN_RULES[settings.dataPatternId]) {
    return [String(settings.dataPatternId)];
  }
  return MODE_TO_PATTERNS[mode] || MODE_TO_PATTERNS.combined;
}

/**
 * @returns {{ optionType: string, entryIdx: number, signal: string, patternId: string } | null}
 */
function resolveDataPatternSignal(day, dayBars, settings, ctx) {
  if (!day || !dayBars?.length) return null;
  const ids = resolvePatternIds(settings);
  const matched = [];
  for (const id of ids) {
    const rule = PATTERN_RULES[id];
    if (!rule || !rule.matches(day, ctx)) continue;
    matched.push({ patternId: id, ...rule });
  }
  if (!matched.length) return null;
  matched.sort((a, b) => a.entryMinutes - b.entryMinutes);
  const pick = matched[0];
  const entryIdx = findEntryIdx(dayBars, pick.entryMinutes);
  if (entryIdx < 0) return null;
  return {
    optionType: pick.optionType,
    entryIdx,
    signal: pick.signal,
    patternId: pick.patternId,
  };
}

module.exports = {
  PATTERN_RULES,
  MODE_TO_PATTERNS,
  buildDayContext,
  resolveDataPatternSignal,
};

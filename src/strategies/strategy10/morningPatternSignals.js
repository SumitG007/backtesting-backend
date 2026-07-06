/**
 * Strategy 6 — morning pattern stack with configurable rules & chop filters.
 */

const { buildAllDayMetrics, computeDayMetricsAtTime } = require('../../analysis/dayMetrics');
const { buildDailyFromIntraday } = require('../../analysis/candleGroups');
const { getIstClock } = require('../../utils/dateTime');

const ENTRY_1015 = 615;
const ENTRY_1200 = 720;
const ROLLING_DAYS = 20;

const MIN_MORNING_RANGE = {
  NIFTY: 40,
  BANKNIFTY: 90,
};

const DEFAULT_PATTERN_CONFIG = {
  stackMode: 'strict',
  skipBothOrbBreak: true,
  skipLowMorningRange: true,
  enableOrbHigh: true,
  enableOrbLow: true,
  enablePdl: true,
  enableFirstHour: true,
};

function parsePatternConfig(settings = {}) {
  const raw = settings.patternConfig || settings;
  const stackMode = String(raw.stackMode || DEFAULT_PATTERN_CONFIG.stackMode).toLowerCase();

  let cfg = { ...DEFAULT_PATTERN_CONFIG, stackMode };

  if (stackMode === 'full') {
    cfg = {
      ...cfg,
      skipBothOrbBreak: false,
      skipLowMorningRange: false,
      enableOrbHigh: true,
      enableOrbLow: true,
      enablePdl: true,
      enableFirstHour: true,
    };
  } else if (stackMode === 'orb_only') {
    cfg = {
      ...cfg,
      enablePdl: false,
      enableFirstHour: false,
    };
  } else if (stackMode === 'orb_pdl') {
    cfg = {
      ...cfg,
      enableFirstHour: false,
    };
  } else if (stackMode === 'orb_high_only') {
    cfg = {
      ...cfg,
      enableOrbLow: false,
      enablePdl: false,
      enableFirstHour: false,
    };
  } else if (stackMode === 'orb_low_only') {
    cfg = {
      ...cfg,
      enableOrbHigh: false,
      enablePdl: false,
      enableFirstHour: false,
    };
  } else if (stackMode === 'pdl_only') {
    cfg = {
      ...cfg,
      enableOrbHigh: false,
      enableOrbLow: false,
      enableFirstHour: false,
    };
  }

  if (raw.skipBothOrbBreak != null) cfg.skipBothOrbBreak = Boolean(raw.skipBothOrbBreak);
  if (raw.skipLowMorningRange != null) cfg.skipLowMorningRange = Boolean(raw.skipLowMorningRange);
  if (raw.enableOrbHigh != null) cfg.enableOrbHigh = Boolean(raw.enableOrbHigh);
  if (raw.enableOrbLow != null) cfg.enableOrbLow = Boolean(raw.enableOrbLow);
  if (raw.enablePdl != null) cfg.enablePdl = Boolean(raw.enablePdl);
  if (raw.enableFirstHour != null) cfg.enableFirstHour = Boolean(raw.enableFirstHour);

  return cfg;
}

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

function buildMorningPatternContext(sortedKeys, intraByDay) {
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const allMetrics = buildAllDayMetrics(intraByDay, dailyMap);
  const metricsByKey = new Map(allMetrics.map((m) => [m.dateKey, m]));

  const prevDayByKey = new Map();
  const sorted = [...sortedKeys].sort();
  for (const dayKey of sorted) {
    let prevDay = null;
    for (let i = sorted.indexOf(dayKey) - 1; i >= 0; i -= 1) {
      const pk = sorted[i];
      if (dailyMap.has(pk)) {
        prevDay = dailyMap.get(pk);
        break;
      }
    }
    prevDayByKey.set(dayKey, prevDay);
  }

  const first30MedianByDay = new Map();
  const rolling = [];
  for (const dayKey of sorted) {
    const m = metricsByKey.get(dayKey);
    if (m && Number.isFinite(m.first30Range)) rolling.push(m.first30Range);
    first30MedianByDay.set(dayKey, median(rolling.slice(-ROLLING_DAYS)));
  }

  return { metricsByKey, first30MedianByDay, prevDayByKey };
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

function passesChopFilters(metrics, patternConfig, symbol) {
  if (patternConfig.skipBothOrbBreak && metrics.brokeFirst30HighBefore11 && metrics.brokeFirst30LowBefore11) {
    return { ok: false, skipReason: 'chop_both_orb' };
  }

  if (patternConfig.skipLowMorningRange) {
    const sym = String(symbol || 'NIFTY').toUpperCase();
    const minRange = MIN_MORNING_RANGE[sym] || MIN_MORNING_RANGE.NIFTY;
    const morningRange = Number(metrics.morningRange);
    if (Number.isFinite(morningRange) && morningRange < minRange) {
      return { ok: false, skipReason: 'low_morning_range' };
    }
  }

  return { ok: true };
}

function resolveMorningPattern({ dayKey, bars, filterCtx, barIntervalMinutes, patternConfig, symbol }) {
  if (!bars?.length) return { skip: true, skipReason: 'no_metrics' };

  const cfg = patternConfig || DEFAULT_PATTERN_CONFIG;
  const prevDay = filterCtx.prevDayByKey?.get(dayKey) ?? null;
  const first30Median = filterCtx.first30MedianByDay.get(dayKey) ?? Infinity;

  const metrics1015 = computeDayMetricsAtTime(bars, prevDay, ENTRY_1015);
  if (!metrics1015) return { skip: true, skipReason: 'no_metrics' };

  const narrow30At1015 =
    Number.isFinite(metrics1015.first30Range) &&
    Number.isFinite(first30Median) &&
    metrics1015.first30Range <= first30Median;

  const chop1015 = passesChopFilters(metrics1015, cfg, symbol);
  if (chop1015.ok) {
    if (
      cfg.enableOrbHigh &&
      narrow30At1015 &&
      metrics1015.brokeFirst30HighBefore11 &&
      !metrics1015.brokeFirst30LowBefore11
    ) {
      return makeEntry(bars, ENTRY_1015, 'CE', 'orb_break_high_narrow30', barIntervalMinutes);
    }

    if (
      cfg.enableOrbLow &&
      narrow30At1015 &&
      metrics1015.brokeFirst30LowBefore11 &&
      !metrics1015.brokeFirst30HighBefore11
    ) {
      return makeEntry(bars, ENTRY_1015, 'PE', 'orb_break_low_narrow30', barIntervalMinutes);
    }

    if (cfg.enablePdl && metrics1015.brokePDLBefore1030) {
      return makeEntry(bars, ENTRY_1015, 'PE', 'pdl_break_1030', barIntervalMinutes);
    }
  }

  if (cfg.enableFirstHour) {
    const metrics1200 = computeDayMetricsAtTime(bars, prevDay, ENTRY_1200);
    if (!metrics1200) return { skip: true, skipReason: 'no_metrics' };

    const chop1200 = passesChopFilters(metrics1200, cfg, symbol);
    if (!chop1200.ok) return { skip: true, skipReason: chop1200.skipReason };

    if (metrics1200.firstHourGreen) {
      return makeEntry(bars, ENTRY_1200, 'CE', 'first_hour_green', barIntervalMinutes);
    }
    if (metrics1200.firstHourRed) {
      return makeEntry(bars, ENTRY_1200, 'PE', 'first_hour_red', barIntervalMinutes);
    }
  }

  return { skip: true, skipReason: 'no_pattern' };
}

module.exports = {
  ENTRY_1015,
  ENTRY_1200,
  DEFAULT_PATTERN_CONFIG,
  MIN_MORNING_RANGE,
  parsePatternConfig,
  buildMorningPatternContext,
  resolveMorningPattern,
};

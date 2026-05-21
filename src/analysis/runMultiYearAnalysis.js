const { buildIntradayByDay, buildDailyFromIntraday } = require('./candleGroups');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('./loadCandlesMultiYear');
const { buildAllDayMetrics } = require('./dayMetrics');
const { computePatternStats } = require('./patternStats');
const { buildSuggestedStrategy } = require('./suggestedStrategy');
const { buildOptionSignalReport } = require('./optionSignalReport');
const { computeSupplementaryStats } = require('./extendedStats');
const { getIntervalMeta } = require('./intervalMeta');

/**
 * @param {{ symbol: string, interval: string, years?: number[], preferApi?: boolean }} opts
 */
async function runMultiYearAnalysis({ symbol, interval, years, preferApi = false }) {
  const safeYears = (years?.length ? years : DEFAULT_YEARS).map(Number).filter(Number.isFinite);
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const intv = String(interval || '5');

  const startedAt = Date.now();
  const { allRows, yearStats, source } = await loadCandlesMultiYear({
    symbol: sym,
    interval: intv,
    years: safeYears,
    preferApi,
  });

  const intraByDay = buildIntradayByDay(allRows);
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const dayMetrics = buildAllDayMetrics(intraByDay, dailyMap);
  const intervalMeta = getIntervalMeta(intv);
  const patternReport = computePatternStats(dayMetrics);
  const supplementary = computeSupplementaryStats(dayMetrics);
  const suggested = buildSuggestedStrategy({
    patterns: patternReport.patterns,
    days: dayMetrics,
    intraByDay,
  });
  const optionSignals = buildOptionSignalReport({
    patterns: patternReport.patterns,
    days: dayMetrics,
    intraByDay,
  });

  return {
    symbol: sym,
    interval: intv,
    intervalMeta,
    years: safeYears,
    dataLoad: {
      source,
      totalCandles: allRows.length,
      byYear: yearStats,
    },
    analysis: { ...patternReport, supplementary },
    suggestedStrategy: suggested,
    optionSignals,
    meta: {
      durationMs: Date.now() - startedAt,
      disclaimer:
        'Patterns are descriptive statistics on historical data. High win rates on past data do not guarantee future results. Use walk-forward validation before live trading.',
      intervalNote: intervalMeta.note,
      researchIntent:
        'Built for intraday strategy design: use distributions, weekday/monthly bias, session splits, and pattern win rates — then validate with your own backtests and position size. No return target is implied.',
    },
  };
}

module.exports = {
  runMultiYearAnalysis,
  DEFAULT_YEARS,
};

const { getCandlesWithCache } = require('../services/dhanDataService');
const { buildIntradayByDay, buildDailyFromIntraday } = require('./candleGroups');
const { buildAllDayMetrics } = require('./dayMetrics');
const { computePatternStats } = require('./patternStats');
const { buildSuggestedStrategy } = require('./suggestedStrategy');
const { getIntervalMeta } = require('./intervalMeta');

const DEFAULT_YEARS = [2022, 2023, 2024, 2025, 2026];

async function loadMultiYearCandles({ symbol, interval, years }) {
  const yearStats = {};
  const allRows = [];
  for (const year of years) {
    const payload = await getCandlesWithCache({
      symbol,
      interval: String(interval),
      year: Number(year),
      refresh: false,
    });
    yearStats[year] = {
      candleCount: payload.rows.length,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
    };
    allRows.push(...payload.rows);
  }
  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { allRows, yearStats };
}

/**
 * @param {{ symbol: string, interval: string, years?: number[] }} opts
 */
async function runMultiYearAnalysis({ symbol, interval, years }) {
  const safeYears = (years?.length ? years : DEFAULT_YEARS).map(Number).filter(Number.isFinite);
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const intv = String(interval || '5');

  const startedAt = Date.now();
  const { allRows, yearStats } = await loadMultiYearCandles({
    symbol: sym,
    interval: intv,
    years: safeYears,
  });

  const intraByDay = buildIntradayByDay(allRows);
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const dayMetrics = buildAllDayMetrics(intraByDay, dailyMap);
  const intervalMeta = getIntervalMeta(intv);
  const patternReport = computePatternStats(dayMetrics);
  const suggested = buildSuggestedStrategy({
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
      totalCandles: allRows.length,
      byYear: yearStats,
    },
    analysis: patternReport,
    suggestedStrategy: suggested,
    meta: {
      durationMs: Date.now() - startedAt,
      disclaimer:
        'Patterns are descriptive statistics on historical data. High win rates on past data do not guarantee future results. Use walk-forward validation before live trading.',
      intervalNote: intervalMeta.note,
    },
  };
}

module.exports = {
  runMultiYearAnalysis,
  DEFAULT_YEARS,
};

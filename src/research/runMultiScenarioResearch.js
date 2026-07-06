/**
 * Multi-scenario pattern research — daily + intraday sequences × SL/TG configs.
 */

const { buildIntradayByDay, buildDailyFromIntraday } = require('../analysis/candleGroups');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../analysis/loadCandlesMultiYear');
const { getIntervalMeta } = require('../analysis/intervalMeta');
const { mineAllPatterns } = require('./sequenceMiner');
const { mineDailyPatterns } = require('./dailyPatternMiner');
const {
  rankPatterns,
  pickBestOverall,
  pickBestHighFrequency,
  pickBestWinRate,
  summarizeByCategory,
  filterHighVolume,
} = require('./patternRanking');

const OUTCOME_SCENARIOS = [
  { id: 'T10_S10_H6', targetPoints: 10, stopPoints: 10, horizonBars: 6 },
  { id: 'T15_S10_H6', targetPoints: 15, stopPoints: 10, horizonBars: 6 },
  { id: 'T20_S10_H6', targetPoints: 20, stopPoints: 10, horizonBars: 6 },
  { id: 'T15_S15_H8', targetPoints: 15, stopPoints: 15, horizonBars: 8 },
  { id: 'T20_S15_H8', targetPoints: 20, stopPoints: 15, horizonBars: 8 },
];

function mergePatternLists(...lists) {
  const all = lists.flat();
  return all.map((p) => ({
    ...p,
    category: p.category || p.context,
  }));
}

function annotateScenario(patterns, scenarioId) {
  return patterns.map((p) => ({
    ...p,
    scenarioId,
    id: `${p.id}__${scenarioId}`,
  }));
}

function dedupeBestPerRule(patterns) {
  const best = new Map();
  for (const p of patterns) {
    const key = `${p.ruleId || p.sequence}|${p.entrySlot || p.context}|${p.bestSide}|${p.scenarioId || ''}`;
    const prev = best.get(key);
    if (!prev || (p.score || 0) > (prev.score || 0)) best.set(key, p);
  }
  return Array.from(best.values());
}

/**
 * @param {object} opts
 */
async function runMultiScenarioResearch(opts = {}) {
  const symbol = String(opts.symbol || 'NIFTY').toUpperCase();
  const interval = String(opts.interval || '5');
  const years = (opts.years?.length ? opts.years : DEFAULT_YEARS).map(Number).filter(Number.isFinite);
  const minSamples = Math.max(25, Number(opts.minSamples) || 35);
  const barIntervalMinutes = Number(interval) || 5;
  const scenarios = opts.scenarios?.length ? opts.scenarios : OUTCOME_SCENARIOS;

  const startedAt = Date.now();
  const { allRows, yearStats, source } = await loadCandlesMultiYear({
    symbol,
    interval,
    years,
    preferApi: Boolean(opts.preferApi),
  });

  const intraByDay = buildIntradayByDay(allRows);
  const dailyMap = buildDailyFromIntraday(intraByDay);
  const tradingDays = dailyMap.size;

  let allPatterns = [];
  const scenarioSummaries = [];

  for (const scenario of scenarios) {
    const outcomeOpts = {
      ...scenario,
      barIntervalMinutes,
    };

    const daily = mineDailyPatterns({
      intraByDay,
      outcomeOpts,
      minSamples,
      barIntervalMinutes,
    });

    const sequences = mineAllPatterns({
      intraByDay,
      symbol,
      outcomeOpts,
      minSamples,
      sequenceLengths: [2, 3, 4],
    }).map((p) => ({ ...p, category: p.context }));

    const combined = annotateScenario(
      mergePatternLists(daily, sequences).map((p) => ({
        ...p,
        scenarioId: scenario.id,
      })),
      scenario.id,
    );

    const ranked = rankPatterns(combined, 'score');
    scenarioSummaries.push({
      scenarioId: scenario.id,
      targetPoints: scenario.targetPoints,
      stopPoints: scenario.stopPoints,
      horizonBars: scenario.horizonBars,
      patternsFound: ranked.length,
      tradeable: ranked.filter((p) => p.tradeable).length,
      bestOverall: ranked[0] || null,
      bestHighFrequency: pickBestHighFrequency(ranked, 52),
      bestWinRate: pickBestWinRate(ranked, 80),
    });

    allPatterns.push(...ranked);
  }

  allPatterns = rankPatterns(allPatterns, 'score');

  const highVolume = filterHighVolume(allPatterns, 150);
  const topByTrades = rankPatterns(
    allPatterns.filter((p) => (p.bestWinRate || 0) >= 52),
    'trades',
  ).slice(0, 20);

  const topByWinRate = rankPatterns(
    allPatterns.filter((p) => p.sampleSize >= 80),
    'winRate',
  ).slice(0, 20);

  const topByScore = allPatterns.slice(0, 25);
  const dailyTop = rankPatterns(
    allPatterns.filter((p) => p.category === 'daily_structure'),
    'score',
  ).slice(0, 15);

  const sequenceTop = rankPatterns(
    allPatterns.filter((p) => p.category !== 'daily_structure'),
    'score',
  ).slice(0, 15);

  const byCategory = summarizeByCategory(allPatterns);

  return {
    symbol,
    interval,
    years,
    intervalMeta: getIntervalMeta(interval),
    dataLoad: { source, totalCandles: allRows.length, byYear: yearStats },
    overview: { tradingDays, yearsSpan: years.length },
    scenarios: OUTCOME_SCENARIOS,
    scenarioSummaries,
    recommendations: {
      bestOverall: pickBestOverall(allPatterns),
      bestHighFrequency: pickBestHighFrequency(allPatterns, 52),
      bestWinRate: pickBestWinRate(allPatterns, 100),
      bestDaily: dailyTop[0] || null,
      bestSequence: sequenceTop[0] || null,
      note: 'bestOverall balances win rate, trade count, and year stability. bestHighFrequency favors more trades at ≥52% win rate.',
    },
    topByScore,
    topByTrades,
    topByWinRate,
    highVolumePatterns: highVolume.slice(0, 20),
    dailyTop,
    sequenceTop,
    byCategory,
    meta: {
      durationMs: Date.now() - startedAt,
      totalPatternsScored: allPatterns.length,
      disclaimer:
        'Multi-scenario mining on historical data. Validate top patterns with walk-forward before live trading.',
    },
  };
}

module.exports = {
  runMultiScenarioResearch,
  OUTCOME_SCENARIOS,
};

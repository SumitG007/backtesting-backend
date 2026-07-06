/**
 * Pattern research engine — scan 2022+ candles for recurring sequence edges.
 */

const { buildIntradayByDay } = require('../analysis/candleGroups');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../analysis/loadCandlesMultiYear');
const { getIntervalMeta } = require('../analysis/intervalMeta');
const { mineAllPatterns, DEFAULT_MIN_SAMPLES } = require('./sequenceMiner');

const DEFAULT_OUTCOME = {
  targetPoints: 15,
  stopPoints: 10,
  horizonBars: 6,
  barIntervalMinutes: 5,
};

function buildOverview(intraByDay, years) {
  let tradingDays = 0;
  let totalBars = 0;
  const byYear = {};

  for (const [dayKey, bars] of intraByDay) {
    const y = Number(dayKey.slice(0, 4));
    if (!years.includes(y)) continue;
    tradingDays += 1;
    totalBars += bars.length;
    byYear[y] = (byYear[y] || 0) + 1;
  }

  return { tradingDays, totalBars, byYear };
}

function rankTopPatterns(patterns, limit = 25) {
  return patterns.slice(0, limit);
}

function summarizeTradeable(patterns) {
  return patterns.filter((p) => p.tradeable);
}

/**
 * @param {{
 *   symbol?: string,
 *   interval?: string,
 *   years?: number[],
 *   preferApi?: boolean,
 *   minSamples?: number,
 *   sequenceLengths?: number[],
 *   outcome?: Partial<typeof DEFAULT_OUTCOME>,
 *   topN?: number,
 * }} opts
 */
async function runPatternResearch(opts = {}) {
  const symbol = String(opts.symbol || 'NIFTY').toUpperCase();
  const interval = String(opts.interval || '5');
  const years = (opts.years?.length ? opts.years : DEFAULT_YEARS).map(Number).filter(Number.isFinite);
  const minSamples = Math.max(20, Number(opts.minSamples) || DEFAULT_MIN_SAMPLES);
  const sequenceLengths = opts.sequenceLengths?.length ? opts.sequenceLengths : [2, 3, 4];
  const topN = Math.max(5, Number(opts.topN) || 25);

  const outcomeOpts = {
    ...DEFAULT_OUTCOME,
    ...(opts.outcome || {}),
    barIntervalMinutes: Number(opts.outcome?.barIntervalMinutes) || Number(interval) || 5,
  };

  const startedAt = Date.now();
  const { allRows, yearStats, source } = await loadCandlesMultiYear({
    symbol,
    interval,
    years,
    preferApi: Boolean(opts.preferApi),
  });

  const intraByDay = buildIntradayByDay(allRows);
  const overview = buildOverview(intraByDay, years);
  const patterns = mineAllPatterns({
    intraByDay,
    symbol,
    outcomeOpts,
    minSamples,
    sequenceLengths,
  });

  const tradeable = summarizeTradeable(patterns);
  const topPatterns = rankTopPatterns(patterns, topN);
  const topTradeable = rankTopPatterns(tradeable, Math.min(15, topN));

  const sessionPrefix = patterns.filter((p) => p.context === 'session_prefix').slice(0, 10);
  const dirPrefix = patterns.filter((p) => p.context === 'dir_prefix').slice(0, 10);
  const slidingMorning = patterns.filter((p) => p.context === 'sliding_morning').slice(0, 10);

  return {
    symbol,
    interval,
    years,
    intervalMeta: getIntervalMeta(interval),
    dataLoad: {
      source,
      totalCandles: allRows.length,
      byYear: yearStats,
    },
    overview,
    researchConfig: {
      minSamples,
      sequenceLengths,
      outcome: outcomeOpts,
      encoding:
        'Each bar → dir(U/D/F) + size(S/M/L) + closePos(L/M/H). Sequences joined with >. Entry = next bar open.',
    },
    summary: {
      patternsFound: patterns.length,
      tradeablePatterns: tradeable.length,
      bestPattern: topPatterns[0] || null,
      bestTradeable: topTradeable[0] || null,
    },
    topPatterns,
    topTradeable,
    byCategory: {
      sessionPrefix,
      dirPrefix,
      slidingMorning,
    },
    meta: {
      durationMs: Date.now() - startedAt,
      disclaimer:
        'Historical pattern mining only. High win rates on past data do not guarantee future results. Validate with walk-forward tests before live trading.',
      liveWorkflow:
        'Wait for sequence to form → verify match → enter on next bar open → use reported best side (CE/PE) with configured SL/target.',
    },
  };
}

module.exports = {
  runPatternResearch,
  DEFAULT_OUTCOME,
  DEFAULT_YEARS,
};

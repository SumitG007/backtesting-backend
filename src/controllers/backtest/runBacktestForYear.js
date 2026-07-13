const { fetchWithRateLimitRetry, fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { STRATEGY_SEVEN_KEY, STRATEGY_NINE_KEY } = require('../../strategies/keys');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');
const {
  filterTradesByMaxLossesPerSidePerDay,
  parseMaxLossesPerSidePerDay,
} = require('../../strategies/strategy9/trailScalpSideLockout');

/**
 * Run a single calendar year exactly like each strategy's /run path so validation matches.
 * @param {string} strategyKey
 * @returns {(year: number, settings: Record<string, unknown>) => Promise<{ trades: unknown[], summary?: unknown }>}
 */
function createRunBacktestForYear(strategyKey) {
  return async (year, settings) => {
    if (strategyKey === STRATEGY_SEVEN_KEY || strategyKey === STRATEGY_NINE_KEY) {
      const payload = await fetchYearCandlesByDayCached({
        symbol: settings.symbol,
        interval: settings.interval,
        year,
      });

      const result = await runBacktestInWorker(strategyKey, {
        candles: payload.rows,
        settings,
      });

      const enriched = await enrichStrategySevenTradesWithRealPremiums({
        trades: result.trades,
        settings,
      });
      const trades =
        strategyKey === STRATEGY_NINE_KEY
          ? filterTradesByMaxLossesPerSidePerDay(enriched.trades, settings)
          : enriched.trades;
      const putTrades = trades.filter((t) => String(t.type || '').toUpperCase() !== 'CE').length;
      const callTrades = trades.filter((t) => String(t.type || '').toUpperCase() === 'CE').length;
      const realPremiumTrades = trades.filter((t) => t.premiumSource === 'REAL').length;
      const modelPremiumTrades = trades.length - realPremiumTrades;
      const summary = {
        ...buildStrategyRunSummary(trades),
        skippedDays: result.summary?.skippedDays,
        minDirectionScore: result.summary?.minDirectionScore,
        putTrades: strategyKey === STRATEGY_NINE_KEY ? putTrades : result.summary?.putTrades,
        callTrades: strategyKey === STRATEGY_NINE_KEY ? callTrades : result.summary?.callTrades,
        signalCounts: result.summary?.signalCounts,
        maxTradesPerDay: result.summary?.maxTradesPerDay,
        maxLossesPerSidePerDay:
          strategyKey === STRATEGY_NINE_KEY
            ? parseMaxLossesPerSidePerDay(settings)
            : result.summary?.maxLossesPerSidePerDay,
        stopLossPoints: result.summary?.stopLossPoints,
        targetProfitPoints: result.summary?.targetProfitPoints,
        entryFromTime: result.summary?.entryFromTime,
        entryToTime: result.summary?.entryToTime,
        eodExitTime: result.summary?.eodExitTime,
        trailingTargetEnabled: result.summary?.trailingTargetEnabled,
        trailingStepPoints: result.summary?.trailingStepPoints,
        trailingActivationPoints: result.summary?.trailingActivationPoints,
        realPremiumTrades: strategyKey === STRATEGY_NINE_KEY ? realPremiumTrades : enriched.realCount,
        modelPremiumTrades: strategyKey === STRATEGY_NINE_KEY ? modelPremiumTrades : enriched.modelCount,
      };
      return { trades, summary };
    }

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: settings.interval,
      year,
    });
    return runBacktestInWorker(strategyKey, {
      candles: payload.rows,
      settings,
    });
  };
}

module.exports = { createRunBacktestForYear };

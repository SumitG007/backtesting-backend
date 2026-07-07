const { fetchWithRateLimitRetry, fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { STRATEGY_SEVEN_KEY } = require('../../strategies/keys');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');

/**
 * Run a single calendar year exactly like each strategy's /run path so validation matches.
 * @param {string} strategyKey
 * @returns {(year: number, settings: Record<string, unknown>) => Promise<{ trades: unknown[], summary?: unknown }>}
 */
function createRunBacktestForYear(strategyKey) {
  return async (year, settings) => {
    if (strategyKey === STRATEGY_SEVEN_KEY) {
      // Keep validation identical to Strategy 3 /run for every year.
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
      const trades = enriched.trades;
      const summary = {
        ...buildStrategyRunSummary(trades),
        skippedDays: result.summary?.skippedDays,
        minDirectionScore: result.summary?.minDirectionScore,
        putTrades: result.summary?.putTrades,
        callTrades: result.summary?.callTrades,
        signalCounts: result.summary?.signalCounts,
        realPremiumTrades: enriched.realCount,
        modelPremiumTrades: enriched.modelCount,
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

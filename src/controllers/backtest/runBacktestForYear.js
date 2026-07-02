const {
  fetchWithRateLimitRetry,
  fetchYearCandlesByDayCached,
} = require('../../services/dhanDataService');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { STRATEGY_SEVEN_KEY, STRATEGY_NINE_KEY } = require('../../strategies/keys');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');

/**
 * Run a single calendar year exactly like the /run path so the validation report matches it.
 *
 * Strategy 3 (put & call) is data-source sensitive:
 *  - CURRENT year  → per-day candles (live-parity open) + REAL option premiums, identical to /run.
 *  - PAST years    → fast bulk fetch + modeled premiums. Historical option contracts are gone from
 *                    the instrument master (can't fetch real premiums) and per-day fetching 4+ years
 *                    would make the report extremely slow, so those stay on the modeled path.
 * @param {string} strategyKey
 * @returns {(year: number, settings: Record<string, unknown>) => Promise<{ trades: unknown[], summary?: unknown }>}
 */
function createRunBacktestForYear(strategyKey) {
  return async (year, settings) => {
    const currentYear = new Date().getFullYear();
    const liveParity =
      (strategyKey === STRATEGY_SEVEN_KEY || strategyKey === STRATEGY_NINE_KEY) &&
      Number(year) === currentYear;

    const payload = liveParity
      ? await fetchYearCandlesByDayCached({ symbol: settings.symbol, interval: settings.interval, year })
      : await fetchWithRateLimitRetry({ symbol: settings.symbol, interval: settings.interval, year });

    const result = await runBacktestInWorker(strategyKey, {
      candles: payload.rows,
      settings,
    });

    if (!liveParity) return result;

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
      realPremiumTrades: enriched.realCount,
      modelPremiumTrades: enriched.modelCount,
    };
    if (strategyKey === STRATEGY_NINE_KEY) {
      delete summary.minDirectionScore;
      delete summary.callTrades;
    }
    return { trades, summary };
  };
}

module.exports = { createRunBacktestForYear };

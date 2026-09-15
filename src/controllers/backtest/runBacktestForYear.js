const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');

/**
 * Run a single calendar year exactly like each strategy's /run path so validation matches.
 * @param {string} strategyKey
 * @returns {(year: number, settings: Record<string, unknown>) => Promise<{ trades: unknown[], summary?: unknown }>}
 */
function createRunBacktestForYear(strategyKey) {
  return async (year, settings) => {
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

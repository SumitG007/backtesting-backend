const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { STRATEGY_ONE_KEY } = require('../../strategies/keys');

/**
 * Same candle fetch + worker invoke as single-year run, for one calendar year.
 * @param {string} strategyKey
 * @returns {(year: number, settings: Record<string, unknown>) => Promise<{ trades: unknown[], summary?: unknown }>}
 */
function createRunBacktestForYear(strategyKey) {
  if (strategyKey === STRATEGY_ONE_KEY) {
    return async (year, settings) => {
      const symbol = settings.symbol;
      const interval = String(settings.interval);
      const [dailyPayload, execPayload] = await Promise.all([
        fetchWithRateLimitRetry({ symbol, interval: '1', year }),
        fetchWithRateLimitRetry({ symbol, interval, year }),
      ]);
      return runBacktestInWorker(STRATEGY_ONE_KEY, {
        dailyCandles: dailyPayload.rows,
        execCandles: execPayload.rows,
        settings,
      });
    };
  }

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

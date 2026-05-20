/**
 * Run CPU-heavy backtest logic off the main thread so /api/health and live engine keep responding.
 */
const { parentPort, workerData } = require('worker_threads');

function run() {
  const { strategyKey, payload } = workerData || {};
  if (strategyKey === 'strategy1_prev_day_close_retest') {
    const { runStrategyOneBacktest } = require('../strategies/strategy1/backtest');
    return runStrategyOneBacktest(payload);
  }
  if (strategyKey === 'strategy3_short_straddle') {
    const { runStrategyShortStraddle } = require('../strategies/strategy2/shortStraddleBacktest');
    return runStrategyShortStraddle(payload);
  }
  if (strategyKey === 'strategy3_option_chain_oi_direction') {
    const { runStrategyThreeBacktest } = require('../strategies/strategy3/backtest');
    return runStrategyThreeBacktest(payload);
  }
  const { runIntradayTierBacktest } = require('../strategies/intradayTier/backtest');
  const INTRADAY_TIER_VARIANT = {
    strategy4_first_hour_pe_ce: 'first_hour_pe_ce',
  };
  const variant = INTRADAY_TIER_VARIANT[strategyKey];
  if (variant) {
    return runIntradayTierBacktest({ ...payload, variant });
  }
  if (strategyKey === 'strategy5_iv_mean_reversion') {
    const { runIvMeanReversionBacktest } = require('../strategies/strategy5/ivMeanReversionBacktest');
    return runIvMeanReversionBacktest(payload);
  }
  throw new Error(`Unknown backtest worker key: ${strategyKey}`);
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || String(error) });
}

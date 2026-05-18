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
  throw new Error(`Unknown backtest worker key: ${strategyKey}`);
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || String(error) });
}

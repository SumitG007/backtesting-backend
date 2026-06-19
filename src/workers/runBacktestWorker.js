/**
 * Run CPU-heavy backtest logic off the main thread so /api/health and live engine keep responding.
 */
const { parentPort, workerData } = require('worker_threads');

function run() {
  const { strategyKey, payload } = workerData || {};
  const { runIntradayTierBacktest } = require('../strategies/intradayTier/backtest');
  if (strategyKey === 'strategy6_short_straddle_next_day') {
    return runIntradayTierBacktest({ ...payload, variant: 'short_straddle_next_day' });
  }
  if (strategyKey === 'strategy5_iv_mean_reversion') {
    const { runIvMeanReversionBacktest } = require('../strategies/strategy5/ivMeanReversionBacktest');
    return runIvMeanReversionBacktest(payload);
  }
  if (strategyKey === 'strategy7_simple_920_market') {
    const { runSimple920Backtest } = require('../strategies/strategy7/simple920Backtest');
    return runSimple920Backtest(payload);
  }
  if (strategyKey === 'strategy8_heikin_ashi') {
    const { runHeikinAshiBacktest } = require('../strategies/strategy8/heikinAshiBacktest');
    return runHeikinAshiBacktest(payload);
  }

  throw new Error(`Unknown backtest worker key: ${strategyKey}`);
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || String(error) });
}

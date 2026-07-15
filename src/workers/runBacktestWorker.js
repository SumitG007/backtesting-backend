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
  if (strategyKey === 'strategy7_simple_920_market') {
    const { runSimple920Backtest } = require('../strategies/strategy7/simple920Backtest');
    return runSimple920Backtest(payload);
  }
  if (strategyKey === 'strategy9_one_side_candle_scalp') {
    const { runOneSideCandleScalpBacktest } = require('../strategies/strategy9/oneSideCandleScalpBacktest');
    return runOneSideCandleScalpBacktest(payload);
  }
  if (strategyKey === 'strategy11_sl_flip') {
    const { runSlFlipBacktest } = require('../strategies/strategy11/slFlipBacktest');
    return runSlFlipBacktest(payload);
  }

  throw new Error(`Unknown backtest worker key: ${strategyKey}`);
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || String(error) });
}

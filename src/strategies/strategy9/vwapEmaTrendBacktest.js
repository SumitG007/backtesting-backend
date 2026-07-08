/**
 * Strategy 5 (UI) — VWAP + EMA trend scalper (long CE/PE, premium SL/target).
 */

const { runIntradaySignalBacktest } = require('../shared/intradayBacktestRunner');
const { makeVwapEmaTrendFindSignal } = require('./vwapEmaTrendLogic');

function runVwapEmaTrendBacktest({ candles, settings }) {
  // With EMA "early" calculation, we can start scanning near the session open.
  // Keep a small warmup just to avoid any malformed early bars.
  const minWarmup = Math.max(3, Number(settings?.minWarmup) || 3);
  const normalized = {
    ...settings,
    // Enable index-structure exits (stopIndex/targetIndex) when the signal provides them.
    usePatternExits: true,
  };
  return runIntradaySignalBacktest({
    execCandles: candles,
    settings: normalized,
    minWarmup,
    findSignal: makeVwapEmaTrendFindSignal(),
  });
}

module.exports = { runVwapEmaTrendBacktest };

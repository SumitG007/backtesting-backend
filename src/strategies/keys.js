/**
 * MongoDB `strategyKey` values — keep stable so old runs and live trades stay readable.
 *
 * Strategy 1 — user-defined (new). Logic lives under `strategies/strategy1/`.
 * Strategy 2 — short straddle BTST. Logic lives under `strategies/strategy2/`.
 */

/** @type {string} Strategy 1 — previous day close retest (see `strategy1/backtest.js`) */
const STRATEGY_ONE_KEY = 'strategy1_prev_day_close_retest';

/** @type {string} Short straddle overnight hold (see strategy2/) */
const STRATEGY_TWO_KEY = 'strategy3_short_straddle';

module.exports = {
  STRATEGY_ONE_KEY,
  STRATEGY_TWO_KEY,
};

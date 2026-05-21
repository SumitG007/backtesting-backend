/**
 * MongoDB `strategyKey` values — keep stable so old runs and live trades stay readable.
 *
 * Strategy 1 — previous day close retest.
 * Strategy 2 — short straddle.
 * Strategy 3 — option chain OI direction.
 * Strategy 4 — first-hour vs open: PE or CE, entry ≥10:00, premium SL/target (intradayTier).
 * Strategy 5 — IV mean reversion: short straddle when OR IV spikes; IV-specific exits.
 * Strategy 6 — rising wedge breakdown (see `strategies/catalog.js`).
 */

/** @type {string} Strategy 1 — previous day close retest (see `strategy1/backtest.js`) */
const STRATEGY_ONE_KEY = 'strategy1_prev_day_close_retest';

/** @type {string} Short straddle overnight hold (see strategy2/) */
const STRATEGY_TWO_KEY = 'strategy3_short_straddle';

/** @type {string} Option chain OI direction — backtest (see strategy3/backtest.js) */
const STRATEGY_THREE_KEY = 'strategy3_option_chain_oi_direction';

/** @type {string} Strategy 4 — First hour vs open: PE if bearish, CE if bullish (one trade/day) */
const STRATEGY_FOUR_KEY = 'strategy4_first_hour_pe_ce';

/** @type {string} Strategy 5 — IV mean reversion short straddle (intraday) */
const STRATEGY_FIVE_KEY = 'strategy5_iv_mean_reversion';

const { STRATEGY_SIX_KEY, STRATEGY_SEVEN_KEY } = require('./catalog');

module.exports = {
  STRATEGY_ONE_KEY,
  STRATEGY_TWO_KEY,
  STRATEGY_THREE_KEY,
  STRATEGY_FOUR_KEY,
  STRATEGY_FIVE_KEY,
  STRATEGY_SIX_KEY,
  STRATEGY_SEVEN_KEY,
};

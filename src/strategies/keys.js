/**
 * MongoDB `strategyKey` values — keep stable so old runs stay readable.
 */

const STRATEGY_ONE_KEY = 'strategy1_prev_day_close_retest';
const STRATEGY_FOUR_KEY = 'strategy4_first_hour_pe_ce';
const STRATEGY_FIVE_KEY = 'strategy5_iv_mean_reversion';
const { STRATEGY_FOUR_KEY: STRATEGY_SIX_KEY, STRATEGY_FIVE_KUKKI_KEY } = require('./catalog');

module.exports = {
  STRATEGY_ONE_KEY,
  STRATEGY_FOUR_KEY,
  STRATEGY_FIVE_KEY,
  STRATEGY_SIX_KEY,
  STRATEGY_FIVE_KUKKI_KEY,
};

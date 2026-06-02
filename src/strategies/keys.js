/**
 * MongoDB `strategyKey` values — keep stable so old runs stay readable.
 */

const STRATEGY_ONE_KEY = 'strategy1_prev_day_close_retest';
const STRATEGY_FOUR_KEY = 'strategy4_first_hour_pe_ce';
const STRATEGY_FIVE_KEY = 'strategy5_iv_mean_reversion';
const STRATEGY_SIX_KEY = 'strategy6_short_straddle_next_day';
const STRATEGY_THREE_IV_LIVE_KEY = 'strategy3_iv_mean_reversion_live';
const STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY = 'strategy4_short_straddle_next_day_live';
const STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY = 'strategy6_short_straddle_next_day_live';

module.exports = {
  STRATEGY_ONE_KEY,
  STRATEGY_FOUR_KEY,
  STRATEGY_FIVE_KEY,
  STRATEGY_SIX_KEY,
  STRATEGY_THREE_IV_LIVE_KEY,
  STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
};

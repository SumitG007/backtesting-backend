/**
 * MongoDB `strategyKey` values — keep stable so old runs stay readable.
 */

const STRATEGY_SIX_KEY = 'strategy6_short_straddle_next_day';
/** Legacy alias — Results/tradeQueries default still imports STRATEGY_TWO_KEY. */
const STRATEGY_TWO_KEY = STRATEGY_SIX_KEY;
const STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY = 'strategy6_short_straddle_next_day_live';
const STRATEGY_FOURTEEN_EOD_OI_WALLS_LIVE_KEY = 'strategy14_eod_oi_walls_live';
const MANUAL_CONSOLE_LIVE_KEY = 'manual_console_live';
/** OI Wall Scalp paper — auto scalp (separate wallet/book). */
const MANUAL_OI_AUTO_LIVE_KEY = 'manual_oi_auto_live';
/** OI Flow Tracker signal store key (paper auto-trade removed). */
const OI_FLOW_TRACKER_LIVE_KEY = 'oi_flow_tracker_live';

module.exports = {
  STRATEGY_SIX_KEY,
  STRATEGY_TWO_KEY,
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_FOURTEEN_EOD_OI_WALLS_LIVE_KEY,
  MANUAL_CONSOLE_LIVE_KEY,
  MANUAL_OI_AUTO_LIVE_KEY,
  OI_FLOW_TRACKER_LIVE_KEY,
};

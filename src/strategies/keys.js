/**
 * MongoDB `strategyKey` values — keep stable so old runs stay readable.
 */

const STRATEGY_SIX_KEY = 'strategy6_short_straddle_next_day';
const STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY = 'strategy4_short_straddle_next_day_live';
const STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY = 'strategy6_short_straddle_next_day_live';
const STRATEGY_TWELVE_MORNING_OI_LIVE_KEY = 'strategy12_morning_oi_live';
const STRATEGY_TWELVE_MORNING_OI_MULTI_LIVE_KEY = 'strategy12_morning_oi_multi_live';
const STRATEGY_FOURTEEN_EOD_OI_WALLS_LIVE_KEY = 'strategy14_eod_oi_walls_live';
const MANUAL_CONSOLE_LIVE_KEY = 'manual_console_live';
/** Manual Console Live Signal Console — auto scalp (separate wallet/book). */
const MANUAL_OI_AUTO_LIVE_KEY = 'manual_oi_auto_live';

module.exports = {
  STRATEGY_SIX_KEY,
  STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_TWELVE_MORNING_OI_LIVE_KEY,
  STRATEGY_TWELVE_MORNING_OI_MULTI_LIVE_KEY,
  STRATEGY_FOURTEEN_EOD_OI_WALLS_LIVE_KEY,
  MANUAL_CONSOLE_LIVE_KEY,
  MANUAL_OI_AUTO_LIVE_KEY,
};

/**
 * Entry fill rules for Trail Scalp Put/Call — signal on last completed bar.
 */

const { buildIstWallClockTimestamp } = require('../../utils/dateTime');

/**
 * Signal bar = last completed candle at entry clock.
 * Entry fill = signal close (default) or next bar open.
 */
function resolveEntryFill({
  settings,
  entryDecision,
  dayBars,
  dayKey,
  entryDecisionMinutes,
}) {
  const fillMode = String(settings.entryFillMode || 'signal_close').trim();
  const signalBarIdx = entryDecision.entryIdx;

  if (fillMode !== 'next_bar_open') {
    const entrySpot = Number(dayBars[signalBarIdx][4]);
    return {
      skip: false,
      entryIdx: signalBarIdx,
      entrySpot,
      entryTimeIso: new Date(buildIstWallClockTimestamp(dayKey, entryDecisionMinutes)).toISOString(),
    };
  }

  const entryIdx = signalBarIdx + 1;
  if (entryIdx >= dayBars.length) {
    return { skip: true, skipReason: 'no_entry_bar_after_signal' };
  }

  const entrySpot = Number(dayBars[entryIdx][1]);
  if (!Number.isFinite(entrySpot) || entrySpot <= 0) {
    return { skip: true, skipReason: 'invalid_entry_open' };
  }

  return {
    skip: false,
    entryIdx,
    entrySpot,
    entryTimeIso: new Date(dayBars[entryIdx][0]).toISOString(),
    signalBarIdx,
  };
}

module.exports = { resolveEntryFill };

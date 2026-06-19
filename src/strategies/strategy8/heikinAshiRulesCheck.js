/**
 * Maps each user rule to HA-only checks — used by tests and audits.
 */

const {
  findHeikinAshiSignal,
  findCeStopIndex,
  findPeStopIndex,
  isInsideBar,
  haColor,
} = require('./heikinAshiLogic');
const { isHeikinAshiBullish, isHeikinAshiBearish } = require('../shared/indicators');

function barHigh(bar) {
  return Number(bar[2]);
}

function barLow(bar) {
  return Number(bar[3]);
}

function checkCeRules(haBars, patternIdx) {
  const prevIdx = patternIdx - 1;
  const runIdx = patternIdx + 1;
  if (patternIdx < 1 || runIdx >= haBars.length) {
    return { ok: false, failReason: 'NOT_ENOUGH_BARS' };
  }

  const prevBar = haBars[prevIdx];
  const signalBar = haBars[patternIdx];
  const runBar = haBars[runIdx];

  if (!isHeikinAshiBearish(prevBar)) {
    return { ok: false, failReason: 'PREV_NOT_RED' };
  }
  if (!isHeikinAshiBullish(signalBar)) {
    return { ok: false, failReason: 'SIGNAL_NOT_GREEN' };
  }

  const triggerHigh = barHigh(signalBar);
  const runHigh = barHigh(runBar);
  if (!Number.isFinite(runHigh) || runHigh <= triggerHigh) {
    return { ok: false, failReason: 'NO_BREAKOUT_ABOVE_GREEN_HIGH' };
  }

  const stopIndex = findCeStopIndex(haBars, patternIdx);
  if (stopIndex == null) {
    return { ok: false, failReason: 'NO_VALID_RED_SL' };
  }

  return {
    ok: true,
    optionType: 'CE',
    patternIdx,
    prevIdx,
    entryIdx: runIdx,
    entrySpot: triggerHigh,
    stopIndex,
    signalColor: haColor(signalBar),
    prevColor: haColor(prevBar),
  };
}

function checkPeRules(haBars, patternIdx) {
  const prevIdx = patternIdx - 1;
  const runIdx = patternIdx + 1;
  if (patternIdx < 1 || runIdx >= haBars.length) {
    return { ok: false, failReason: 'NOT_ENOUGH_BARS' };
  }

  const prevBar = haBars[prevIdx];
  const signalBar = haBars[patternIdx];
  const runBar = haBars[runIdx];

  if (!isHeikinAshiBullish(prevBar)) {
    return { ok: false, failReason: 'PREV_NOT_GREEN' };
  }
  if (!isHeikinAshiBearish(signalBar)) {
    return { ok: false, failReason: 'SIGNAL_NOT_RED' };
  }

  const triggerLow = barLow(signalBar);
  const runLow = barLow(runBar);
  if (!Number.isFinite(runLow) || runLow >= triggerLow) {
    return { ok: false, failReason: 'NO_BREAKDOWN_BELOW_RED_LOW' };
  }

  const stopIndex = findPeStopIndex(haBars, patternIdx);
  if (stopIndex == null) {
    return { ok: false, failReason: 'NO_VALID_GREEN_SL' };
  }

  return {
    ok: true,
    optionType: 'PE',
    patternIdx,
    prevIdx,
    entryIdx: runIdx,
    entrySpot: triggerLow,
    stopIndex,
    signalColor: haColor(signalBar),
    prevColor: haColor(prevBar),
  };
}

function signalMatchesRules(haBars, signal) {
  if (!signal) return false;
  const check =
    signal.optionType === 'CE'
      ? checkCeRules(haBars, signal.patternIdx)
      : checkPeRules(haBars, signal.patternIdx);
  if (!check.ok) return false;
  return (
    findHeikinAshiSignal(haBars, signal.patternIdx)?.optionType === signal.optionType &&
    check.entrySpot === signal.entrySpot &&
    check.stopIndex === signal.stopIndex
  );
}

module.exports = {
  checkCeRules,
  checkPeRules,
  signalMatchesRules,
  isInsideBar,
};

/**
 * Heikin Ashi pattern signals — CE (call) and PE (put) entries.
 * All pattern, breakout, entry, and SL levels use HA OHLC only.
 */

const { isHeikinAshiBullish, isHeikinAshiBearish } = require('../shared/indicators');
const { getOptionPremiumFromSpotMove } = require('../../utils/market');
const { premiumSideForLongOption } = require('../shared/intradayOptions');

function barOpen(bar) {
  return Number(bar[1]);
}

function barHigh(bar) {
  return Number(bar[2]);
}

function barLow(bar) {
  return Number(bar[3]);
}

function barClose(bar) {
  return Number(bar[4]);
}

function haColor(bar) {
  if (isHeikinAshiBullish(bar)) return 'GREEN';
  if (isHeikinAshiBearish(bar)) return 'RED';
  return 'DOJI';
}

function isInsideBar(innerBar, outerHigh, outerLow) {
  const hi = barHigh(innerBar);
  const lo = barLow(innerBar);
  if (![hi, lo, outerHigh, outerLow].every(Number.isFinite)) return false;
  return hi <= outerHigh && lo >= outerLow;
}

/** Up to `maxCount` most-recent HA bars of `colorFn` strictly before `beforeIdx`. */
function collectColorIndices(haBars, beforeIdx, colorFn, maxCount) {
  const out = [];
  for (let j = beforeIdx - 1; j >= 0 && out.length < maxCount; j -= 1) {
    if (colorFn(haBars[j])) out.push(j);
  }
  return out;
}

function findCeStopIndex(haBars, greenIdx) {
  const outerHigh = barHigh(haBars[greenIdx]);
  const outerLow = barLow(haBars[greenIdx]);
  const redIndices = collectColorIndices(haBars, greenIdx, isHeikinAshiBearish, 2);
  for (const idx of redIndices) {
    if (!isInsideBar(haBars[idx], outerHigh, outerLow)) {
      return barLow(haBars[idx]);
    }
  }
  return null;
}

function findPeStopIndex(haBars, redIdx) {
  const outerHigh = barHigh(haBars[redIdx]);
  const outerLow = barLow(haBars[redIdx]);
  const greenIndices = collectColorIndices(haBars, redIdx, isHeikinAshiBullish, 2);
  for (const idx of greenIndices) {
    if (!isInsideBar(haBars[idx], outerHigh, outerLow)) {
      return barHigh(haBars[idx]);
    }
  }
  return null;
}

/**
 * Pattern on completed HA bar `patternIdx` (prev = patternIdx - 1).
 * Breakout/breakdown confirmed on HA OHLC of bar `patternIdx + 1`.
 */
function findHeikinAshiSignal(haBars, patternIdx) {
  if (!Array.isArray(haBars)) return null;
  if (patternIdx < 1 || patternIdx + 1 >= haBars.length) return null;

  const prevIdx = patternIdx - 1;
  const entryIdx = patternIdx + 1;
  const signalBar = haBars[patternIdx];
  const prevBar = haBars[prevIdx];
  const entryBar = haBars[entryIdx];

  if (!signalBar || !prevBar || !entryBar) return null;

  const runHigh = barHigh(entryBar);
  const runLow = barLow(entryBar);
  if (!Number.isFinite(runHigh) || !Number.isFinite(runLow)) return null;

  if (isHeikinAshiBullish(signalBar) && isHeikinAshiBearish(prevBar)) {
    const triggerHigh = barHigh(signalBar);
    if (!Number.isFinite(triggerHigh) || runHigh <= triggerHigh) return null;

    const stopIndex = findCeStopIndex(haBars, patternIdx);
    if (stopIndex == null || !Number.isFinite(stopIndex)) return null;

    return {
      optionType: 'CE',
      patternIdx,
      prevIdx,
      entryIdx,
      entrySpot: triggerHigh,
      stopIndex,
      reason: 'HA_CE_BREAKOUT',
      triggerLevel: triggerHigh,
      signalColor: 'GREEN',
      prevColor: 'RED',
    };
  }

  if (isHeikinAshiBearish(signalBar) && isHeikinAshiBullish(prevBar)) {
    const triggerLow = barLow(signalBar);
    if (!Number.isFinite(triggerLow) || runLow >= triggerLow) return null;

    const stopIndex = findPeStopIndex(haBars, patternIdx);
    if (stopIndex == null || !Number.isFinite(stopIndex)) return null;

    return {
      optionType: 'PE',
      patternIdx,
      prevIdx,
      entryIdx,
      entrySpot: triggerLow,
      stopIndex,
      reason: 'HA_PE_BREAKDOWN',
      triggerLevel: triggerLow,
      signalColor: 'RED',
      prevColor: 'GREEN',
    };
  }

  return null;
}

function validateHeikinAshiSignal(haBars, signal) {
  if (!signal) return false;
  const replay = findHeikinAshiSignal(haBars, signal.patternIdx);
  if (!replay) return false;
  return (
    replay.optionType === signal.optionType &&
    replay.entryIdx === signal.entryIdx &&
    replay.entrySpot === signal.entrySpot &&
    replay.stopIndex === signal.stopIndex &&
    replay.reason === signal.reason
  );
}

function computePatternSlPremium({
  optionType,
  entrySpot,
  entryPremium,
  stopIndex,
  strike,
  strikeStep,
  premiumLeverage,
}) {
  if (!Number.isFinite(stopIndex)) return null;
  const prem = getOptionPremiumFromSpotMove({
    side: premiumSideForLongOption(optionType),
    entrySpot,
    currentSpot: stopIndex,
    entryPremium,
    premiumLeverage,
    strike,
    strikeStep,
  });
  return Number(Math.max(0.05, prem).toFixed(2));
}

function buildSignalAudit(haBars, signal, optionCtx = {}) {
  const patternIdx = signal.patternIdx;
  const prevIdx = signal.prevIdx;
  const entryIdx = signal.entryIdx;
  const signalHa = haBars[patternIdx];
  const prevHa = haBars[prevIdx];
  const entryHa = haBars[entryIdx];

  return {
    signal: signal.reason,
    patternStopIndex: Number(signal.stopIndex.toFixed(2)),
    patternSlPremium: computePatternSlPremium({
      optionType: signal.optionType,
      entrySpot: optionCtx.entrySpot,
      entryPremium: optionCtx.entryPremium,
      stopIndex: signal.stopIndex,
      strike: optionCtx.strike,
      strikeStep: optionCtx.strikeStep,
      premiumLeverage: optionCtx.premiumLeverage,
    }),
    triggerLevel: Number(signal.triggerLevel.toFixed(2)),
    patternBarTime: signalHa[0],
    prevBarTime: prevHa[0],
    entryBarTime: entryHa[0],
    signalHaColor: haColor(signalHa),
    prevHaColor: haColor(prevHa),
    entryHaColor: haColor(entryHa),
    signalHaOpen: Number(barOpen(signalHa).toFixed(2)),
    signalHaClose: Number(barClose(signalHa).toFixed(2)),
    prevHaOpen: Number(barOpen(prevHa).toFixed(2)),
    prevHaClose: Number(barClose(prevHa).toFixed(2)),
    entryHaHigh: Number(barHigh(entryHa).toFixed(2)),
    entryHaLow: Number(barLow(entryHa).toFixed(2)),
  };
}

function assertSignalHaColors(signal, haBars) {
  if (!signal || !haBars?.[signal.patternIdx] || !haBars?.[signal.prevIdx]) return false;
  const signalColor = haColor(haBars[signal.patternIdx]);
  const prevColor = haColor(haBars[signal.prevIdx]);
  if (signal.optionType === 'CE') return signalColor === 'GREEN' && prevColor === 'RED';
  if (signal.optionType === 'PE') return signalColor === 'RED' && prevColor === 'GREEN';
  return false;
}

module.exports = {
  findHeikinAshiSignal,
  findCeStopIndex,
  findPeStopIndex,
  validateHeikinAshiSignal,
  assertSignalHaColors,
  buildSignalAudit,
  computePatternSlPremium,
  isInsideBar,
  haColor,
};

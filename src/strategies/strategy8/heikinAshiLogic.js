/**
 * Heikin Ashi pattern signals — CE (call) and PE (put) entries.
 */

const { isHeikinAshiBullish, isHeikinAshiBearish } = require('../shared/indicators');

function barHigh(bar) {
  return Number(bar[2]);
}

function barLow(bar) {
  return Number(bar[3]);
}

function isInsideBar(innerBar, outerHigh, outerLow) {
  const hi = barHigh(innerBar);
  const lo = barLow(innerBar);
  if (![hi, lo, outerHigh, outerLow].every(Number.isFinite)) return false;
  return hi <= outerHigh && lo >= outerLow;
}

function collectColorIndices(haBars, beforeIdx, isColorFn, maxCount) {
  const out = [];
  for (let j = beforeIdx - 1; j >= 0 && out.length < maxCount; j -= 1) {
    if (isColorFn(haBars[j])) out.push(j);
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
 * Pattern at completed index `i`; breakout checked on running bar `i + 1`.
 * @returns {{ optionType: 'CE'|'PE', entryIdx: number, entrySpot: number, stopIndex: number, reason: string }|null}
 */
function findHeikinAshiSignal(haBars, i) {
  if (i < 1 || i + 1 >= haBars.length) return null;

  const runIdx = i + 1;
  const runHigh = barHigh(haBars[runIdx]);
  const runLow = barLow(haBars[runIdx]);

  if (isHeikinAshiBullish(haBars[i]) && isHeikinAshiBearish(haBars[i - 1])) {
    const triggerHigh = barHigh(haBars[i]);
    if (!Number.isFinite(triggerHigh) || !Number.isFinite(runHigh) || runHigh <= triggerHigh) return null;

    const stopIndex = findCeStopIndex(haBars, i);
    if (stopIndex == null || !Number.isFinite(stopIndex)) return null;

    return {
      optionType: 'CE',
      entryIdx: runIdx,
      entrySpot: triggerHigh,
      stopIndex,
      reason: 'HA_CE_BREAKOUT',
    };
  }

  if (isHeikinAshiBearish(haBars[i]) && isHeikinAshiBullish(haBars[i - 1])) {
    const triggerLow = barLow(haBars[i]);
    if (!Number.isFinite(triggerLow) || !Number.isFinite(runLow) || runLow >= triggerLow) return null;

    const stopIndex = findPeStopIndex(haBars, i);
    if (stopIndex == null || !Number.isFinite(stopIndex)) return null;

    return {
      optionType: 'PE',
      entryIdx: runIdx,
      entrySpot: triggerLow,
      stopIndex,
      reason: 'HA_PE_BREAKDOWN',
    };
  }

  return null;
}

module.exports = {
  findHeikinAshiSignal,
  findCeStopIndex,
  findPeStopIndex,
  isInsideBar,
};

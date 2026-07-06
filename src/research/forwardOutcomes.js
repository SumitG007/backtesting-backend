/**
 * Measure index outcomes after a pattern fires (entry = next bar open).
 */

const { barOhlc } = require('./candleEncoding');

function yearFromDayKey(dayKey) {
  const y = Number(String(dayKey).slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * @param {number[]} bars - full session bars
 * @param {number} signalEndIdx - index of last bar in the pattern
 * @param {{ targetPoints: number, stopPoints: number, horizonBars: number }} opts
 */
function measureForwardOutcome(bars, signalEndIdx, opts = {}) {
  const entryIdx = signalEndIdx + 1;
  if (entryIdx >= bars.length) return null;

  const targetPoints = Number(opts.targetPoints) || 15;
  const stopPoints = Number(opts.stopPoints) || 10;
  const horizonBars = Math.max(1, Number(opts.horizonBars) || 6);

  const entry = barOhlc(bars[entryIdx]);
  if (!Number.isFinite(entry.o) || entry.o <= 0) return null;

  const entryPrice = entry.o;
  let maxUp = 0;
  let maxDown = 0;
  let closeAtHorizon = entry.c;

  const endIdx = Math.min(bars.length - 1, entryIdx + horizonBars - 1);
  for (let j = entryIdx; j <= endIdx; j += 1) {
    const { h, l, c } = barOhlc(bars[j]);
    maxUp = Math.max(maxUp, h - entryPrice);
    maxDown = Math.max(maxDown, entryPrice - l);
    closeAtHorizon = c;
  }

  const longHitTarget = maxUp >= targetPoints;
  const longHitStop = maxDown >= stopPoints;
  const shortHitTarget = maxDown >= targetPoints;
  const shortHitStop = maxUp >= stopPoints;

  const longWin = longHitTarget && !longHitStop;
  const longLoss = longHitStop && !longHitTarget;
  const longMixed = longHitTarget && longHitStop;

  const shortWin = shortHitTarget && !shortHitStop;
  const shortLoss = shortHitStop && !shortHitTarget;
  const shortMixed = shortHitTarget && shortHitStop;

  const nextBarClose = barOhlc(bars[entryIdx]).c;
  const next1Points = nextBarClose - entryPrice;
  const horizonPoints = closeAtHorizon - entryPrice;

  return {
    entryIdx,
    entryPrice,
    next1Points: Number(next1Points.toFixed(2)),
    horizonPoints: Number(horizonPoints.toFixed(2)),
    maxUp: Number(maxUp.toFixed(2)),
    maxDown: Number(maxDown.toFixed(2)),
    longWin,
    longLoss,
    longMixed,
    shortWin,
    shortLoss,
    shortMixed,
    longNet: longWin ? 1 : longLoss ? -1 : 0,
    shortNet: shortWin ? 1 : shortLoss ? -1 : 0,
    targetPoints,
    stopPoints,
    horizonBars,
  };
}

function aggregateOutcomes(samples) {
  const n = samples.length;
  if (!n) {
    return {
      sampleSize: 0,
      longWinRate: null,
      shortWinRate: null,
      avgNext1Points: null,
      avgHorizonPoints: null,
      longWins: 0,
      longLosses: 0,
      shortWins: 0,
      shortLosses: 0,
      byYear: {},
    };
  }

  let longWins = 0;
  let longLosses = 0;
  let shortWins = 0;
  let shortLosses = 0;
  let next1Sum = 0;
  let horizonSum = 0;
  const byYear = {};

  for (const s of samples) {
    if (s.outcome.longWin) longWins += 1;
    else if (s.outcome.longLoss) longLosses += 1;
    if (s.outcome.shortWin) shortWins += 1;
    else if (s.outcome.shortLoss) shortLosses += 1;
    next1Sum += s.outcome.next1Points;
    horizonSum += s.outcome.horizonPoints;

    const y = yearFromDayKey(s.dayKey);
    if (!y) continue;
    if (!byYear[y]) byYear[y] = { longWins: 0, longLosses: 0, shortWins: 0, shortLosses: 0, n: 0 };
    byYear[y].n += 1;
    if (s.outcome.longWin) byYear[y].longWins += 1;
    if (s.outcome.longLoss) byYear[y].longLosses += 1;
    if (s.outcome.shortWin) byYear[y].shortWins += 1;
    if (s.outcome.shortLoss) byYear[y].shortLosses += 1;
  }

  const longDecided = longWins + longLosses;
  const shortDecided = shortWins + shortLosses;

  const yearStats = {};
  for (const [y, st] of Object.entries(byYear)) {
    const lDec = st.longWins + st.longLosses;
    const sDec = st.shortWins + st.shortLosses;
    yearStats[y] = {
      sampleSize: st.n,
      longWinRate: lDec ? Number(((st.longWins / lDec) * 100).toFixed(1)) : null,
      shortWinRate: sDec ? Number(((st.shortWins / sDec) * 100).toFixed(1)) : null,
    };
  }

  const longRates = Object.values(yearStats)
    .map((y) => y.longWinRate)
    .filter(Number.isFinite);
  const shortRates = Object.values(yearStats)
    .map((y) => y.shortWinRate)
    .filter(Number.isFinite);

  function stdDev(vals) {
    if (vals.length < 2) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length;
    return Number(Math.sqrt(v).toFixed(2));
  }

  return {
    sampleSize: n,
    longWinRate: longDecided ? Number(((longWins / longDecided) * 100).toFixed(1)) : null,
    shortWinRate: shortDecided ? Number(((shortWins / shortDecided) * 100).toFixed(1)) : null,
    avgNext1Points: Number((next1Sum / n).toFixed(2)),
    avgHorizonPoints: Number((horizonSum / n).toFixed(2)),
    longWins,
    longLosses,
    shortWins,
    shortLosses,
    byYear: yearStats,
    longWinRateStdAcrossYears: stdDev(longRates),
    shortWinRateStdAcrossYears: stdDev(shortRates),
  };
}

module.exports = {
  measureForwardOutcome,
  aggregateOutcomes,
  yearFromDayKey,
};

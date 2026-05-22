const { getIstClock } = require('../../src/utils/dateTime');
const { getOptionPremiumFromSpotMove } = require('../../src/utils/market');

function premiumSideForOption(optionType) {
  return String(optionType).toUpperCase() === 'CE' ? 'LONG' : 'SHORT';
}

function premiumAt({ optionType, entrySpot, spot, entryPremium, premiumLeverage, strike, strikeStep }) {
  return getOptionPremiumFromSpotMove({
    side: premiumSideForOption(optionType),
    entrySpot,
    currentSpot: spot,
    entryPremium,
    premiumLeverage,
    strike,
    strikeStep,
  });
}

function findBarIndex(dayBars, isoTime) {
  const t = new Date(isoTime).getTime();
  if (Number.isNaN(t)) return -1;
  let best = -1;
  for (let i = 0; i < dayBars.length; i += 1) {
    const bt = new Date(dayBars[i][0]).getTime();
    if (Number.isNaN(bt)) continue;
    if (bt <= t) best = i;
    else break;
  }
  return best;
}

/**
 * Bar-by-bar premium path after entry (same model as Strategy 1 backtest).
 */
function analyzeTradeExcursion(trade, dayBars, model) {
  const entryIdx = findBarIndex(dayBars, trade.entryTime);
  if (entryIdx < 0 || entryIdx >= dayBars.length - 1) {
    return { ok: false, error: 'entry bar not found' };
  }

  const optionType = String(trade.type || trade.closed || 'CE').toUpperCase();
  const entrySpot = Number(trade.entryPrice);
  const entryPremium = Number(trade.buyPrice ?? trade.premium);
  const exitPremium = Number(trade.sellPrice);
  const strike = Number(trade.strike);
  const { premiumLeverage, strikeStep } = model;

  let maxPremium = entryPremium;
  let minPremium = entryPremium;
  let maxFavSpot = entrySpot;
  let maxAdvSpot = entrySpot;
  let barsHeld = 0;

  for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
    const hi = Number(dayBars[k][2]);
    const lo = Number(dayBars[k][3]);
    if (![hi, lo].every(Number.isFinite)) continue;
    barsHeld += 1;

    const favSpot = optionType === 'CE' ? hi : lo;
    const advSpot = optionType === 'CE' ? lo : hi;

    const favPrem = premiumAt({
      optionType,
      entrySpot,
      spot: favSpot,
      entryPremium,
      premiumLeverage,
      strike,
      strikeStep,
    });
    const advPrem = premiumAt({
      optionType,
      entrySpot,
      spot: advSpot,
      entryPremium,
      premiumLeverage,
      strike,
      strikeStep,
    });

    if (favPrem > maxPremium) {
      maxPremium = favPrem;
      maxFavSpot = favSpot;
    }
    if (advPrem < minPremium) {
      minPremium = advPrem;
      maxAdvSpot = advSpot;
    }
  }

  const dayHigh = Number(trade.dayHigh);
  const dayLow = Number(trade.dayLow);
  const favIndexMove =
    optionType === 'CE'
      ? (Number.isFinite(dayHigh) ? dayHigh - entrySpot : maxFavSpot - entrySpot)
      : (Number.isFinite(dayLow) ? entrySpot - dayLow : entrySpot - maxFavSpot);
  const advIndexMove =
    optionType === 'CE'
      ? entrySpot - (Number.isFinite(dayLow) ? dayLow : maxAdvSpot)
      : (Number.isFinite(dayHigh) ? dayHigh - entrySpot : maxAdvSpot - entrySpot);

  const leftOnTablePrem = Math.max(0, maxPremium - exitPremium);
  const extraPainPrem = Math.max(0, exitPremium - minPremium);
  const pnl = Number(trade.pnl) || 0;

  return {
    ok: true,
    optionType,
    reason: trade.reason,
    pnl,
    entryPremium,
    exitPremium,
    maxPremium: Number(maxPremium.toFixed(2)),
    minPremium: Number(minPremium.toFixed(2)),
    leftOnTablePrem: Number(leftOnTablePrem.toFixed(2)),
    extraPainPrem: Number(extraPainPrem.toFixed(2)),
    maxFavPremPts: Number((maxPremium - entryPremium).toFixed(2)),
    maxAdvPremPts: Number((entryPremium - minPremium).toFixed(2)),
    favIndexMove: Number(favIndexMove.toFixed(2)),
    advIndexMove: Number(advIndexMove.toFixed(2)),
    dayRange: Number.isFinite(dayHigh) && Number.isFinite(dayLow) ? Number((dayHigh - dayLow).toFixed(2)) : null,
    barsHeld,
  };
}

/**
 * Replay SL/target on same bar path (first hit wins).
 */
function replaySlTarget(trade, dayBars, model, stopLossPoints, targetPoints) {
  const entryIdx = findBarIndex(dayBars, trade.entryTime);
  if (entryIdx < 0) return null;

  const optionType = String(trade.type || trade.closed || 'CE').toUpperCase();
  const entrySpot = Number(trade.entryPrice);
  const entryPremium = Number(trade.buyPrice ?? trade.premium);
  const strike = Number(trade.strike);
  const { premiumLeverage, strikeStep, lotSize, lotCount, perTradeCost } = model;

  const hasSl = stopLossPoints > 0;
  const hasTg = targetPoints > 0;
  const stopPremium = hasSl ? Math.max(0.05, entryPremium - stopLossPoints) : null;
  const targetPremium = hasTg ? entryPremium + targetPoints : null;

  let exitPremium = entryPremium;
  let reason = 'DAY_CLOSE';

  for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
    const hi = Number(dayBars[k][2]);
    const lo = Number(dayBars[k][3]);
    const cl = Number(dayBars[k][4]);
    if (![hi, lo, cl].every(Number.isFinite)) continue;

    if (hasSl && stopPremium != null) {
      const advSpot = optionType === 'CE' ? lo : hi;
      const advPrem = premiumAt({
        optionType,
        entrySpot,
        spot: advSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      if (advPrem <= stopPremium) {
        exitPremium = stopPremium;
        reason = 'STOP_LOSS';
        break;
      }
    }

    if (hasTg && targetPremium != null) {
      const favSpot = optionType === 'CE' ? hi : lo;
      const favPrem = premiumAt({
        optionType,
        entrySpot,
        spot: favSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      if (favPrem >= targetPremium) {
        exitPremium = targetPremium;
        reason = 'TARGET';
        break;
      }
    }

    const kClock = getIstClock(dayBars[k][0]);
    if (kClock.minutes >= 930) {
      exitPremium = premiumAt({
        optionType,
        entrySpot,
        spot: cl,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      reason = 'DAY_CLOSE';
      break;
    }
  }

  if (reason === 'DAY_CLOSE' && entryIdx < dayBars.length - 1) {
    const last = dayBars[dayBars.length - 1];
    exitPremium = premiumAt({
      optionType,
      entrySpot,
      spot: Number(last[4]),
      entryPremium,
      premiumLeverage,
      strike,
      strikeStep,
    });
  }

  const invested = entryPremium * lotSize * lotCount;
  const pnl = exitPremium * lotSize * lotCount - invested - perTradeCost;
  return { pnl: Number(pnl.toFixed(2)), reason };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

module.exports = {
  analyzeTradeExcursion,
  replaySlTarget,
  findBarIndex,
  percentile,
};

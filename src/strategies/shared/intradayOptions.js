/**
 * Shared intraday session helpers + long-option backtest exit/trade builders.
 */

const { getIstClock } = require('../../utils/dateTime');
const { computeSessionHighLow } = require('./sessionRange');
const { getOptionPremiumFromSpotMove } = require('../../utils/market');

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  }
  return m;
}

function sortExecCandlesChronologically(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return list.filter((c) => {
    const clock = getIstClock(c[0]);
    return clock.minutes >= 555 && clock.minutes <= 930;
  });
}

function pickStrike({ entrySpot, strikeStep, optionType, strikeMode }) {
  const step = Math.max(1, strikeStep);
  const atm = Math.round(entrySpot / step) * step;
  const mode = String(strikeMode || 'ATM').toUpperCase();
  if (mode === 'ITM') {
    if (optionType === 'CE') return atm - step;
    return atm + step;
  }
  if (mode === 'OTM') {
    if (optionType === 'CE') return atm + step;
    return atm - step;
  }
  return atm;
}

/**
 * Long option premium vs index move.
 * CE: LONG delta (spot up → premium up). PE: inverted (spot down → premium up).
 * Matches strategy 1/3/4 convention — do not use side LONG for bought puts.
 */
function premiumSideForLongOption(optionType) {
  return String(optionType || 'CE').toUpperCase() === 'CE' ? 'LONG' : 'SHORT';
}

function simulateLongOptionExit({
  dayBars,
  entryIdx,
  optionType,
  entrySpot,
  entryPremium,
  strike,
  strikeStep,
  premiumLeverage,
  hasStopLoss,
  stopPremium,
  hasTarget,
  targetPremium,
  useIndexExits,
  stopIndex,
  targetIndex,
  eodExitMinutes = 930,
}) {
  const premiumSide = premiumSideForLongOption(optionType);
  let exitIdx = dayBars.length - 1;
  let exitSpot = Number(dayBars[exitIdx][4]);
  let exitPremium = getOptionPremiumFromSpotMove({
    side: premiumSide,
    entrySpot,
    currentSpot: exitSpot,
    entryPremium,
    premiumLeverage,
    strike,
    strikeStep,
  });
  let reason = 'DAY_CLOSE';

  for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
    const hi = Number(dayBars[k][2]);
    const lo = Number(dayBars[k][3]);
    const cl = Number(dayBars[k][4]);
    if (![hi, lo, cl].every(Number.isFinite)) continue;

    if (useIndexExits && Number.isFinite(stopIndex)) {
      const hitSl = optionType === 'CE' ? lo <= stopIndex : hi >= stopIndex;
      if (hitSl) {
        exitIdx = k;
        exitSpot = optionType === 'CE' ? lo : hi;
        exitPremium = getOptionPremiumFromSpotMove({
          side: premiumSide,
          entrySpot,
          currentSpot: exitSpot,
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        reason = 'PATTERN_SL';
        break;
      }
    }

    if (useIndexExits && Number.isFinite(targetIndex)) {
      const hitTg = optionType === 'CE' ? hi >= targetIndex : lo <= targetIndex;
      if (hitTg) {
        exitIdx = k;
        exitSpot = optionType === 'CE' ? hi : lo;
        exitPremium = getOptionPremiumFromSpotMove({
          side: premiumSide,
          entrySpot,
          currentSpot: exitSpot,
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        reason = 'PATTERN_TARGET';
        break;
      }
    }

    if (hasStopLoss && stopPremium != null) {
      const adverseSpot = optionType === 'CE' ? lo : hi;
      const adversePrem = getOptionPremiumFromSpotMove({
        side: premiumSide,
        entrySpot,
        currentSpot: adverseSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      if (adversePrem <= stopPremium) {
        exitIdx = k;
        exitSpot = adverseSpot;
        exitPremium = stopPremium;
        reason = 'STOP_LOSS';
        break;
      }
    }

    if (hasTarget && targetPremium != null) {
      const favSpot = optionType === 'CE' ? hi : lo;
      const favPrem = getOptionPremiumFromSpotMove({
        side: premiumSide,
        entrySpot,
        currentSpot: favSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      if (favPrem >= targetPremium) {
        exitIdx = k;
        exitSpot = favSpot;
        exitPremium = targetPremium;
        reason = 'TARGET';
        break;
      }
    }

    const kClock = getIstClock(dayBars[k][0]);
    if (kClock.minutes >= eodExitMinutes) {
      exitIdx = k;
      exitSpot = cl;
      exitPremium = getOptionPremiumFromSpotMove({
        side: premiumSide,
        entrySpot,
        currentSpot: exitSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      reason = 'DAY_CLOSE';
      break;
    }
  }

  return { exitIdx, exitSpot, exitPremium, reason };
}

function buildLongOptionTrade({
  symbol,
  lotSize,
  lotCount,
  perTradeCost,
  dayBars,
  entryIdx,
  optionType,
  strike,
  entrySpot,
  entryPremium,
  exitIdx,
  exitSpot,
  exitPremium,
  reason,
  hasStopLoss,
  stopPremium,
  hasTarget,
  targetPremium,
  extra = {},
}) {
  const invested = entryPremium * lotSize * lotCount;
  const finalValue = exitPremium * lotSize * lotCount;
  const rawPnl = finalValue - invested;
  const pnl = rawPnl - perTradeCost;

  return {
    pair: symbol,
    type: optionType,
    strike,
    buyPrice: Number(entryPremium.toFixed(2)),
    sellPrice: Number(exitPremium.toFixed(2)),
    lotSize,
    lots: lotCount,
    invested: Number(invested.toFixed(2)),
    finalValue: Number(finalValue.toFixed(2)),
    closed: optionType,
    order: 'BUY',
    entryTime: dayBars[entryIdx][0],
    exitTime: dayBars[exitIdx][0],
    entryPrice: Number(entrySpot.toFixed(2)),
    exitPrice: Number(exitSpot.toFixed(2)),
    stopLoss: hasStopLoss && stopPremium != null ? Number(stopPremium.toFixed(2)) : null,
    target: hasTarget && targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
    qty: lotSize * lotCount,
    premium: Number(entryPremium.toFixed(2)),
    lotCount,
    investmentAmount: Number(invested.toFixed(2)),
    grossPnl: Number(rawPnl.toFixed(2)),
    charges: perTradeCost,
    pnl: Number(pnl.toFixed(2)),
    pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
    reason,
    ...computeSessionHighLow(dayBars),
    ...extra,
  };
}

function parseCommonOptionSettings(settings, symbol) {
  const { getLotSize, getStrikeStep } = require('../../utils/market');
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const rawSlPts = Number(settings.stopLossPoints);
  const hasStopLoss = Number.isFinite(rawSlPts) && rawSlPts > 0;
  const stopLossPoints = hasStopLoss ? Math.min(5000, Math.max(0.01, rawSlPts)) : 0;
  const rawTg = Number(settings.targetProfitPoints);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetPoints = hasTarget ? Math.min(5000, Math.max(0.01, rawTg)) : 0;
  const rawPerTradeCost = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const usePatternExits = settings.usePatternExits !== false;

  return {
    lotSize,
    lotCount,
    basePremiumPct,
    premiumLeverage,
    strikeStep,
    strikeMode,
    hasStopLoss,
    stopLossPoints,
    hasTarget,
    targetPoints,
    perTradeCost,
    maxTradesPerDay,
    usePatternExits,
  };
}

module.exports = {
  buildIntradayByDay,
  sortExecCandlesChronologically,
  pickStrike,
  premiumSideForLongOption,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
};

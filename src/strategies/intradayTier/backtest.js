/**
 * Strategy 4 — first-hour vs 09:15 open: PE or CE; entry ≥10:00; premium SL/target; flat 15:20.
 */

const { getIstClock } = require('../../utils/dateTime');
const { getLotSize, getStrikeStep, getOptionPremiumFromSpotMove } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');

const M915 = 555;
const M1000 = 600; // 10:00
const M1100 = 660;
const EOD_EXIT = 920; // 15:20 IST
const SESSION_END = 930;

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < M915 || clock.minutes > SESSION_END) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  }
  return m;
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
 * Strategy 4: first hour vs session open → PE / CE; entry on first bar ≥ 10:00 (not after 11:00).
 */
function findFirstHourPeCeSignal(bars) {
  const sessionOpen = Number(bars[0][1]);
  if (!Number.isFinite(sessionOpen)) return null;

  let lastCloseBefore1000 = null;
  for (const c of bars) {
    const m = getIstClock(c[0]).minutes;
    if (m < M915) continue;
    if (m >= M1000) break;
    const cl = Number(c[4]);
    if (Number.isFinite(cl)) lastCloseBefore1000 = cl;
  }
  if (lastCloseBefore1000 == null) return null;

  let optionType = null;
  if (lastCloseBefore1000 < sessionOpen) optionType = 'PE';
  else if (lastCloseBefore1000 > sessionOpen) optionType = 'CE';
  else return null;

  let entryIdx = null;
  for (let j = 0; j < bars.length; j += 1) {
    if (getIstClock(bars[j][0]).minutes >= M1000) {
      entryIdx = j;
      break;
    }
  }
  if (entryIdx == null) return null;
  return { optionType, entryIdx };
}

function simulateExitPeCe({
  dayBars,
  entryIdx,
  optionType,
  entrySpot,
  entryPremium,
  stopPremium,
  targetPremium,
  hasStopLoss,
  hasTarget,
  premiumLeverage,
  strike,
  strikeStep,
}) {
  const premiumSide = optionType === 'CE' ? 'LONG' : 'SHORT';
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
    const c = Number(dayBars[k][4]);
    const kMin = getIstClock(dayBars[k][0]).minutes;
    if (![hi, lo, c].every(Number.isFinite)) continue;

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

    if (kMin >= EOD_EXIT) {
      exitIdx = k;
      exitSpot = c;
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

function pushTrade({
  trades,
  symbol,
  dayBars,
  entryIdx,
  exitIdx,
  optionType,
  entrySpot,
  exitSpot,
  entryPremium,
  exitPremium,
  reason,
  lotSize,
  lotCount,
  perTradeCost,
  hasStopLoss,
  stopPremium,
  hasTarget,
  targetPremium,
  strike,
}) {
  const invested = entryPremium * lotSize * lotCount;
  const finalValue = exitPremium * lotSize * lotCount;
  const rawPnl = finalValue - invested;
  const pnl = rawPnl - perTradeCost;

  trades.push({
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
    stopLossAmount:
      hasStopLoss && stopPremium != null
        ? Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2))
        : null,
    targetAmount:
      hasTarget && targetPremium != null
        ? Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2))
        : null,
    grossPnl: Number(rawPnl.toFixed(2)),
    charges: perTradeCost,
    pnl: Number(pnl.toFixed(2)),
    pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
    reason,
  });
}

/**
 * @param {{ candles: unknown[], settings: Record<string, unknown>, variant: string }} args
 */
function runIntradayTierBacktest({ candles, settings, variant }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const rawSl = Number(settings.stopLossPoints);
  const hasStopLoss = Number.isFinite(rawSl) && rawSl > 0;
  const stopLossPoints = hasStopLoss ? Math.min(5000, Math.max(0.01, rawSl)) : 0;
  const rawTg = Number(settings.targetProfitPoints);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetPoints = hasTarget ? Math.min(5000, Math.max(0.01, rawTg)) : 0;
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];

  for (const dayKey of sortedKeys) {
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 3) continue;

    let entryIdx = null;
    let optionType = null;

    if (variant !== 'first_hour_pe_ce') {
      throw new Error(`Unknown intraday tier variant: ${variant}`);
    }
    const sig = findFirstHourPeCeSignal(dayBars);
    if (!sig) continue;
    entryIdx = sig.entryIdx;
    optionType = sig.optionType;

    if (entryIdx == null || optionType == null) continue;
    const entryMin = getIstClock(dayBars[entryIdx][0]).minutes;
    if (entryMin > M1100) continue; // 11:00 IST — no new entry
    if (entryIdx >= dayBars.length - 1) continue;

    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);

    const targetPremium = hasTarget ? entryPremium + targetPoints : null;
    const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;
    const { exitIdx, exitSpot, exitPremium, reason } = simulateExitPeCe({
      dayBars,
      entryIdx,
      optionType,
      entrySpot,
      entryPremium,
      stopPremium,
      targetPremium,
      hasStopLoss,
      hasTarget,
      premiumLeverage,
      strike,
      strikeStep,
    });

    pushTrade({
      trades,
      symbol,
      dayBars,
      entryIdx,
      exitIdx,
      optionType,
      entrySpot,
      exitSpot,
      entryPremium,
      exitPremium,
      reason,
      lotSize,
      lotCount,
      perTradeCost,
      hasStopLoss,
      stopPremium,
      hasTarget,
      targetPremium,
      strike,
    });
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = {
  runIntradayTierBacktest,
};

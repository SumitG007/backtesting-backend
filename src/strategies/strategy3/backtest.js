/**
 * Strategy 3 — Option chain OI direction (backtest).
 *
 * Live option-chain OI history is not in the candle feed. The backtest uses a
 * documented proxy: each 1m index bar adds volume to a CE tally on bullish bars
 * (close > open) and to a PE tally on bearish bars (close < open). After your
 * analysis start time (default 9:16 IST), the first minute when PE tally > CE
 * tally triggers a long CALL; when CE > PE, a long PUT — matching the narrative
 * “higher put OI → bullish / higher call OI → bearish” for research replay.
 *
 * Many historical 1m index feeds return volume as 0. The proxy used to add only
 * real volume, so CE and PE tallies stayed tied at 0 and no trade fired. For any
 * bullish/bearish bar we now use weight max(volume, 1) so direction still builds
 * dominance when volume is missing (vendor-specific; recent years often have volume).
 *
 * Take-profit: `targetProfitPoints` — absolute premium points above entry (not %).
 * Stop-loss: `stopLossPoints` — absolute premium points below entry on modelled premium (0 = off).
 */

const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');
const { getLotSize, getStrikeStep, getOptionPremiumFromSpotMove } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');

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
 * @param {{ candles: unknown[], settings: Record<string, unknown> }} args
 */
function runStrategyThreeBacktest({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
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
  const analysisStartMinutes = parseClockMinutes(settings.analysisStartTime, 9 * 60 + 16);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedDays = Array.from(intraByDay.keys()).sort();
  const trades = [];

  for (const dayKey of sortedDays) {
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 2) continue;

    let ceOi = 0;
    let peOi = 0;
    let entryIdx = null;
    let optionType = null;

    for (let j = 0; j < dayBars.length; j += 1) {
      const clock = getIstClock(dayBars[j][0]);
      if (clock.minutes < 555 || clock.minutes > 930) continue;

      const o = Number(dayBars[j][1]);
      const h = Number(dayBars[j][2]);
      const l = Number(dayBars[j][3]);
      const cl = Number(dayBars[j][4]);
      if (![o, h, l, cl].every(Number.isFinite)) continue;

      const volRaw = Number(dayBars[j][5]);
      const volNum = Number.isFinite(volRaw) && volRaw > 0 ? volRaw : 0;
      // Older 1m index rows often have volume 0 → tallies never diverged. Use at least 1 on directional bars.
      const wBull = cl > o ? Math.max(1, volNum) : 0;
      const wBear = cl < o ? Math.max(1, volNum) : 0;

      if (clock.minutes >= analysisStartMinutes) {
        if (wBull > 0) ceOi += wBull;
        else if (wBear > 0) peOi += wBear;

        if (ceOi !== peOi) {
          if (peOi > ceOi) {
            optionType = 'CE';
            entryIdx = j;
          } else {
            optionType = 'PE';
            entryIdx = j;
          }
          break;
        }
      }
    }

    if (entryIdx == null || optionType == null) continue;
    if (entryIdx >= dayBars.length - 1) continue;

    const premiumSide = optionType === 'CE' ? 'LONG' : 'SHORT';
    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
    const targetPremium = hasTarget ? entryPremium + targetPoints : null;
    const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;

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

      const kClock = getIstClock(dayBars[k][0]);
      if (kClock.minutes >= 930) {
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

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = {
  runStrategyThreeBacktest,
};

/**
 * Strategy 2 — Short straddle (overnight hold, optional same-day expiry avoidance).
 * Live engine counterpart: `services/liveShortStraddleEngine.js`.
 */

const { parseClockMinutes, getIstClock, getWeekdayFromDateKey } = require('../../utils/dateTime');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');

function runStrategyShortStraddle({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(1, rawTargetPct) : 50;
  const rawStopLossPct = Number(settings.stopLossPct);
  const hasStopLoss = Number.isFinite(rawStopLossPct) && rawStopLossPct > 0;
  const stopLossPct = hasStopLoss ? Math.max(1, rawStopLossPct) : 30;
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  const nextDayExitMinutes = parseClockMinutes(settings.dayCloseTime, 560);

  const skipExpiryDay = settings.skipExpiryDay !== false && settings.skipExpiryDay !== 'false';
  const rawExpiryWeekday = Number(settings.expiryWeekday);
  const expiryWeekday = Number.isFinite(rawExpiryWeekday)
    ? Math.max(0, Math.min(6, Math.trunc(rawExpiryWeekday)))
    : 4;

  const rawPerTradeCost = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }
  const dayKeys = Array.from(byDay.keys()).sort();
  const trades = [];

  for (let dIdx = 0; dIdx < dayKeys.length; dIdx += 1) {
    const entryDayKey = dayKeys[dIdx];
    const usesNextExpiry = skipExpiryDay && getWeekdayFromDateKey(entryDayKey) === expiryWeekday;

    const entryDayCandles = byDay.get(entryDayKey) || [];
    if (entryDayCandles.length < 1) continue;

    const nextDayKey = dayKeys[dIdx + 1];
    if (!nextDayKey) continue;
    const nextDayCandles = byDay.get(nextDayKey) || [];
    if (nextDayCandles.length < 1) continue;

    let entryIdx = -1;
    for (let i = 0; i < entryDayCandles.length; i += 1) {
      const clock = getIstClock(entryDayCandles[i][0]);
      if (clock.minutes >= normalizedEntryFrom && clock.minutes <= normalizedEntryTo) {
        entryIdx = i;
        break;
      }
    }
    if (entryIdx < 0) continue;

    const entryCandle = entryDayCandles[entryIdx];
    const entrySpot = Number(entryCandle[4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = Math.round(entrySpot / strikeStep) * strikeStep;
    const ceEntry = Math.max(1, (entrySpot * basePremiumPct) / 100);
    const peEntry = Math.max(1, (entrySpot * basePremiumPct) / 100);
    const entryCredit = ceEntry + peEntry;
    const targetCombined = entryCredit * (1 - targetPct / 100);
    const stopCombined = entryCredit * (1 + stopLossPct / 100);

    const holdingCandles = [];
    for (let i = entryIdx + 1; i < entryDayCandles.length; i += 1) {
      holdingCandles.push(entryDayCandles[i]);
    }
    const dayOneCandleCount = holdingCandles.length;
    for (let i = 0; i < nextDayCandles.length; i += 1) {
      holdingCandles.push(nextDayCandles[i]);
      const nClock = getIstClock(nextDayCandles[i][0]);
      if (nClock.minutes >= nextDayExitMinutes) break;
    }
    if (holdingCandles.length === 0) continue;

    const totalHoldCandles = holdingCandles.length;
    const initialExtrinsic = Math.max(0.01, entryCredit - Math.abs(entrySpot - strike));

    function combinedAtSpot(spot, elapsedSteps) {
      const intrinsic = Math.abs(Number(spot) - strike);
      const elapsedFraction = totalHoldCandles > 0
        ? Math.min(1, Math.max(0, elapsedSteps / totalHoldCandles))
        : 1;
      const remainingExtrinsic = initialExtrinsic * (1 - elapsedFraction);
      return Math.max(0.05, intrinsic + Math.max(0, remainingExtrinsic));
    }

    let exitCandle = holdingCandles[holdingCandles.length - 1];
    let exitSpot = Number(exitCandle[4]);
    let exitCombined = combinedAtSpot(exitSpot, totalHoldCandles);
    let reason = 'DAY_CLOSE';

    for (let j = 0; j < holdingCandles.length; j += 1) {
      const cnd = holdingCandles[j];
      const high = Number(cnd[2]);
      const low = Number(cnd[3]);
      const close = Number(cnd[4]);
      const elapsed = j + 1;
      const atHigh = combinedAtSpot(high, elapsed);
      const atLow = combinedAtSpot(low, elapsed);
      const atClose = combinedAtSpot(close, elapsed);

      const isDayOne = j < dayOneCandleCount;
      if (isDayOne) continue;

      const worst = Math.max(atHigh, atLow, atClose);
      const best = Math.min(atHigh, atLow, atClose);

      if (worst >= stopCombined) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = stopCombined;
        reason = 'STOP_LOSS';
        break;
      }
      if (best <= targetCombined) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = targetCombined;
        reason = 'TARGET';
        break;
      }
      if (j === holdingCandles.length - 1) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = atClose;
        reason = 'DAY_CLOSE';
      }
    }

    const qty = lotSize * lotCount;
    const credit = entryCredit * qty;
    const buyback = exitCombined * qty;
    const rawPnl = credit - buyback;
    const pnl = rawPnl - perTradeCost;

    trades.push({
      pair: symbol,
      type: 'STRADDLE',
      strike,
      buyPrice: Number(exitCombined.toFixed(2)),
      sellPrice: Number(entryCredit.toFixed(2)),
      lotSize,
      lots: lotCount,
      invested: Number(credit.toFixed(2)),
      finalValue: Number(buyback.toFixed(2)),
      closed: 'STRADDLE',
      order: 'SELL',
      entryTime: entryCandle[0],
      exitTime: exitCandle[0],
      entryPrice: Number(entrySpot.toFixed(2)),
      exitPrice: Number(exitSpot.toFixed(2)),
      stopLoss: Number(stopCombined.toFixed(2)),
      target: Number(targetCombined.toFixed(2)),
      qty,
      premium: Number(entryCredit.toFixed(2)),
      lotCount,
      investmentAmount: Number(credit.toFixed(2)),
      stopLossAmount: Number((Math.max(0, stopCombined - entryCredit) * qty).toFixed(2)),
      targetAmount: Number((Math.max(0, entryCredit - targetCombined) * qty).toFixed(2)),
      grossPnl: Number(rawPnl.toFixed(2)),
      charges: perTradeCost,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: credit > 0 ? Number(((pnl / credit) * 100).toFixed(2)) : 0,
      reason,
      expiryMode: usesNextExpiry ? 'NEXT_EXPIRY' : 'CURRENT_EXPIRY',
    });
  }

  return { summary: buildStrategyRunSummary(trades), trades };
}

module.exports = {
  runStrategyShortStraddle,
};

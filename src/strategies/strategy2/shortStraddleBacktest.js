/**
 * Strategy 2 — Short straddle (overnight hold, optional same-day expiry avoidance).
 * Live engine counterpart: `services/liveShortStraddleEngine.js`.
 */

const {
  parseClockMinutes,
  getIstClock,
  getWeekdayFromDateKey,
  istCashSession15mBucketStart,
  buildIstWallClockTimestamp,
} = require('../../utils/dateTime');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');

/** NIFTY weekly expiry weekday (0=Sun … 6=Sat). Default Tuesday. */
const DEFAULT_EXPIRY_WEEKDAY = 2;
/** Next-week series ATM straddle ~32% richer than same-week proxy at entry. */
const NEXT_EXPIRY_CREDIT_FACTOR = 1.32;
/** Extrinsic left after one overnight hold (before next-morning SL/target window). */
const OVERNIGHT_EXTRINSIC_RETAIN = 0.55;
/** Small additional decay from open until next-day exit time. */
const MORNING_SESSION_DECAY = 0.2;

function runStrategyShortStraddle({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(1, rawTargetPct) : null;
  const rawStopLossPct = Number(settings.stopLossPct);
  const hasStopLoss = Number.isFinite(rawStopLossPct) && rawStopLossPct > 0;
  const stopLossPct = hasStopLoss ? Math.max(1, rawStopLossPct) : null;
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  const nextDayExitMinutes = parseClockMinutes(settings.dayCloseTime, 560);

  const skipExpiryDay = settings.skipExpiryDay !== false && settings.skipExpiryDay !== 'false';
  const rawExpiryWeekday = Number(settings.expiryWeekday);
  const expiryWeekday = Number.isFinite(rawExpiryWeekday)
    ? Math.max(0, Math.min(6, Math.trunc(rawExpiryWeekday)))
    : DEFAULT_EXPIRY_WEEKDAY;

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
    let entryCredit = ceEntry + peEntry;
    if (usesNextExpiry) {
      entryCredit *= NEXT_EXPIRY_CREDIT_FACTOR;
    }
    const targetCombined = hasTarget ? entryCredit * (1 - targetPct / 100) : null;
    const stopCombined = hasStopLoss ? entryCredit * (1 + stopLossPct / 100) : null;

    const holdingCandles = [];
    for (let i = entryIdx + 1; i < entryDayCandles.length; i += 1) {
      holdingCandles.push(entryDayCandles[i]);
    }
    const dayOneCandleCount = holdingCandles.length;
    for (let i = 0; i < nextDayCandles.length; i += 1) {
      const nClock = getIstClock(nextDayCandles[i][0]);
      const bucketStart = istCashSession15mBucketStart(nClock.minutes);
      if (bucketStart > nextDayExitMinutes) break;
      holdingCandles.push(nextDayCandles[i]);
      if (nextDayExitMinutes < bucketStart + 15) break;
    }
    const day2CandleCount = holdingCandles.length - dayOneCandleCount;
    if (day2CandleCount < 1) continue;

    const initialExtrinsic = Math.max(0.01, entryCredit - Math.abs(entrySpot - strike));
    const extrinsicAtDay2Open = initialExtrinsic * OVERNIGHT_EXTRINSIC_RETAIN;

    function combinedPremiumOnDay2(spot, day2Idx) {
      const intrinsic = Math.abs(Number(spot) - strike);
      const day2Frac = day2CandleCount > 0 ? (day2Idx + 1) / day2CandleCount : 1;
      const remainingExtrinsic = extrinsicAtDay2Open
        * (1 - Math.min(1, day2Frac * MORNING_SESSION_DECAY));
      return Math.max(0.05, intrinsic + Math.max(0, remainingExtrinsic));
    }

    let exitCandle = holdingCandles[holdingCandles.length - 1];
    let exitSpot = Number(exitCandle[4]);
    let exitCombined = combinedPremiumOnDay2(exitSpot, day2CandleCount - 1);
    let reason = 'DAY_CLOSE';
    let exitTime = buildIstWallClockTimestamp(
      getIstClock(exitCandle[0]).dateKey,
      nextDayExitMinutes,
    );

    for (let j = dayOneCandleCount; j < holdingCandles.length; j += 1) {
      const cnd = holdingCandles[j];
      const high = Number(cnd[2]);
      const low = Number(cnd[3]);
      const close = Number(cnd[4]);
      const day2Idx = j - dayOneCandleCount;
      const atHigh = combinedPremiumOnDay2(high, day2Idx);
      const atLow = combinedPremiumOnDay2(low, day2Idx);
      const atClose = combinedPremiumOnDay2(close, day2Idx);

      const worst = Math.max(atHigh, atLow, atClose);
      const best = Math.min(atHigh, atLow, atClose);

      if (hasStopLoss && worst >= stopCombined) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = stopCombined;
        reason = 'STOP_LOSS';
        exitTime = cnd[0];
        break;
      }
      if (hasTarget && best <= targetCombined) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = targetCombined;
        reason = 'TARGET';
        exitTime = cnd[0];
        break;
      }
      if (j === holdingCandles.length - 1) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = atClose;
        reason = 'DAY_CLOSE';
        exitTime = buildIstWallClockTimestamp(
          getIstClock(cnd[0]).dateKey,
          nextDayExitMinutes,
        );
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
      exitTime,
      entryPrice: Number(entrySpot.toFixed(2)),
      exitPrice: Number(exitSpot.toFixed(2)),
      stopLoss: hasStopLoss ? Number(stopCombined.toFixed(2)) : null,
      target: hasTarget ? Number(targetCombined.toFixed(2)) : null,
      qty,
      premium: Number(entryCredit.toFixed(2)),
      lotCount,
      investmentAmount: Number(credit.toFixed(2)),
      stopLossAmount: hasStopLoss
        ? Number((Math.max(0, stopCombined - entryCredit) * qty).toFixed(2))
        : null,
      targetAmount: hasTarget
        ? Number((Math.max(0, entryCredit - targetCombined) * qty).toFixed(2))
        : null,
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

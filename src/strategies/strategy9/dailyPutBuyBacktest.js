/**
 * Strategy 5 (UI) — blind daily ATM put at entry time (default 09:20 IST).
 * No strategy logic: one PE buy every session that has candle data.
 */

const { parseClockMinutes, isWeekendDateKey, buildIstWallClockTimestamp, getIstClock } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
} = require('../shared/intradayOptions');

const DEFAULT_ENTRY_MINUTES = 560; // 09:20 IST
const EOD_EXIT = 920;

/** Last fully closed candle at entry clock (e.g. 09:20 on 5m → 09:15–09:20 bar). */
function findLastCompletedBarAtTime(dayBars, decisionMinutes, barIntervalMinutes) {
  if (!Number.isFinite(decisionMinutes) || !dayBars?.length) return null;
  let bestIdx = null;
  for (let j = 0; j < dayBars.length; j += 1) {
    const barOpenMinutes = getIstClock(dayBars[j][0]).minutes;
    const barEndMinutes = barOpenMinutes + barIntervalMinutes;
    if (barEndMinutes <= decisionMinutes) bestIdx = j;
    else break;
  }
  return bestIdx;
}

/**
 * Resolve entry bar for a timed put buy — never skip a day that has candle data.
 * 1) Last closed bar at entry clock
 * 2) Bar that contains entry clock (e.g. Dhan 5m bar opens 09:20, entry 09:20)
 * 3) First bar at or after entry clock
 * 4) First bar of session
 */
function resolveEntryBarForTimedPut(dayBars, decisionMinutes, barIntervalMinutes) {
  if (!dayBars?.length) return null;

  const completed = findLastCompletedBarAtTime(dayBars, decisionMinutes, barIntervalMinutes);
  if (completed != null) return completed;

  for (let j = 0; j < dayBars.length; j += 1) {
    const openMin = getIstClock(dayBars[j][0]).minutes;
    const closeMin = openMin + barIntervalMinutes;
    if (openMin <= decisionMinutes && decisionMinutes < closeMin) return j;
  }

  for (let j = 0; j < dayBars.length; j += 1) {
    const openMin = getIstClock(dayBars[j][0]).minutes;
    if (openMin >= decisionMinutes) return j;
  }

  return 0;
}

function runDailyPutBuyBacktest({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 10);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  const rawSl = Number(settings.stopLossPoints);
  const hasStopLoss = Number.isFinite(rawSl) && rawSl > 0;
  const stopLossPoints = hasStopLoss ? Math.min(5000, Math.max(0.01, rawSl)) : 0;

  const rawTg = Number(settings.targetProfitPoints);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetPoints = hasTarget ? Math.min(5000, Math.max(0.01, rawTg)) : 0;

  const entryTimeStr = String(settings.entryTime ?? settings.entryFromTime ?? '09:20').trim();
  const entryFromMin = parseClockMinutes(settings.entryFromTime ?? settings.entryTime, DEFAULT_ENTRY_MINUTES);
  const entryToMin = parseClockMinutes(settings.entryToTime ?? settings.entryTime, entryFromMin);
  const entryDecisionMinutes = Math.min(entryFromMin, entryToMin);

  const rawInterval = Number(settings.interval);
  const barIntervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : Math.max(1, Number(settings.barIntervalMinutes) || 5);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];
  let skippedDays = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (!dayBars.length) {
      skippedDays += 1;
      continue;
    }

    const entryIdx = resolveEntryBarForTimedPut(dayBars, entryDecisionMinutes, barIntervalMinutes);
    if (entryIdx == null) {
      skippedDays += 1;
      continue;
    }

    const optionType = 'PE';
    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
    const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;
    const targetPremium = hasTarget ? entryPremium + targetPoints : null;

    const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
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
      useIndexExits: false,
      stopIndex: null,
      targetIndex: null,
      eodExitMinutes: EOD_EXIT,
    });

    trades.push(
      buildLongOptionTrade({
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
        entryTime: new Date(buildIstWallClockTimestamp(dayKey, entryDecisionMinutes)).toISOString(),
      }),
    );
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.putTrades = trades.length;
  summary.entryTime = entryTimeStr;
  summary.entryMinutes = entryDecisionMinutes;

  return { trades, summary };
}

module.exports = { runDailyPutBuyBacktest };

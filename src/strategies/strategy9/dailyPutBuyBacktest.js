/**
 * Strategy 5 (UI) — blind daily ATM put + call at entry time (default 09:20 IST).
 * No strategy logic: one PE and one CE buy every session that has candle data.
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
const DEFAULT_STOP_LOSS_POINTS = 15;
const EOD_EXIT = 920;
const DAILY_OPTION_TYPES = ['PE', 'CE'];

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

function resolvePremiumExitPoints(rawValue, defaultWhenOmitted) {
  if (rawValue === undefined || rawValue === null) {
    return {
      active: defaultWhenOmitted > 0,
      points: defaultWhenOmitted > 0 ? defaultWhenOmitted : 0,
    };
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { active: false, points: 0 };
  }
  return { active: true, points: Math.min(5000, Math.max(0.01, parsed)) };
}

function runOneTimedLongOption({
  symbol,
  lotSize,
  lotCount,
  perTradeCost,
  basePremiumPct,
  premiumLeverage,
  strikeStep,
  strikeMode,
  dayKey,
  dayBars,
  entryIdx,
  entryDecisionMinutes,
  optionType,
  hasStopLoss,
  stopLossPoints,
  hasTarget,
  targetPoints,
}) {
  const entrySpot = Number(dayBars[entryIdx][4]);
  if (!Number.isFinite(entrySpot) || entrySpot <= 0) return null;

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

  return buildLongOptionTrade({
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
  });
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

  const stopLoss = resolvePremiumExitPoints(settings.stopLossPoints, DEFAULT_STOP_LOSS_POINTS);
  const hasStopLoss = stopLoss.active;
  const stopLossPoints = stopLoss.points;

  const target = resolvePremiumExitPoints(settings.targetProfitPoints, 0);
  const hasTarget = target.active;
  const targetPoints = target.points;

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
  let putTrades = 0;
  let callTrades = 0;

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

    let dayHadTrade = false;
    for (const optionType of DAILY_OPTION_TYPES) {
      const trade = runOneTimedLongOption({
        symbol,
        lotSize,
        lotCount,
        perTradeCost,
        basePremiumPct,
        premiumLeverage,
        strikeStep,
        strikeMode,
        dayKey,
        dayBars,
        entryIdx,
        entryDecisionMinutes,
        optionType,
        hasStopLoss,
        stopLossPoints,
        hasTarget,
        targetPoints,
      });
      if (!trade) continue;

      dayHadTrade = true;
      trades.push(trade);
      if (optionType === 'CE') callTrades += 1;
      else putTrades += 1;
    }

    if (!dayHadTrade) skippedDays += 1;
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.putTrades = putTrades;
  summary.callTrades = callTrades;
  summary.entryTime = entryTimeStr;
  summary.entryMinutes = entryDecisionMinutes;
  summary.stopLossPoints = hasStopLoss ? stopLossPoints : 0;

  return { trades, summary };
}

module.exports = { runDailyPutBuyBacktest };

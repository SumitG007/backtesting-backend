/**
 * Strategy 3 (UI) — timed put/call buy at entry time (default 09:20 IST).
 * Scores bearish vs bullish at entry → PE, CE, or skip. Optional premium SL / target.
 */

const { parseClockMinutes, isWeekendDateKey } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
} = require('../shared/intradayOptions');
const {
  buildPutBuyFilterContext,
  buildDayMetricsForKey,
  resolvePutBuyEntry,
  parseDirectionSettings,
} = require('./putBuyDayFilters');

const M920 = 560;
const EOD_EXIT = 920;

function runSimple920Backtest({ candles, settings }) {
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

  const entryFromMin = parseClockMinutes(settings.entryFromTime ?? settings.entryTime, M920);
  const entryToMin = parseClockMinutes(settings.entryToTime ?? settings.entryTime, entryFromMin);
  const normalizedFrom = Math.min(entryFromMin, entryToMin);
  const normalizedTo = Math.max(entryFromMin, entryToMin);

  const { minDirectionScore } = parseDirectionSettings(settings);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const filterCtx = buildPutBuyFilterContext(sortedKeys, intraByDay);
  const trades = [];
  let skippedDays = 0;
  let putTrades = 0;
  let callTrades = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 2) continue;

    const metrics = buildDayMetricsForKey(dayKey, dayBars, filterCtx);
    if (!metrics) continue;

    const entryDecision = resolvePutBuyEntry({
      dayBars,
      metrics,
      entryFromMin: normalizedFrom,
      entryToMin: normalizedTo,
      minDirectionScore,
    });

    if (entryDecision.skip) {
      skippedDays += 1;
      continue;
    }

    const entryIdx = entryDecision.entryIdx;
    const optionType = entryDecision.optionType || 'PE';

    if (optionType === 'CE') callTrades += 1;
    else putTrades += 1;

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
      }),
    );
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.minDirectionScore = minDirectionScore;
  summary.putTrades = putTrades;
  summary.callTrades = callTrades;

  return { trades, summary };
}

module.exports = { runSimple920Backtest };

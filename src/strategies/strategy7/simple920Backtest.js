/**
 * Strategy 3 (UI) — timed put/call buy at entry time (default 09:20 IST).
 * PE confirm on: bearish → long PE; otherwise → long CE. Off: always long PE.
 * Optional premium SL / target (blank target = hold to 15:20).
 */

const { getIstClock, parseClockMinutes, isWeekendDateKey } = require('../../utils/dateTime');
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
  parsePutBuyFilterSettings,
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

  const { filterPeConfirm } = parsePutBuyFilterSettings(settings);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const filterCtx = filterPeConfirm ? buildPutBuyFilterContext(sortedKeys, intraByDay) : null;
  const trades = [];
  let skippedDays = 0;
  let putTrades = 0;
  let callTrades = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 2) continue;

    let entryIdx;
    let optionType = 'PE';

    if (filterPeConfirm) {
      const metrics = buildDayMetricsForKey(dayKey, dayBars, filterCtx);
      if (!metrics) continue;

      const entryDecision = resolvePutBuyEntry({
        dayBars,
        filterPeConfirm,
        metrics,
        entryFromMin: normalizedFrom,
        entryToMin: normalizedTo,
      });

      if (entryDecision.skip) {
        skippedDays += 1;
        continue;
      }

      entryIdx = entryDecision.entryIdx;
      optionType = entryDecision.optionType || 'PE';
    } else {
      for (let j = 0; j < dayBars.length; j += 1) {
        const m = getIstClock(dayBars[j][0]).minutes;
        if (m >= normalizedFrom && m <= normalizedTo) {
          entryIdx = j;
          break;
        }
      }
      if (entryIdx == null || entryIdx >= dayBars.length - 1) continue;
    }

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
  if (filterPeConfirm) {
    summary.skippedDays = skippedDays;
    summary.filterPeConfirm = true;
    summary.putTrades = putTrades;
    summary.callTrades = callTrades;
  }

  return { trades, summary };
}

module.exports = { runSimple920Backtest };

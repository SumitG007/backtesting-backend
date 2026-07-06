/**
 * Strategy 6 (UI) — morning pattern stack: one CE or PE per day from research rules.
 */

const { isWeekendDateKey, buildIstWallClockTimestamp } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
} = require('../shared/intradayOptions');
const { buildMorningPatternContext, resolveMorningPattern, parsePatternConfig } = require('./morningPatternSignals');

const DEFAULT_STOP_LOSS_POINTS = 15;
const DEFAULT_TARGET_POINTS = 25;
const EOD_EXIT = 920;

function runMorningPatternBacktest({ candles, settings }) {
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
  const stopLossPoints = hasStopLoss ? Math.min(5000, Math.max(0.01, rawSl)) : DEFAULT_STOP_LOSS_POINTS;

  const rawTg = Number(settings.targetProfitPoints);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetPoints = hasTarget ? Math.min(5000, Math.max(0.01, rawTg)) : DEFAULT_TARGET_POINTS;

  const rawInterval = Number(settings.interval);
  const barIntervalMinutes = Number.isFinite(rawInterval) && rawInterval > 0
    ? rawInterval
    : Math.max(1, Number(settings.barIntervalMinutes) || 5);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const filterCtx = buildMorningPatternContext(sortedKeys, intraByDay);
  const patternConfig = parsePatternConfig(settings);

  const trades = [];
  const signalCounts = {};
  let skippedDays = 0;
  let putTrades = 0;
  let callTrades = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 2) {
      skippedDays += 1;
      continue;
    }

    const decision = resolveMorningPattern({
      dayKey,
      bars: dayBars,
      filterCtx,
      barIntervalMinutes,
      patternConfig,
      symbol,
    });

    if (decision.skip) {
      skippedDays += 1;
      continue;
    }

    const entryIdx = decision.entryIdx;
    const optionType = decision.optionType || 'PE';
    const entrySpot = Number(dayBars[entryIdx][1]) || Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) {
      skippedDays += 1;
      continue;
    }

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

    const trade = buildLongOptionTrade({
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
      entryTime: new Date(
        buildIstWallClockTimestamp(dayKey, decision.entryMinutes),
      ).toISOString(),
    });

    trade.signal = decision.signalId;
    trades.push(trade);
    signalCounts[decision.signalId] = (signalCounts[decision.signalId] || 0) + 1;
    if (optionType === 'CE') callTrades += 1;
    else putTrades += 1;
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.putTrades = putTrades;
  summary.callTrades = callTrades;
  summary.signalCounts = signalCounts;
  summary.stopLossPoints = hasStopLoss ? stopLossPoints : 0;
  summary.targetProfitPoints = hasTarget ? targetPoints : 0;
  summary.stackMode = patternConfig.stackMode;

  return { trades, summary };
}

module.exports = { runMorningPatternBacktest };

/**
 * Trail Scalp Put/Call — up to 10 intraday trades/day.
 * Each trade: SL 8 premium pts, trailing profit after +4 pts (trail by 2).
 * Entry signals use only completed 5m candles (no forming bar / no lookahead).
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
  evaluatePutBuyDirection,
  parseDirectionSettings,
  DEFAULT_BAR_INTERVAL_MINUTES,
} = require('../strategy7/putBuyDayFilters');
const { resolveEntryFill } = require('./entryFillRules');
const {
  parseMaxLossesPerSidePerDay,
  isOptionSideLocked,
  bothSidesLocked,
} = require('./trailScalpSideLockout');

const DEFAULT_ENTRY_FROM = 560; // 09:20 IST
const DEFAULT_ENTRY_TO = 915; // 15:15 IST
const EOD_EXIT = 920;
const DEFAULT_MAX_TRADES_PER_DAY = null;
const DEFAULT_STOP_LOSS_POINTS = 8;
const DEFAULT_TARGET_POINTS = 4;
const DEFAULT_TRAIL_STEP_POINTS = 2;

function isTruthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function resolveBarIntervalMinutes(settings = {}) {
  const raw = Number(settings.interval ?? settings.barIntervalMinutes);
  if (raw === 1 || raw === 5 || raw === 15) return raw;
  return DEFAULT_BAR_INTERVAL_MINUTES;
}

function runTrailScalpPutCallBacktest({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 5);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  const rawSl = Number(settings.stopLossPoints);
  const stopLossPoints =
    Number.isFinite(rawSl) && rawSl > 0
      ? Math.min(5000, Math.max(0.01, rawSl))
      : DEFAULT_STOP_LOSS_POINTS;
  const hasStopLoss = true;

  const rawTg = Number(settings.targetProfitPoints);
  const targetPoints =
    Number.isFinite(rawTg) && rawTg > 0
      ? Math.min(5000, Math.max(0.01, rawTg))
      : DEFAULT_TARGET_POINTS;
  const hasTarget = true;
  const rawTrailStep = Number(settings.trailingStepPoints);
  const trailingStepPoints =
    Number.isFinite(rawTrailStep) && rawTrailStep > 0
      ? Math.min(5000, Math.max(0.01, rawTrailStep))
      : DEFAULT_TRAIL_STEP_POINTS;
  const rawTrailActivation = Number(settings.trailingActivationPoints);
  const trailingActivationPoints =
    Number.isFinite(rawTrailActivation) && rawTrailActivation > 0
      ? Math.min(5000, Math.max(0.01, rawTrailActivation))
      : targetPoints;
  const trailingTargetEnabled =
    settings.trailingTargetEnabled == null ? true : isTruthy(settings.trailingTargetEnabled);

  const entryFromMin = parseClockMinutes(
    settings.entryFromTime ?? settings.entryTime,
    DEFAULT_ENTRY_FROM,
  );
  const entryToMin = parseClockMinutes(settings.entryToTime ?? settings.entryTime, DEFAULT_ENTRY_TO);
  const eodExitMinutes = parseClockMinutes(settings.eodExitTime, EOD_EXIT);
  const maxTradesPerDay = DEFAULT_MAX_TRADES_PER_DAY;
  const maxLossesPerSidePerDay = parseMaxLossesPerSidePerDay(settings);

  const { minDirectionScore, enabledPeSignals, enabledCeSignals } = parseDirectionSettings(settings);
  const barIntervalMinutes = resolveBarIntervalMinutes(settings);
  const fillSettings = { ...settings, entryFillMode: settings.entryFillMode || 'signal_close' };

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

    let dayTrades = 0;
    let peSlCount = 0;
    let ceSlCount = 0;
    let scanFrom = 0;
    let tookAnyTrade = false;

    const sideLockState = () => ({ peSlCount, ceSlCount, maxLossesPerSidePerDay });

    while (scanFrom < dayBars.length - 1) {
      if (maxTradesPerDay != null && dayTrades >= maxTradesPerDay) break;
      if (bothSidesLocked(sideLockState())) break;
      let tookTrade = false;

      for (let i = scanFrom; i < dayBars.length - 1; i += 1) {
        const barOpenMinutes = getIstClock(dayBars[i][0]).minutes;
        const decisionMinutes = barOpenMinutes + barIntervalMinutes;
        if (decisionMinutes < entryFromMin || decisionMinutes > entryToMin) continue;

        const entryDecision = evaluatePutBuyDirection({
          dayKey,
          dayBars,
          filterCtx,
          entryDecisionMinutes: decisionMinutes,
          minDirectionScore,
          enabledPeSignals,
          enabledCeSignals,
          barIntervalMinutes,
          requireFollowingBar: true,
        });

        if (entryDecision.skip || entryDecision.entryIdx == null || entryDecision.entryIdx < scanFrom) {
          continue;
        }

        const fill = resolveEntryFill({
          settings: fillSettings,
          entryDecision,
          dayBars,
          dayKey,
          entryDecisionMinutes: decisionMinutes,
        });
        if (fill.skip) continue;

        const optionType = entryDecision.optionType || 'PE';
        if (isOptionSideLocked(optionType, sideLockState())) continue;

        const { entryIdx, entrySpot, entryTimeIso } = fill;
        if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

        if (optionType === 'CE') callTrades += 1;
        else putTrades += 1;

        const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
        const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
        const stopPremium = Math.max(0.05, entryPremium - stopLossPoints);
        const targetPremium = entryPremium + targetPoints;
        const useTrailingTarget = trailingTargetEnabled && trailingStepPoints > 0;

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
          hasTarget: hasTarget && !useTrailingTarget,
          targetPremium: useTrailingTarget ? null : targetPremium,
          useIndexExits: false,
          stopIndex: null,
          targetIndex: null,
          trailSlGapPoints: useTrailingTarget ? trailingStepPoints : null,
          trailSlActivationPoints: useTrailingTarget ? trailingActivationPoints : null,
          eodExitMinutes,
          eodExitAtBarOpen: true,
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
            entryTime: entryTimeIso,
            barIntervalMinutes,
            eodExitMinutes,
            eodExitAtBarOpen: true,
            extra: {
              dayTradeNumber: dayTrades + 1,
              signalBarIdx: entryDecision.entryIdx,
              directionScore: Math.max(entryDecision.peScore || 0, entryDecision.ceScore || 0),
              entryFillMode: fillSettings.entryFillMode,
              trailingTargetEnabled: useTrailingTarget,
              trailingStepPoints: useTrailingTarget ? trailingStepPoints : 0,
              trailingActivationPoints: useTrailingTarget ? trailingActivationPoints : 0,
            },
          }),
        );

        dayTrades += 1;
        if (reason === 'STOP_LOSS') {
          if (optionType === 'CE') ceSlCount += 1;
          else peSlCount += 1;
        }
        tookAnyTrade = true;
        tookTrade = true;
        // Re-entry gate: next signal bar must be after the exit bar (paper live mirrors this).
        scanFrom = exitIdx + 1;
        break;
      }

      if (!tookTrade) break;
    }

    if (!tookAnyTrade) skippedDays += 1;
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.minDirectionScore = minDirectionScore;
  summary.putTrades = putTrades;
  summary.callTrades = callTrades;
  summary.maxTradesPerDay = maxTradesPerDay;
  summary.maxLossesPerSidePerDay = maxLossesPerSidePerDay;
  summary.stopLossPoints = stopLossPoints;
  summary.targetProfitPoints = targetPoints;
  summary.entryFromTime = settings.entryFromTime || '09:20';
  summary.entryToTime = settings.entryToTime || '15:15';
  summary.eodExitTime = settings.eodExitTime || '15:20';
  summary.entryFillMode = fillSettings.entryFillMode;
  summary.trailingTargetEnabled = trailingTargetEnabled;
  summary.trailingStepPoints = trailingTargetEnabled ? trailingStepPoints : 0;
  summary.trailingActivationPoints = trailingTargetEnabled ? trailingActivationPoints : 0;

  return { trades, summary };
}

module.exports = { runTrailScalpPutCallBacktest };

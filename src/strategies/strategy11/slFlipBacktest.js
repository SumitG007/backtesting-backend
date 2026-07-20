/**
 * Strategy 6 (UI) — SL Flip.
 * 09:20 buy CE. On STOP_LOSS → flip to opposite side immediately (same bar in backtest).
 * On TRAIL_STOP → same side immediately on exit bar. No new entries after 15:15; EOD 15:20.
 *
 * Stops: hard SL (default 8 pts). After +activation (default 4), move SL to peak − step (default 2).
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

const DEFAULT_ENTRY = 560; // 09:20
const ENTRY_CUTOFF = 915; // 15:15 — no new entries after this bar open
const EOD_EXIT = 920; // 15:20
const DEFAULT_SL = 8;
const DEFAULT_TRAIL_ACT = 4;
const DEFAULT_TRAIL_STEP = 2;
const BAR_INTERVAL = 5;

function findFirstEntryIdx(dayBars, entryFromMin) {
  for (let i = 0; i < dayBars.length - 1; i += 1) {
    const openM = getIstClock(dayBars[i][0]).minutes;
    if (openM >= entryFromMin && openM < ENTRY_CUTOFF) return i;
  }
  return -1;
}

function runSlFlipBacktest({ candles, settings }) {
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
    Number.isFinite(rawSl) && rawSl > 0 ? Math.min(5000, Math.max(0.01, rawSl)) : DEFAULT_SL;
  const rawTrailAct = Number(settings.trailingActivationPoints ?? settings.targetProfitPoints);
  const trailingActivationPoints =
    Number.isFinite(rawTrailAct) && rawTrailAct > 0
      ? Math.min(5000, Math.max(0.01, rawTrailAct))
      : DEFAULT_TRAIL_ACT;
  const rawTrailStep = Number(settings.trailingStepPoints);
  const trailingStepPoints =
    Number.isFinite(rawTrailStep) && rawTrailStep > 0
      ? Math.min(5000, Math.max(0.01, rawTrailStep))
      : DEFAULT_TRAIL_STEP;

  const entryFromMin = parseClockMinutes(
    settings.entryFromTime ?? settings.entryTime,
    DEFAULT_ENTRY,
  );
  const entryCutoffMin = parseClockMinutes(settings.entryToTime, ENTRY_CUTOFF);
  const eodExitMinutes = parseClockMinutes(settings.eodExitTime, EOD_EXIT);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];
  let skippedDays = 0;
  let putTrades = 0;
  let callTrades = 0;
  let slFlips = 0;
  let trailReentries = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 3) {
      skippedDays += 1;
      continue;
    }

    let entryIdx = findFirstEntryIdx(dayBars, entryFromMin);
    if (entryIdx < 0) {
      skippedDays += 1;
      continue;
    }

    let optionType = 'CE'; // always start Call at first entry
    let dayTrades = 0;
    let guard = 0;

    while (entryIdx >= 0 && entryIdx < dayBars.length - 1 && guard < 500) {
      guard += 1;
      const entryOpenM = getIstClock(dayBars[entryIdx][0]).minutes;
      if (entryOpenM >= entryCutoffMin) break;

      const entrySpot = Number(dayBars[entryIdx][1]); // bar open
      if (!Number.isFinite(entrySpot) || entrySpot <= 0) {
        entryIdx += 1;
        continue;
      }

      const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
      const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
      const stopPremium = Math.max(0.05, entryPremium - stopLossPoints);

      if (optionType === 'CE') callTrades += 1;
      else putTrades += 1;
      dayTrades += 1;

      const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
        dayBars,
        entryIdx,
        optionType,
        entrySpot,
        entryPremium,
        strike,
        strikeStep,
        premiumLeverage,
        hasStopLoss: true,
        stopPremium,
        hasTarget: false,
        targetPremium: null,
        useIndexExits: false,
        stopIndex: null,
        targetIndex: null,
        trailSlGapPoints: trailingStepPoints,
        trailSlActivationPoints: trailingActivationPoints,
        moveStopWithProfit: true,
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
          hasStopLoss: true,
          stopPremium,
          hasTarget: false,
          targetPremium: null,
          barIntervalMinutes: BAR_INTERVAL,
          eodExitMinutes,
          eodExitAtBarOpen: true,
          extra: {
            dayTradeNumber: dayTrades,
            flipMode: 'sl_flip',
            trailingTargetEnabled: true,
            trailingStepPoints,
            trailingActivationPoints,
            moveStopWithProfit: true,
          },
        }),
      );

      const exitReason = String(reason || '').toUpperCase();
      if (exitReason === 'DAY_CLOSE' || exitReason === 'EOD_EXIT') break;

      const safeExitIdx = Number.isFinite(exitIdx) ? exitIdx : entryIdx;
      if (exitReason === 'STOP_LOSS' || exitReason === 'BREAKEVEN_STOP') {
        // Flip opposite immediately — re-enter on the same exit bar (exits start next bar).
        optionType = optionType === 'CE' ? 'PE' : 'CE';
        entryIdx = safeExitIdx;
        slFlips += 1;
      } else if (exitReason === 'TRAIL_STOP' || exitReason === 'TARGET') {
        entryIdx = safeExitIdx;
        trailReentries += 1;
      } else {
        // Unknown / max-hold style — wait next bar, keep side.
        entryIdx = safeExitIdx + 1;
      }
    }
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.putTrades = putTrades;
  summary.callTrades = callTrades;
  summary.slFlips = slFlips;
  summary.trailReentries = trailReentries;
  summary.stopLossPoints = stopLossPoints;
  summary.targetProfitPoints = trailingActivationPoints;
  summary.trailingActivationPoints = trailingActivationPoints;
  summary.trailingStepPoints = trailingStepPoints;
  summary.moveStopWithProfit = true;
  summary.trailingTargetEnabled = true;
  summary.entryFromTime = settings.entryFromTime || settings.entryTime || '09:20';
  summary.entryToTime = settings.entryToTime || '15:15';
  summary.eodExitTime = settings.eodExitTime || '15:20';
  summary.maxTradesPerDay = null;
  summary.maxLossesPerSidePerDay = null;

  return { trades, summary };
}

module.exports = { runSlFlipBacktest };

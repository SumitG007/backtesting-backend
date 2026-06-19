/**
 * Strategy 4 (UI) — Heikin Ashi breakout / breakdown (long CE or long PE).
 * All signals, entries, SL, and exit simulation use HA candles only.
 */

const { getIstClock, parseClockMinutes, isWeekendDateKey } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
} = require('../shared/intradayOptions');
const { convertCandlesToHeikinAshi } = require('../shared/indicators');
const { findHeikinAshiSignal, validateHeikinAshiSignal, assertSignalHaColors, buildSignalAudit } = require('./heikinAshiLogic');
const { signalMatchesRules } = require('./heikinAshiRulesCheck');

const EOD_EXIT = 920;

function parseTrailSlGapPoints(settings) {
  const raw = settings?.trailSlGapPoints;
  if (raw === undefined || raw === null || raw === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

function barInEntryWindow(ts, fromMin, toMin) {
  const m = getIstClock(ts).minutes;
  return m >= fromMin && m <= toMin;
}

function runHeikinAshiBacktest({ candles, settings }) {
  const symbol = String(settings?.symbol || 'NIFTY').toUpperCase();
  const common = parseCommonOptionSettings(settings, symbol);
  const entryFromMin = parseClockMinutes(settings?.entryFromTime, 570);
  const entryToMin = parseClockMinutes(settings?.entryToTime, 780);
  const normalizedFrom = Math.min(entryFromMin, entryToMin);
  const normalizedTo = Math.max(entryFromMin, entryToMin);
  const trailSlGapPoints = parseTrailSlGapPoints(settings);
  const useTrailSl = trailSlGapPoints > 0;

  const rawCandles = Array.isArray(candles) ? candles : [];
  const intraByDay = buildIntradayByDay(rawCandles);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 4) continue;

    const haBars = convertCandlesToHeikinAshi(dayBars, { resetPerDay: true });

    let dayTrades = 0;
    let scanFrom = 1;

    while (scanFrom < haBars.length - 1 && dayTrades < common.maxTradesPerDay) {
      let tookTrade = false;

      for (let i = scanFrom; i < haBars.length - 1; i += 1) {
        const signal = findHeikinAshiSignal(haBars, i);
        if (!signal || !validateHeikinAshiSignal(haBars, signal)) continue;
        if (!assertSignalHaColors(signal, haBars)) continue;
        if (!signalMatchesRules(haBars, signal)) continue;

        const entryIdx = signal.entryIdx;
        const patternIdx = signal.patternIdx;

        if (entryIdx !== patternIdx + 1) continue;

        const signalBarTs = haBars[patternIdx][0];
        const breakoutBarTs = haBars[entryIdx][0];
        if (!barInEntryWindow(signalBarTs, normalizedFrom, normalizedTo)) continue;
        if (!barInEntryWindow(breakoutBarTs, normalizedFrom, normalizedTo)) continue;

        const entrySpot = signal.entrySpot;
        if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

        const optionType = signal.optionType;
        const strike = pickStrike({
          entrySpot,
          strikeStep: common.strikeStep,
          optionType,
          strikeMode: common.strikeMode,
        });
        const entryPremium = Math.max(0.05, (entrySpot * common.basePremiumPct) / 100);
        const targetPremium = common.hasTarget ? entryPremium + common.targetPoints : null;

        const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
          dayBars: haBars,
          entryIdx,
          optionType,
          entrySpot,
          entryPremium,
          strike,
          strikeStep: common.strikeStep,
          premiumLeverage: common.premiumLeverage,
          hasStopLoss: false,
          stopPremium: null,
          hasTarget: common.hasTarget,
          targetPremium,
          useIndexExits: true,
          stopIndex: signal.stopIndex,
          targetIndex: null,
          trailSlGapPoints: useTrailSl ? trailSlGapPoints : null,
          trailSlActivationPoints: useTrailSl ? trailSlGapPoints * 2 : null,
          eodExitMinutes: EOD_EXIT,
        });

        trades.push(
          buildLongOptionTrade({
            symbol,
            lotSize: common.lotSize,
            lotCount: common.lotCount,
            perTradeCost: common.perTradeCost,
            dayBars: haBars,
            entryIdx,
            optionType,
            strike,
            entrySpot,
            entryPremium,
            exitIdx,
            exitSpot,
            exitPremium,
            reason,
            hasStopLoss: false,
            stopPremium: null,
            hasTarget: common.hasTarget,
            targetPremium,
            extra: {
              ...buildSignalAudit(haBars, signal, {
                entrySpot,
                entryPremium,
                strike,
                strikeStep: common.strikeStep,
                premiumLeverage: common.premiumLeverage,
              }),
              breakoutBarTime: haBars[entryIdx][0],
              chartType: 'HEIKIN_ASHI',
            },
          }),
        );

        dayTrades += 1;
        scanFrom = exitIdx + 1;
        tookTrade = true;
        break;
      }

      if (!tookTrade) break;
    }
  }

  return {
    trades,
    summary: buildStrategyRunSummary(trades),
    meta: {
      maxTradesPerDay: common.maxTradesPerDay,
      entryFromTime: settings?.entryFromTime ?? '09:30',
      entryToTime: settings?.entryToTime ?? '13:00',
      chartType: 'HEIKIN_ASHI',
      trailSlGapPoints: useTrailSl ? trailSlGapPoints : 0,
    },
  };
}

module.exports = { runHeikinAshiBacktest };

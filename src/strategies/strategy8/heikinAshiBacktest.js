/**
 * Strategy 4 (UI) — Heikin Ashi breakout / breakdown (long CE or long PE).
 */

const { getIstClock, parseClockMinutes, isWeekendDateKey } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  sortExecCandlesChronologically,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
} = require('../shared/intradayOptions');
const { convertCandlesToHeikinAshi } = require('../shared/indicators');
const { findHeikinAshiSignal } = require('./heikinAshiLogic');

const EOD_EXIT = 920;

function buildHaBarsForDay(dayBars, haByTs) {
  return dayBars.map((c) => haByTs.get(c[0]) || c);
}

function runHeikinAshiBacktest({ candles, settings }) {
  const symbol = String(settings?.symbol || 'NIFTY').toUpperCase();
  const common = parseCommonOptionSettings(settings, symbol);
  const resetPerDay = settings?.resetPerDay !== false;
  const entryFromMin = parseClockMinutes(settings?.entryFromTime, 600);
  const entryToMin = parseClockMinutes(settings?.entryToTime, 780);
  const normalizedFrom = Math.min(entryFromMin, entryToMin);
  const normalizedTo = Math.max(entryFromMin, entryToMin);

  const rawCandles = Array.isArray(candles) ? candles : [];
  const intraByDay = buildIntradayByDay(rawCandles);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];

  let haByTs = null;
  if (!resetPerDay) {
    const sessionRows = sortExecCandlesChronologically(rawCandles);
    const haAll = convertCandlesToHeikinAshi(sessionRows, { resetPerDay: false });
    haByTs = new Map(haAll.map((c) => [c[0], c]));
  }

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 4) continue;

    const haBars = resetPerDay
      ? convertCandlesToHeikinAshi(dayBars, { resetPerDay: true })
      : buildHaBarsForDay(dayBars, haByTs);

    let dayTrades = 0;
    let scanFrom = 1;

    while (scanFrom < dayBars.length - 1 && dayTrades < common.maxTradesPerDay) {
      let tookTrade = false;

      for (let i = scanFrom; i < dayBars.length - 1; i += 1) {
        const signal = findHeikinAshiSignal(haBars, i);
        if (!signal) continue;

        const entryIdx = signal.entryIdx;
        const entryClock = getIstClock(dayBars[entryIdx][0]);
        if (entryClock.minutes < normalizedFrom || entryClock.minutes > normalizedTo) continue;

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
        const stopPremium = common.hasStopLoss
          ? Math.max(0.05, entryPremium - common.stopLossPoints)
          : null;

        const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
          dayBars,
          entryIdx,
          optionType,
          entrySpot,
          entryPremium,
          strike,
          strikeStep: common.strikeStep,
          premiumLeverage: common.premiumLeverage,
          hasStopLoss: common.hasStopLoss,
          stopPremium,
          hasTarget: common.hasTarget,
          targetPremium,
          useIndexExits: true,
          stopIndex: signal.stopIndex,
          targetIndex: null,
          eodExitMinutes: EOD_EXIT,
        });

        trades.push(
          buildLongOptionTrade({
            symbol,
            lotSize: common.lotSize,
            lotCount: common.lotCount,
            perTradeCost: common.perTradeCost,
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
            hasStopLoss: common.hasStopLoss,
            stopPremium,
            hasTarget: common.hasTarget,
            targetPremium,
            extra: {
              signal: signal.reason,
              patternStopIndex: Number(signal.stopIndex.toFixed(2)),
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
      resetPerDay,
      maxTradesPerDay: common.maxTradesPerDay,
      entryFromTime: settings?.entryFromTime ?? '10:00',
      entryToTime: settings?.entryToTime ?? '13:00',
    },
  };
}

module.exports = { runHeikinAshiBacktest };

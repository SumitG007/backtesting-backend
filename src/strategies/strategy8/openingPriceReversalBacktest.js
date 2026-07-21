/**
 * Strategy 4 (UI) — 15-minute Opening Price Reversal.
 * Window: 09:15–09:30 IST. Path scanned on 1m bars (order of first move + re-cross).
 * Above-open first then cross below → ATM PE. Below-open first then cross above → ATM CE.
 * Exit at 09:30 window close, or 15% stop on option premium.
 */

const { getIstClock, isWeekendDateKey } = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
} = require('../shared/intradayOptions');

const WINDOW_FROM = 555; // 09:15
const WINDOW_TO = 570; // 09:30 (exclusive for entry; EOD exit at >= 570)
const DEFAULT_STOP_LOSS_PCT = 15;

/**
 * Detect first excursion away from open, then re-cross within 09:15–09:30.
 * @returns {{ optionType: 'CE'|'PE', entryIdx: number, openRef: number, firstSide: string } | null}
 */
function detectOpeningReversal(dayBars) {
  const windowIdx = [];
  for (let i = 0; i < dayBars.length; i += 1) {
    const m = getIstClock(dayBars[i][0]).minutes;
    if (m >= WINDOW_FROM && m < WINDOW_TO) windowIdx.push(i);
  }
  if (windowIdx.length < 1) return null;

  const openRef = Number(dayBars[windowIdx[0]][1]);
  if (!Number.isFinite(openRef) || openRef <= 0) return null;

  let firstSide = null;

  for (const i of windowIdx) {
    const bar = dayBars[i];
    const hi = Number(bar[2]);
    const lo = Number(bar[3]);
    const cl = Number(bar[4]);
    if (![hi, lo].every(Number.isFinite)) continue;

    const touchedAbove = hi > openRef;
    const touchedBelow = lo < openRef;

    if (firstSide == null) {
      // Confirm first move by close beyond open (avoids open-bar dual-wick false reverse).
      if (Number.isFinite(cl) && cl > openRef) firstSide = 'ABOVE';
      else if (Number.isFinite(cl) && cl < openRef) firstSide = 'BELOW';
      else if (touchedAbove && !touchedBelow) firstSide = 'ABOVE';
      else if (touchedBelow && !touchedAbove) firstSide = 'BELOW';
      continue;
    }

    if (firstSide === 'ABOVE' && touchedBelow) {
      return { optionType: 'PE', entryIdx: i, openRef, firstSide };
    }
    if (firstSide === 'BELOW' && touchedAbove) {
      return { optionType: 'CE', entryIdx: i, openRef, firstSide };
    }
  }

  return null;
}

function runOpeningPriceReversalBacktest({ candles, settings }) {
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

  const rawSlPct = Number(settings.stopLossPct);
  const stopLossPct =
    Number.isFinite(rawSlPct) && rawSlPct > 0
      ? Math.min(90, Math.max(0.1, rawSlPct))
      : DEFAULT_STOP_LOSS_PCT;

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];
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

    const signal = detectOpeningReversal(dayBars);
    if (!signal) {
      skippedDays += 1;
      continue;
    }

    const { optionType, entryIdx, openRef, firstSide } = signal;
    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) {
      skippedDays += 1;
      continue;
    }

    if (optionType === 'CE') callTrades += 1;
    else putTrades += 1;

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
    const stopPremium = Math.max(0.05, entryPremium * (1 - stopLossPct / 100));

    const { exitIdx, exitSpot, exitPremium, reason: rawReason } = simulateLongOptionExit({
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
      eodExitMinutes: WINDOW_TO,
    });

    const reason = rawReason === 'DAY_CLOSE' ? 'OPENING_15M_CLOSE' : rawReason;

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
        barIntervalMinutes: 1,
        eodExitMinutes: WINDOW_TO,
        extra: {
          openRef: Number(openRef.toFixed(2)),
          firstSide,
          stopLossPct,
          windowFrom: '09:15',
          windowTo: '09:30',
        },
      }),
    );
  }

  const summary = {
    ...buildStrategyRunSummary(trades),
    skippedDays,
    putTrades,
    callTrades,
    stopLossPct,
    windowFrom: '09:15',
    windowTo: '09:30',
    pathInterval: '1',
  };

  return { trades, summary };
}

module.exports = {
  runOpeningPriceReversalBacktest,
  detectOpeningReversal,
};

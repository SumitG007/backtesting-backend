/**
 * Strategy 5 (UI) — One-Side Candle Scalp.
 * On each completed 5m bar in the scan window:
 *   GREEN → buy ATM CE only
 *   RED   → buy ATM PE only
 *   DOJI  → skip
 * Then trail / SL on later bar closes (same 5m grid as backtest).
 * Never opens CE+PE together.
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

const DEFAULT_ENTRY_FROM = 560; // 09:20
const DEFAULT_ENTRY_TO = 915; // 15:15
const EOD_EXIT = 920; // 15:20
const DEFAULT_DOJI_BODY_PCT = 0.2;
const DEFAULT_SL = 15;
const DEFAULT_TRAIL_ACT = 2;
const DEFAULT_TRAIL_STEP = 2;
const BAR_INTERVAL = 5;

function classifyConfirmCandle(bar, dojiBodyMaxPct) {
  const o = Number(bar[1]);
  const h = Number(bar[2]);
  const l = Number(bar[3]);
  const c = Number(bar[4]);
  if (![o, h, l, c].every(Number.isFinite) || h < l) return { kind: 'DOJI', bodyPct: 1 };
  const range = h - l;
  const body = Math.abs(c - o);
  const bodyPct = range > 0 ? body / range : 0;
  if (range <= 0 || bodyPct < dojiBodyMaxPct || c === o) {
    return { kind: 'DOJI', bodyPct };
  }
  if (c > o) return { kind: 'GREEN', bodyPct };
  return { kind: 'RED', bodyPct };
}

function runOneSideCandleScalpBacktest({ candles, settings }) {
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

  const rawDoji = Number(settings.dojiBodyMaxPct);
  const dojiBodyMaxPct =
    Number.isFinite(rawDoji) && rawDoji > 0
      ? Math.min(0.99, rawDoji > 1 ? rawDoji / 100 : rawDoji)
      : DEFAULT_DOJI_BODY_PCT;

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
    DEFAULT_ENTRY_FROM,
  );
  const entryToMin = parseClockMinutes(settings.entryToTime, DEFAULT_ENTRY_TO);
  const eodExitMinutes = parseClockMinutes(settings.eodExitTime, EOD_EXIT);
  const barIntervalMinutes = BAR_INTERVAL;

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];
  let skippedDays = 0;
  let putTrades = 0;
  let callTrades = 0;
  let dojiSkips = 0;
  let greenEntries = 0;
  let redEntries = 0;

  for (const dayKey of sortedKeys) {
    if (isWeekendDateKey(dayKey) || !isNseCashTradingDay(dayKey)) continue;
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 3) {
      skippedDays += 1;
      continue;
    }

    let scanFrom = 0;
    let dayTrades = 0;

    while (scanFrom < dayBars.length - 1) {
      let signalIdx = -1;
      for (let i = Math.max(0, scanFrom); i < dayBars.length - 1; i += 1) {
        const openM = getIstClock(dayBars[i][0]).minutes;
        const decisionM = openM + barIntervalMinutes;
        if (decisionM < entryFromMin) continue;
        if (decisionM > entryToMin) break;
        // Need at least one bar after signal for management before EOD.
        if (openM + barIntervalMinutes * 2 > eodExitMinutes) continue;
        signalIdx = i;
        break;
      }
      if (signalIdx < 0) break;

      const signalBar = dayBars[signalIdx];
      const confirm = classifyConfirmCandle(signalBar, dojiBodyMaxPct);
      if (confirm.kind === 'DOJI') {
        dojiSkips += 1;
        scanFrom = signalIdx + 1;
        continue;
      }

      const optionType = confirm.kind === 'GREEN' ? 'CE' : 'PE';
      if (confirm.kind === 'GREEN') greenEntries += 1;
      else redEntries += 1;

      const entrySpot = Number(signalBar[4]); // signal close
      if (!Number.isFinite(entrySpot) || entrySpot <= 0) {
        scanFrom = signalIdx + 1;
        continue;
      }

      const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
      const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
      const stopPremium = Math.max(0.05, entryPremium - stopLossPoints);
      const entryTimeIso = new Date(
        new Date(signalBar[0]).getTime() + barIntervalMinutes * 60 * 1000,
      ).toISOString();

      if (optionType === 'CE') callTrades += 1;
      else putTrades += 1;
      dayTrades += 1;

      const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
        dayBars,
        entryIdx: signalIdx,
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
          entryIdx: signalIdx,
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
          entryTime: entryTimeIso,
          barIntervalMinutes,
          eodExitMinutes,
          eodExitAtBarOpen: true,
          extra: {
            dayTradeNumber: dayTrades,
            candleKind: confirm.kind,
            bodyPct: Number(confirm.bodyPct.toFixed(4)),
            dojiBodyMaxPct,
            trailingTargetEnabled: true,
            trailingStepPoints,
            trailingActivationPoints,
          },
        }),
      );

      scanFrom = Math.max(signalIdx + 1, (exitIdx ?? signalIdx) + 1);
    }
  }

  const summary = buildStrategyRunSummary(trades);
  summary.skippedDays = skippedDays;
  summary.putTrades = putTrades;
  summary.callTrades = callTrades;
  summary.dojiSkips = dojiSkips;
  summary.greenEntries = greenEntries;
  summary.redEntries = redEntries;
  summary.stopLossPoints = stopLossPoints;
  summary.targetProfitPoints = trailingActivationPoints;
  summary.trailingActivationPoints = trailingActivationPoints;
  summary.trailingStepPoints = trailingStepPoints;
  summary.trailingTargetEnabled = true;
  summary.dojiBodyMaxPct = dojiBodyMaxPct;
  summary.entryFromTime = settings.entryFromTime || settings.entryTime || '09:20';
  summary.entryToTime = settings.entryToTime || '15:15';
  summary.eodExitTime = settings.eodExitTime || '15:20';
  summary.maxTradesPerDay = null;
  summary.maxLossesPerSidePerDay = null;

  return { trades, summary };
}

module.exports = { runOneSideCandleScalpBacktest, classifyConfirmCandle };

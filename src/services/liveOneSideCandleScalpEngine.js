/**
 * Strategy 5 (UI) — One-Side Candle Scalp paper live.
 * Live id: strategy-5
 *
 * On each NEW completed 5m candle (after engine start):
 *   GREEN → buy ATM CE only
 *   RED   → buy ATM PE only
 *   DOJI  → skip
 * Exits on later 5m bar closes (option high/low) — bar_close parity with backtest.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey, buildIstWallClockTimestamp } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const { getStrikeStep } = require('../utils/market');
const { pickStrike } = require('../strategies/shared/intradayOptions');
const { classifyConfirmCandle } = require('../strategies/strategy9/oneSideCandleScalpBacktest');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');
const { fetchTradingDayCandles } = require('./dhanDataService');
const { STRATEGY_NINE_CANDLE_SCALP_LIVE_KEY } = require('../strategies/keys');

const STRATEGY_KEY = STRATEGY_NINE_CANDLE_SCALP_LIVE_KEY;
const OPTION_SUB_KEY = 'engine:strategy9:candle:option';
const POLL_INTERVAL_MS = 5000;
const POSITION_POLL_MS = 3000;
const CANDLE_REFRESH_MIN_GAP_MS = 12000;
const TICK_FRESH_MS = 45000;
const SESSION_START_MIN = 555;
const BAR_INTERVAL = 5;
const DEFAULT_ENTRY_FROM = 560;
const DEFAULT_ENTRY_TO = 915;
const EOD_EXIT = 920;
const DEFAULT_DOJI = 0.2;
const DEFAULT_SL = 15;
const DEFAULT_TRAIL_ACT = 2;
const DEFAULT_TRAIL_STEP = 2;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  settings: {},
  lotSize: 65,
  expiry: null,
  lastSpot: null,
  todayBars: [],
  lastCandleFetchAt: 0,
  sessionDateKey: null,
  /** First signal-bar open minutes allowed (skip mid-session catch-up on boot). */
  earliestSignalBarOpenMinutes: null,
  /** Last signal-bar open we already acted on (entry or doji skip). */
  lastProcessedSignalBarOpenMinutes: null,
  openTradeId: null,
  entryDecisionMinutes: null,
  peakProfitPoints: 0,
  trailStopPremium: null,
  optionExitBarOpenMinutes: null,
  optionBarHighLtp: null,
  optionBarLowLtp: null,
  pendingExitBar: null,
  lastExitEvalBarCloseMinutes: null,
  lastOptionTick: null,
  openPositionMark: null,
  pollTimer: null,
  positionPollTimer: null,
  enteringTrade: false,
  closingTrade: false,
  lastError: null,
  lastSignalAt: null,
  dayTradeCount: 0,
};

function istLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logLine(line, payload = {}) {
  console.log(`[CandleScalpPaperLive] ${line}`, JSON.stringify({ at: new Date().toISOString(), line, ...payload }));
}

function normalizeSettings(settings = {}) {
  const rawDoji = Number(settings.dojiBodyMaxPct);
  const dojiBodyMaxPct =
    Number.isFinite(rawDoji) && rawDoji > 0
      ? Math.min(0.99, rawDoji > 1 ? rawDoji / 100 : rawDoji)
      : DEFAULT_DOJI;
  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount: Math.max(1, Number(settings.lotCount) || 5),
    entryFromTime: String(settings.entryFromTime || '09:20'),
    entryToTime: String(settings.entryToTime || '15:15'),
    eodExitTime: String(settings.eodExitTime || '15:20'),
    stopLossPoints: Math.max(0.01, Number(settings.stopLossPoints) || DEFAULT_SL),
    trailingActivationPoints: Math.max(
      0.01,
      Number(settings.trailingActivationPoints ?? settings.targetProfitPoints) || DEFAULT_TRAIL_ACT,
    ),
    trailingStepPoints: Math.max(0.01, Number(settings.trailingStepPoints) || DEFAULT_TRAIL_STEP),
    dojiBodyMaxPct,
    strikeMode: String(settings.strikeMode || 'ATM'),
    perTradeCost:
      Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
        ? Number(settings.perTradeCost)
        : 100,
  };
}

function fiveMinBarOpenMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return null;
  if (m < SESSION_START_MIN) return SESSION_START_MIN;
  return Math.floor((m - SESSION_START_MIN) / BAR_INTERVAL) * BAR_INTERVAL + SESSION_START_MIN;
}

function entryFromMin() {
  return parseClockMinutes(engineState.settings.entryFromTime, DEFAULT_ENTRY_FROM);
}

function entryToMin() {
  return parseClockMinutes(engineState.settings.entryToTime, DEFAULT_ENTRY_TO);
}

function eodExitMinutes() {
  return parseClockMinutes(engineState.settings.eodExitTime, EOD_EXIT);
}

function isEod(minutes) {
  return minutes >= eodExitMinutes();
}

function canSignalOnBar(barOpenMinutes) {
  const decisionM = barOpenMinutes + BAR_INTERVAL;
  if (decisionM < entryFromMin() || decisionM > entryToMin()) return false;
  if (barOpenMinutes + BAR_INTERVAL * 2 > eodExitMinutes()) return false;
  return true;
}

function premiumFromChain(chain, optionType) {
  const t = String(optionType).toUpperCase();
  const v = t === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function ensureWallet() {
  const walletKey = 'paper_live_strategy9';
  let wallet = await LiveWallet.findOne({ walletKey });
  if (!wallet) wallet = await LiveWallet.create({ walletKey });
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

async function persistSettingsToWallet() {
  const wallet = await ensureWallet();
  wallet.strategy9EngineSettings = { ...engineState.settings };
  await wallet.save();
}

async function loadSettingsFromWallet() {
  const wallet = await ensureWallet();
  const raw = wallet.strategy9EngineSettings
    ? wallet.strategy9EngineSettings.toObject?.() || wallet.strategy9EngineSettings
    : {};
  // Old Trail Scalp Put/Call wallet may lack doji — align to Candle Scalp defaults once.
  const legacyTrailWithoutDoji =
    raw
    && typeof raw === 'object'
    && Object.keys(raw).length > 0
    && (raw.dojiBodyMaxPct == null || raw.dojiBodyMaxPct === undefined);
  const source = legacyTrailWithoutDoji
    ? {
        ...raw,
        stopLossPoints: DEFAULT_SL,
        trailingActivationPoints: DEFAULT_TRAIL_ACT,
        trailingStepPoints: DEFAULT_TRAIL_STEP,
        dojiBodyMaxPct: DEFAULT_DOJI,
        entryFromTime: raw.entryFromTime || '09:20',
        entryToTime: raw.entryToTime || '15:15',
        eodExitTime: raw.eodExitTime || '15:20',
        lotCount: raw.lotCount || 5,
        perTradeCost: raw.perTradeCost ?? 100,
        strikeMode: raw.strikeMode || 'ATM',
      }
    : raw;
  engineState.settings = normalizeSettings(source);
  engineState.symbol = engineState.settings.symbol;
  if (legacyTrailWithoutDoji) {
    await persistSettingsToWallet();
    logLine('SETTINGS_MIGRATED_TO_CANDLE_SCALP_DEFAULTS', engineState.settings);
  }
}

function resetSessionIfNewDay(clock) {
  if (engineState.sessionDateKey === clock.dateKey) return;
  engineState.sessionDateKey = clock.dateKey;
  engineState.todayBars = [];
  engineState.lastCandleFetchAt = 0;
  engineState.lastProcessedSignalBarOpenMinutes = null;
  engineState.dayTradeCount = 0;
  const forming = fiveMinBarOpenMinutes(clock.minutes);
  engineState.earliestSignalBarOpenMinutes =
    clock.minutes < entryFromMin() ? entryFromMin() - BAR_INTERVAL : forming + BAR_INTERVAL;
}

async function refreshTodayCandles(clock, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - engineState.lastCandleFetchAt < CANDLE_REFRESH_MIN_GAP_MS) return;
  try {
    const rows = await fetchTradingDayCandles({
      symbol: engineState.symbol,
      interval: '5',
      dateKey: clock.dateKey,
    });
    engineState.todayBars = Array.isArray(rows) ? rows : [];
    engineState.lastCandleFetchAt = now;
  } catch (err) {
    engineState.lastError = `Candles: ${err.message}`;
  }
}

function findCompletedSignalBars(clock) {
  const out = [];
  for (const bar of engineState.todayBars) {
    const openM = getIstClock(bar[0]).minutes;
    const decisionM = openM + BAR_INTERVAL;
    if (clock.minutes < decisionM) continue;
    if (!canSignalOnBar(openM)) continue;
    if (
      engineState.earliestSignalBarOpenMinutes != null
      && openM < engineState.earliestSignalBarOpenMinutes
    ) {
      continue;
    }
    if (
      engineState.lastProcessedSignalBarOpenMinutes != null
      && openM <= engineState.lastProcessedSignalBarOpenMinutes
    ) {
      continue;
    }
    out.push({ bar, openM, decisionM });
  }
  out.sort((a, b) => a.openM - b.openM);
  return out;
}

async function getOpenTrade() {
  if (engineState.openTradeId) {
    const t = await LivePaperTrade.findById(engineState.openTradeId);
    if (t && !t.exitTime) return t;
  }
  return LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).sort({ entryTime: -1 });
}

function resetBarExitState() {
  engineState.optionExitBarOpenMinutes = null;
  engineState.optionBarHighLtp = null;
  engineState.optionBarLowLtp = null;
  engineState.pendingExitBar = null;
  engineState.lastExitEvalBarCloseMinutes = null;
}

function syncOptionBarExtremes(clock, ltp) {
  const px = Number(ltp);
  if (!Number.isFinite(px) || px <= 0) return false;
  const barOpen = fiveMinBarOpenMinutes(clock.minutes);
  let rolled = false;
  if (engineState.optionExitBarOpenMinutes == null) {
    engineState.optionExitBarOpenMinutes = barOpen;
    engineState.optionBarHighLtp = px;
    engineState.optionBarLowLtp = px;
  } else if (barOpen > engineState.optionExitBarOpenMinutes) {
    engineState.pendingExitBar = {
      open: engineState.optionExitBarOpenMinutes,
      close: engineState.optionExitBarOpenMinutes + BAR_INTERVAL,
      high: engineState.optionBarHighLtp,
      low: engineState.optionBarLowLtp,
    };
    engineState.optionExitBarOpenMinutes = barOpen;
    engineState.optionBarHighLtp = px;
    engineState.optionBarLowLtp = px;
    rolled = true;
  } else {
    engineState.optionBarHighLtp = Math.max(engineState.optionBarHighLtp ?? px, px);
    engineState.optionBarLowLtp = Math.min(engineState.optionBarLowLtp ?? px, px);
  }
  return rolled;
}

function updateTrail(entryPremium, barHigh) {
  const act = engineState.settings.trailingActivationPoints;
  const step = engineState.settings.trailingStepPoints;
  const profit = Number(barHigh) - Number(entryPremium);
  if (profit > engineState.peakProfitPoints) engineState.peakProfitPoints = profit;
  if (engineState.peakProfitPoints >= act) {
    engineState.trailStopPremium = Number(entryPremium) + engineState.peakProfitPoints - step;
  }
}

async function getMarkPremium(trade) {
  if (engineState.lastOptionTick && Date.now() - engineState.lastOptionTick.ts < TICK_FRESH_MS) {
    return engineState.lastOptionTick.ltp;
  }
  try {
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    return premiumFromChain(chain, trade.optionType);
  } catch {
    return null;
  }
}

function clearSubs() {
  unsubscribeLiveSymbol(OPTION_SUB_KEY);
}

async function subscribeOpenOption(trade) {
  clearSubs();
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType: trade.optionType,
    });
    subscribeLiveInstrument({
      key: OPTION_SUB_KEY,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: (tick) => {
        const ltp = Number(tick.ltp);
        if (!Number.isFinite(ltp) || ltp <= 0) return;
        engineState.lastOptionTick = { ltp, ts: Date.now() };
        const clock = getIstClock(new Date());
        syncOptionBarExtremes(clock, ltp);
      },
    });
  } catch (err) {
    engineState.lastError = `WS: ${err.message}`;
  }
}

async function finalizeTrade(trade, { exitPremium, reason }) {
  const safeExit = Math.max(0.05, Number(exitPremium) || Number(trade.entryPremium) || 0.05);
  const entry = Number(trade.entryPremium) || 0;
  const qty = Number(trade.qty) || 0;
  const charges = Math.max(0, Number(trade.charges) || 0);
  const pnl = (safeExit - entry) * qty - charges;
  const clock = getIstClock(new Date());
  trade.status = 'CLOSED';
  trade.exitPremium = Number(safeExit.toFixed(2));
  trade.exitSpot = Number(trade.entrySpot || 0);
  trade.exitTime = new Date();
  trade.exitDateKey = clock.dateKey;
  trade.reason = reason;
  trade.finalValue = Number((safeExit * qty).toFixed(2));
  trade.pnl = Number(pnl.toFixed(2));
  trade.pnlPct = entry > 0 ? Number((((safeExit - entry) / entry) * 100).toFixed(2)) : 0;
  trade.openPositionMark = null;
  trade.openPositionMarkAt = null;
  await trade.save();

  engineState.openTradeId = null;
  engineState.entryDecisionMinutes = null;
  engineState.peakProfitPoints = 0;
  engineState.trailStopPremium = null;
  engineState.openPositionMark = null;
  resetBarExitState();
  clearSubs();
  stopPositionPoll();

  const forming = fiveMinBarOpenMinutes(clock.minutes);
  engineState.earliestSignalBarOpenMinutes = forming + BAR_INTERVAL;

  await recalcWalletFromTrades();
  logLine('EXIT', { reason, exitPremium: safeExit, pnl: trade.pnl, ist: istLabel(clock) });
  return trade;
}

async function placeLongOption(clock, { optionType, signalBarOpen, candleKind }) {
  if (engineState.enteringTrade || engineState.openTradeId) return { ok: false, reason: 'BUSY' };
  engineState.enteringTrade = true;
  try {
    const open = await getOpenTrade();
    if (open) {
      engineState.openTradeId = open._id.toString();
      return { ok: false, reason: 'ALREADY_OPEN' };
    }

    const symbol = engineState.symbol;
    const expiry = await getNearestWeeklyExpiry(symbol);
    engineState.expiry = expiry;
    const spotChain = await getAtmPremiums({ symbol, strike: 0, expiry });
    const spot = Number(spotChain.chainSpot || spotChain.spot);
    if (!Number.isFinite(spot) || spot <= 0) {
      logLine('ENTRY_FAIL', { reason: 'NO_SPOT', ist: istLabel(clock) });
      return { ok: false, reason: 'NO_SPOT' };
    }
    engineState.lastSpot = spot;
    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = engineState.settings.lotCount;
    const qty = lotSize * lots;
    const strike = pickStrike({
      entrySpot: spot,
      strikeStep: getStrikeStep(symbol),
      optionType,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      logLine('ENTRY_FAIL', { reason: `NO_${optionType}`, strike });
      return { ok: false, reason: `NO_${optionType}` };
    }
    const decisionM = signalBarOpen + BAR_INTERVAL;
    const stopLossPremium = Math.max(0.05, entryPremium - engineState.settings.stopLossPoints);
    const doc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType,
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(buildIstWallClockTimestamp(clock.dateKey, decisionM)),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(engineState.settings.perTradeCost.toFixed(2)),
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: null,
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `candleScalp; signalBar=${signalBarOpen}; candle=${candleKind}; trail`,
    });

    engineState.openTradeId = doc._id.toString();
    engineState.entryDecisionMinutes = decisionM;
    engineState.dayTradeCount += 1;
    engineState.lastSignalAt = new Date();
    engineState.peakProfitPoints = 0;
    engineState.trailStopPremium = null;
    resetBarExitState();
    syncOptionBarExtremes(clock, entryPremium);
    await subscribeOpenOption(doc);
    startPositionPoll();
    logLine('ENTRY', {
      ist: istLabel(clock),
      optionType,
      candleKind,
      signalBarOpen,
      entryPremium,
      strike,
    });
    return { ok: true };
  } catch (err) {
    engineState.lastError = err.message;
    logLine('ENTRY_EXCEPTION', { error: err.message });
    return { ok: false, reason: 'EXCEPTION' };
  } finally {
    engineState.enteringTrade = false;
  }
}

async function processNewSignalBars(clock) {
  if (engineState.openTradeId || engineState.enteringTrade) return;
  await refreshTodayCandles(clock, { force: true });
  const pending = findCompletedSignalBars(clock);
  if (!pending.length) return;

  // Process oldest unanswered signal only (stay in sync with sequential backtest).
  const next = pending[0];
  const cls = classifyConfirmCandle(next.bar, engineState.settings.dojiBodyMaxPct);
  logLine('SIGNAL', {
    ist: istLabel(clock),
    kind: cls.kind,
    bodyPct: cls.bodyPct,
    barOpen: next.openM,
  });

  if (cls.kind === 'DOJI') {
    // Intentional skip — advance so we do not re-read the same doji forever.
    engineState.lastProcessedSignalBarOpenMinutes = next.openM;
    return;
  }

  const optionType = cls.kind === 'GREEN' ? 'CE' : 'PE';
  const placed = await placeLongOption(clock, {
    optionType,
    signalBarOpen: next.openM,
    candleKind: cls.kind,
  });
  // Only consume the signal after a real fill. Entry failures (no spot/LTP) retry next poll.
  if (placed?.ok) {
    engineState.lastProcessedSignalBarOpenMinutes = next.openM;
  }
}

async function evaluateBarCloseExit(trade, clock) {
  const ltp = await getMarkPremium(trade);
  if (Number.isFinite(ltp) && ltp > 0) syncOptionBarExtremes(clock, ltp);

  // If the bar just rolled but we have no pending yet (e.g. first tick of new bar),
  // synthesize completion from tracked extremes when wall-clock has left the tracked bar.
  if (!engineState.pendingExitBar && engineState.optionExitBarOpenMinutes != null) {
    const forming = fiveMinBarOpenMinutes(clock.minutes);
    if (forming > engineState.optionExitBarOpenMinutes) {
      engineState.pendingExitBar = {
        open: engineState.optionExitBarOpenMinutes,
        close: engineState.optionExitBarOpenMinutes + BAR_INTERVAL,
        high: engineState.optionBarHighLtp,
        low: engineState.optionBarLowLtp,
      };
      engineState.optionExitBarOpenMinutes = forming;
      engineState.optionBarHighLtp = Number.isFinite(ltp) && ltp > 0 ? ltp : engineState.optionBarHighLtp;
      engineState.optionBarLowLtp = Number.isFinite(ltp) && ltp > 0 ? ltp : engineState.optionBarLowLtp;
    }
  }

  const completed = engineState.pendingExitBar;
  if (!completed) return;

  const entryDecision = Number(engineState.entryDecisionMinutes);
  if (Number.isFinite(entryDecision) && completed.close <= entryDecision) {
    engineState.pendingExitBar = null;
    return;
  }
  if (engineState.lastExitEvalBarCloseMinutes === completed.close) {
    engineState.pendingExitBar = null;
    return;
  }
  engineState.lastExitEvalBarCloseMinutes = completed.close;
  engineState.pendingExitBar = null;

  const barHigh = Number(completed.high);
  const barLow = Number(completed.low);
  if (![barHigh, barLow].every((n) => Number.isFinite(n) && n > 0)) return;

  const entryPremium = Number(trade.entryPremium);
  updateTrail(entryPremium, barHigh);

  if (engineState.trailStopPremium != null && barLow <= engineState.trailStopPremium) {
    await finalizeTrade(trade, {
      exitPremium: Number(engineState.trailStopPremium),
      reason: 'TRAIL_STOP',
    });
    return;
  }
  if (trade.stopLossPremium != null && barLow <= Number(trade.stopLossPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.stopLossPremium),
      reason: 'STOP_LOSS',
    });
  }
}

async function checkOpenTrade() {
  if (engineState.closingTrade) return;
  const trade = await getOpenTrade();
  if (!trade || trade.exitTime) {
    engineState.openTradeId = null;
    return;
  }
  engineState.openTradeId = trade._id.toString();
  const clock = getIstClock(new Date());

  const ltp = await getMarkPremium(trade);
  if (Number.isFinite(ltp) && ltp > 0) {
    const entry = Number(trade.entryPremium);
    const mark = {
      at: new Date().toISOString(),
      source: engineState.lastOptionTick ? 'websocket' : 'chain',
      isLiveMark: true,
      optionType: trade.optionType,
      optionLtp: Number(ltp.toFixed(2)),
      entryPremium: entry,
      unrealizedPnl: Number(((ltp - entry) * trade.qty - (trade.charges || 0)).toFixed(2)),
      stopLossPremium: trade.stopLossPremium,
      trailStopPremium: engineState.trailStopPremium,
      peakProfitPoints: engineState.peakProfitPoints,
      exitMode: 'bar_close',
      barHighLtp: engineState.optionBarHighLtp,
      barLowLtp: engineState.optionBarLowLtp,
    };
    trade.openPositionMark = mark;
    trade.openPositionMarkAt = new Date();
    await trade.save();
    engineState.openPositionMark = mark;
  }

  engineState.closingTrade = true;
  try {
    if (isEod(clock.minutes)) {
      await finalizeTrade(trade, {
        exitPremium: (Number.isFinite(ltp) && ltp > 0 ? ltp : null) || trade.entryPremium,
        reason: 'DAY_CLOSE',
      });
      return;
    }
    await evaluateBarCloseExit(trade, clock);
  } finally {
    engineState.closingTrade = false;
  }
}

async function pollOnce() {
  if (!engineState.running) return;
  const clock = getIstClock(new Date());
  try {
    await ensureNseHolidaysLoaded();
    if (isWeekendDateKey(clock.dateKey) || !isNseCashTradingDay(clock.dateKey)) {
      engineState.lastError = getNseHolidayDescription(clock.dateKey) || 'Market closed';
      return;
    }
    resetSessionIfNewDay(clock);

    if (engineState.openTradeId) {
      await checkOpenTrade();
    } else if (!isEod(clock.minutes)) {
      await processNewSignalBars(clock);
    }

    if (isEod(clock.minutes)) {
      const open = await getOpenTrade();
      if (open) {
        await finalizeTrade(open, {
          exitPremium: (await getMarkPremium(open)) || open.entryPremium,
          reason: 'DAY_CLOSE',
        });
      }
    }
  } catch (err) {
    engineState.lastError = err.message;
  }
}

function startPositionPoll() {
  if (engineState.positionPollTimer) return;
  engineState.positionPollTimer = setInterval(() => {
    checkOpenTrade().catch(() => {});
  }, POSITION_POLL_MS);
}

function stopPositionPoll() {
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => pollOnce().catch((e) => { engineState.lastError = e.message; });
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function syncOpenStateFromDb() {
  const open = await getOpenTrade();
  if (!open) {
    engineState.openTradeId = null;
    clearSubs();
    stopPositionPoll();
    return;
  }
  engineState.openTradeId = open._id.toString();
  const m = String(open.notes || '').match(/signalBar=(\d+)/);
  if (m) {
    engineState.entryDecisionMinutes = Number(m[1]) + BAR_INTERVAL;
    engineState.lastProcessedSignalBarOpenMinutes = Number(m[1]);
  } else {
    engineState.entryDecisionMinutes = getIstClock(open.entryTime).minutes;
  }
  resetBarExitState();
  await subscribeOpenOption(open);
  startPositionPoll();
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings, symbol });
  engineState.symbol = engineState.settings.symbol;
  engineState.running = true;
  engineState.startedAt = new Date();
  engineState.lastError = null;
  const clock = getIstClock(new Date());
  resetSessionIfNewDay(clock);
  const forming = fiveMinBarOpenMinutes(clock.minutes);
  // Only act on signal bars that close AFTER start (new candles).
  engineState.earliestSignalBarOpenMinutes =
    clock.minutes < entryFromMin() ? entryFromMin() - BAR_INTERVAL : forming + BAR_INTERVAL;
  await persistSettingsToWallet();
  await syncOpenStateFromDb();
  startPoll();
  logLine('ENGINE_START', {
    ist: istLabel(clock),
    earliestSignalBarOpenMinutes: engineState.earliestSignalBarOpenMinutes,
    settings: engineState.settings,
  });
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  engineState.running = false;
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  engineState.pollTimer = null;
  stopPositionPoll();
  clearSubs();
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  engineState.settings = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.symbol = engineState.settings.symbol;
  await persistSettingsToWallet();
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  await loadSettingsFromWallet();
  return startEngine({ symbol: engineState.symbol || symbol, settings: engineState.settings });
}

async function resumeOpenPositionFromDb() {
  await loadSettingsFromWallet();
  if (!engineState.running) await startEngine({ symbol: engineState.symbol, settings: engineState.settings });
  else await syncOpenStateFromDb();
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    await bootEngineFromDb({ symbol: engineState.symbol || 'NIFTY' });
  }
  return { ok: true, state: getEngineSnapshot() };
}

function getEngineSnapshot() {
  const nextSignal =
    engineState.earliestSignalBarOpenMinutes == null
      ? null
      : engineState.earliestSignalBarOpenMinutes + BAR_INTERVAL;
  return {
    running: engineState.running,
    strategyKey: STRATEGY_KEY,
    symbol: engineState.symbol,
    startedAt: engineState.startedAt,
    settings: engineState.settings,
    lastError: engineState.lastError,
    lastSignalAt: engineState.lastSignalAt,
    dayTradeCount: engineState.dayTradeCount,
    openTradeId: engineState.openTradeId,
    earliestNextDecisionMinutes: nextSignal,
    earliestSignalBarOpenMinutes: engineState.earliestSignalBarOpenMinutes,
    lastProcessedSignalBarOpenMinutes: engineState.lastProcessedSignalBarOpenMinutes,
    peakProfitPoints: engineState.peakProfitPoints,
    trailStopPremium: engineState.trailStopPremium,
    openPositionMark: engineState.openPositionMark,
    lastOptionTick: engineState.lastOptionTick,
  };
}

async function refreshOpenPositionMarkForStatus() {
  const trade = await getOpenTrade();
  if (!trade) return null;
  const ltp = await getMarkPremium(trade);
  if (!Number.isFinite(ltp)) return trade.openPositionMark;
  const entry = Number(trade.entryPremium);
  const mark = {
    at: new Date().toISOString(),
    source: 'marketfeed',
    isLiveMark: true,
    optionType: trade.optionType,
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    unrealizedPnl: Number(((ltp - entry) * trade.qty - (trade.charges || 0)).toFixed(2)),
    stopLossPremium: trade.stopLossPremium,
    trailStopPremium: engineState.trailStopPremium,
    peakProfitPoints: engineState.peakProfitPoints,
    exitMode: 'bar_close',
  };
  trade.openPositionMark = mark;
  trade.openPositionMarkAt = new Date();
  await trade.save();
  engineState.openPositionMark = mark;
  return mark;
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).lean();
  let realized = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
    const p = Number(t.pnl) || 0;
    realized += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realized.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = closed.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return wallet;
}

async function closeOpenPosition({ reason = 'MANUAL_CLOSE' } = {}) {
  const trade = await getOpenTrade();
  if (!trade) return { ok: true };
  await finalizeTrade(trade, {
    exitPremium: (await getMarkPremium(trade)) || trade.entryPremium,
    reason,
  });
  return { ok: true };
}

async function reconcileOpenTrades() {
  await syncOpenStateFromDb();
  return { ok: true };
}

async function clearDailySkipState() {
  const clock = getIstClock(new Date());
  const forming = fiveMinBarOpenMinutes(clock.minutes);
  engineState.earliestSignalBarOpenMinutes =
    clock.minutes < entryFromMin() ? entryFromMin() - BAR_INTERVAL : forming + BAR_INTERVAL;
  engineState.lastProcessedSignalBarOpenMinutes = null;
  return { ok: true, state: getEngineSnapshot() };
}

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  bootEngineFromDb,
  ensureEngineRunning,
  getEngineSnapshot,
  refreshOpenPositionMark: refreshOpenPositionMarkForStatus,
  refreshOpenPositionMarkForStatus,
  ensureWallet,
  recalcWalletFromTrades,
  reconcileOpenTrades,
  resumeOpenPositionFromDb,
  closeOpenPosition,
  clearDailySkipState,
};

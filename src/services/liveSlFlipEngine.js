/**
 * Strategy 6 (UI) — SL Flip paper live.
 * Live id: strategy-8 / strategy11_sl_flip_live
 *
 * Day start: always long ATM CE in the entry window.
 * Exits on LIVE LTP (tick mode) after brief MIN_HOLD:
 *   STOP_LOSS / BREAKEVEN_STOP → flip opposite immediately
 *   TRAIL_STOP → same side after next 5m bar open
 *   DAY_CLOSE / MANUAL → no more entries until next day
 * No new entries at/after entryTo (15:15); EOD flatten at eodExitTime.
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
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');
const { STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY } = require('../strategies/keys');

const STRATEGY_KEY = STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY;
const OPTION_SUB_KEY = 'engine:strategy11:slflip:option';
const POLL_INTERVAL_MS = 5000;
const POSITION_POLL_MS = 3000;
const TICK_FRESH_MS = 45000;
const MIN_HOLD_MS = 8000;
const SESSION_START_MIN = 555;
const BAR_INTERVAL = 5;
const DEFAULT_ENTRY_FROM = 560; // 09:20
const DEFAULT_ENTRY_TO = 915; // 15:15
const EOD_EXIT = 920; // 15:20
const DEFAULT_SL = 8;
const DEFAULT_TRAIL_ACT = 4;
const DEFAULT_TRAIL_STEP = 2;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  settings: {},
  lotSize: 65,
  expiry: null,
  lastSpot: null,
  sessionDateKey: null,
  /** True once today's CE starter has been filled (or day already had trades). */
  dayStartedCE: false,
  /** After DAY_CLOSE / MANUAL — block entries until next session day. */
  entriesClosedForDay: false,
  /** Immediate opposite-side re-entry after SL (retry on later polls if place fails). */
  pendingFlipOpposite: false,
  pendingFlipOptionType: null,
  /** Same-side re-entry after TRAIL_STOP, gated by earliestEntryBarOpenMinutes. */
  pendingSameSideReentry: false,
  pendingSameSideOptionType: null,
  /** Next 5m bar open (IST minutes) allowed for trail same-side re-entry. */
  earliestEntryBarOpenMinutes: null,
  lastClosedOptionType: null,
  openTradeId: null,
  entryAtMs: null,
  peakProfitPoints: 0,
  trailStopPremium: null,
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
  console.log(`[SlFlipPaperLive] ${line}`, JSON.stringify({ at: new Date().toISOString(), line, ...payload }));
}

function normalizeSettings(settings = {}) {
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

function inEntryWindow(minutes) {
  return minutes >= entryFromMin() && minutes < entryToMin();
}

function canPlaceNewEntry(minutes) {
  if (engineState.entriesClosedForDay) return false;
  if (minutes >= entryToMin()) return false;
  if (isEod(minutes)) return false;
  return true;
}

function premiumFromChain(chain, optionType) {
  const t = String(optionType).toUpperCase();
  const v = t === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function oppositeOptionType(optionType) {
  return String(optionType).toUpperCase() === 'CE' ? 'PE' : 'CE';
}

function clearPendingEntryState() {
  engineState.pendingFlipOpposite = false;
  engineState.pendingFlipOptionType = null;
  engineState.pendingSameSideReentry = false;
  engineState.pendingSameSideOptionType = null;
  engineState.earliestEntryBarOpenMinutes = null;
}

function clearOpenRuntime() {
  engineState.openTradeId = null;
  engineState.entryAtMs = null;
  engineState.peakProfitPoints = 0;
  engineState.trailStopPremium = null;
  engineState.openPositionMark = null;
  engineState.lastOptionTick = null;
}

async function ensureWallet() {
  const walletKey = 'paper_live_strategy11';
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
  wallet.strategy11EngineSettings = { ...engineState.settings };
  await wallet.save();
}

async function loadSettingsFromWallet() {
  const wallet = await ensureWallet();
  const raw = wallet.strategy11EngineSettings
    ? wallet.strategy11EngineSettings.toObject?.() || wallet.strategy11EngineSettings
    : {};
  engineState.settings = normalizeSettings(raw);
  engineState.symbol = engineState.settings.symbol;
}

async function countTodayTrades(dateKey) {
  return LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
  });
}

async function resetSessionIfNewDay(clock) {
  if (engineState.sessionDateKey === clock.dateKey) return;
  engineState.sessionDateKey = clock.dateKey;
  engineState.dayTradeCount = await countTodayTrades(clock.dateKey);
  engineState.dayStartedCE = engineState.dayTradeCount > 0;
  engineState.entriesClosedForDay = false;
  clearPendingEntryState();
  engineState.lastClosedOptionType = null;
}

function updateTrailFromLtp(entryPremium, ltp) {
  const act = engineState.settings.trailingActivationPoints;
  const step = engineState.settings.trailingStepPoints;
  const profit = Number(ltp) - Number(entryPremium);
  if (profit > engineState.peakProfitPoints) engineState.peakProfitPoints = profit;
  if (engineState.peakProfitPoints >= act) {
    engineState.trailStopPremium = Number(entryPremium) + engineState.peakProfitPoints - step;
  }
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
      },
    });
  } catch (err) {
    engineState.lastError = `WS: ${err.message}`;
  }
}

/**
 * Close trade and set re-entry / day-stop state from reason.
 * @returns {Promise<string>} normalized exit reason
 */
async function finalizeTrade(trade, { exitPremium, reason }) {
  const safeExit = Math.max(0.05, Number(exitPremium) || Number(trade.entryPremium) || 0.05);
  const entry = Number(trade.entryPremium) || 0;
  const qty = Number(trade.qty) || 0;
  const charges = Math.max(0, Number(trade.charges) || 0);
  const pnl = (safeExit - entry) * qty - charges;
  const clock = getIstClock(new Date());
  const reasonUpper = String(reason || 'UNKNOWN').toUpperCase();
  const closedSide = String(trade.optionType || '').toUpperCase() === 'PE' ? 'PE' : 'CE';

  trade.status = 'CLOSED';
  trade.exitPremium = Number(safeExit.toFixed(2));
  trade.exitSpot = Number(trade.entrySpot || 0);
  trade.exitTime = new Date();
  trade.exitDateKey = clock.dateKey;
  trade.reason = reasonUpper;
  trade.finalValue = Number((safeExit * qty).toFixed(2));
  trade.pnl = Number(pnl.toFixed(2));
  trade.pnlPct = entry > 0 ? Number((((safeExit - entry) / entry) * 100).toFixed(2)) : 0;
  trade.openPositionMark = null;
  trade.openPositionMarkAt = null;
  await trade.save();

  engineState.lastClosedOptionType = closedSide;
  clearOpenRuntime();
  clearSubs();
  stopPositionPoll();

  if (reasonUpper === 'STOP_LOSS' || reasonUpper === 'BREAKEVEN_STOP') {
    engineState.pendingSameSideReentry = false;
    engineState.pendingSameSideOptionType = null;
    engineState.earliestEntryBarOpenMinutes = null;
    engineState.pendingFlipOpposite = true;
    engineState.pendingFlipOptionType = oppositeOptionType(closedSide);
  } else if (reasonUpper === 'TRAIL_STOP') {
    engineState.pendingFlipOpposite = false;
    engineState.pendingFlipOptionType = null;
    engineState.pendingSameSideReentry = true;
    engineState.pendingSameSideOptionType = closedSide;
    const forming = fiveMinBarOpenMinutes(clock.minutes);
    engineState.earliestEntryBarOpenMinutes = forming + BAR_INTERVAL;
  } else if (
    reasonUpper === 'DAY_CLOSE'
    || reasonUpper === 'MANUAL_CLOSE'
    || reasonUpper === 'MANUAL'
  ) {
    clearPendingEntryState();
    engineState.entriesClosedForDay = true;
  }

  await recalcWalletFromTrades();
  logLine('EXIT', {
    reason: reasonUpper,
    exitPremium: safeExit,
    pnl: trade.pnl,
    pendingFlipOpposite: engineState.pendingFlipOpposite,
    pendingSameSideReentry: engineState.pendingSameSideReentry,
    earliestEntryBarOpenMinutes: engineState.earliestEntryBarOpenMinutes,
    ist: istLabel(clock),
  });
  return reasonUpper;
}

async function placeLongOption(clock, { optionType, entryKind }) {
  if (engineState.enteringTrade || engineState.openTradeId) return { ok: false, reason: 'BUSY' };
  if (!canPlaceNewEntry(clock.minutes)) return { ok: false, reason: 'ENTRY_WINDOW_CLOSED' };
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
    const side = String(optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
    const strike = pickStrike({
      entrySpot: spot,
      strikeStep: getStrikeStep(symbol),
      optionType: side,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, side);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      logLine('ENTRY_FAIL', { reason: `NO_${side}`, strike });
      return { ok: false, reason: `NO_${side}` };
    }
    const stopLossPremium = Math.max(0.05, entryPremium - engineState.settings.stopLossPoints);
    const doc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType: side,
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(buildIstWallClockTimestamp(clock.dateKey, clock.minutes)),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(engineState.settings.perTradeCost.toFixed(2)),
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: null,
      legs: [{ optionType: side, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `slFlip; kind=${entryKind || 'entry'}; trail; tick`,
    });

    engineState.openTradeId = doc._id.toString();
    engineState.entryAtMs = Date.now();
    engineState.dayTradeCount += 1;
    engineState.lastSignalAt = new Date();
    engineState.peakProfitPoints = 0;
    engineState.trailStopPremium = null;
    engineState.lastOptionTick = { ltp: entryPremium, ts: Date.now() };

    if (side === 'CE') engineState.dayStartedCE = true;
    // Clear only the pending that this fill satisfies.
    if (engineState.pendingFlipOpposite && engineState.pendingFlipOptionType === side) {
      engineState.pendingFlipOpposite = false;
      engineState.pendingFlipOptionType = null;
    }
    if (engineState.pendingSameSideReentry && engineState.pendingSameSideOptionType === side) {
      engineState.pendingSameSideReentry = false;
      engineState.pendingSameSideOptionType = null;
      engineState.earliestEntryBarOpenMinutes = null;
    }

    await subscribeOpenOption(doc);
    startPositionPoll();
    logLine('ENTRY', {
      ist: istLabel(clock),
      optionType: side,
      entryKind,
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

/**
 * One-shot entry attempt (no recursive flip loops). Failures leave pending* for next poll.
 */
async function tryPendingOrStarterEntry(clock) {
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (!canPlaceNewEntry(clock.minutes)) return;

  if (engineState.pendingFlipOpposite && engineState.pendingFlipOptionType) {
    const placed = await placeLongOption(clock, {
      optionType: engineState.pendingFlipOptionType,
      entryKind: 'sl_flip',
    });
    if (!placed?.ok) {
      logLine('FLIP_PENDING', {
        optionType: engineState.pendingFlipOptionType,
        fail: placed?.reason,
        ist: istLabel(clock),
      });
    }
    return;
  }

  if (engineState.pendingSameSideReentry && engineState.pendingSameSideOptionType) {
    const readyAt = engineState.earliestEntryBarOpenMinutes;
    if (readyAt != null && clock.minutes < readyAt) return;
    const placed = await placeLongOption(clock, {
      optionType: engineState.pendingSameSideOptionType,
      entryKind: 'trail_reentry',
    });
    if (!placed?.ok) {
      logLine('TRAIL_REENTRY_PENDING', {
        optionType: engineState.pendingSameSideOptionType,
        fail: placed?.reason,
        ist: istLabel(clock),
      });
    }
    return;
  }

  // Day starter: first position is always CE (including mid-day boot with dayTradeCount==0).
  if (!engineState.dayStartedCE && engineState.dayTradeCount === 0 && inEntryWindow(clock.minutes)) {
    const placed = await placeLongOption(clock, {
      optionType: 'CE',
      entryKind: 'day_starter_ce',
    });
    if (!placed?.ok) {
      logLine('STARTER_CE_PENDING', { fail: placed?.reason, ist: istLabel(clock) });
    }
  }
}

async function evaluateTickExit(trade, clock, ltp) {
  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return null;

  const entryPremium = Number(trade.entryPremium);
  if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(entryPremium)) return null;

  updateTrailFromLtp(entryPremium, ltp);

  // Trail first (matches backtest order: trail before hard SL).
  if (engineState.trailStopPremium != null && ltp <= engineState.trailStopPremium) {
    return finalizeTrade(trade, {
      exitPremium: Number(engineState.trailStopPremium),
      reason: 'TRAIL_STOP',
    });
  }

  if (trade.stopLossPremium != null && ltp <= Number(trade.stopLossPremium)) {
    const slPx = Number(trade.stopLossPremium);
    const reason = slPx > entryPremium ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
    return finalizeTrade(trade, { exitPremium: slPx, reason });
  }

  return null;
}

async function checkOpenTrade() {
  if (engineState.closingTrade) return;
  const trade = await getOpenTrade();
  if (!trade || trade.exitTime) {
    engineState.openTradeId = null;
    return;
  }
  engineState.openTradeId = trade._id.toString();
  if (engineState.entryAtMs == null && trade.entryTime) {
    engineState.entryAtMs = new Date(trade.entryTime).getTime();
  }
  const clock = getIstClock(new Date());

  const ltp = await getMarkPremium(trade);
  if (Number.isFinite(ltp) && ltp > 0) {
    const entry = Number(trade.entryPremium);
    updateTrailFromLtp(entry, ltp);
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
      exitMode: 'tick',
      minHoldMs: MIN_HOLD_MS,
    };
    trade.openPositionMark = mark;
    trade.openPositionMarkAt = new Date();
    await trade.save();
    engineState.openPositionMark = mark;
  }

  engineState.closingTrade = true;
  let exitReason = null;
  try {
    if (isEod(clock.minutes)) {
      exitReason = await finalizeTrade(trade, {
        exitPremium: (Number.isFinite(ltp) && ltp > 0 ? ltp : null) || trade.entryPremium,
        reason: 'DAY_CLOSE',
      });
    } else {
      exitReason = await evaluateTickExit(trade, clock, ltp);
    }
  } finally {
    engineState.closingTrade = false;
  }

  // Immediate flip attempt after SL — single try; failures stay pending for next poll.
  if (exitReason === 'STOP_LOSS' || exitReason === 'BREAKEVEN_STOP') {
    await tryPendingOrStarterEntry(clock);
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
    await resetSessionIfNewDay(clock);

    if (engineState.openTradeId) {
      await checkOpenTrade();
    } else if (!isEod(clock.minutes)) {
      await tryPendingOrStarterEntry(clock);
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
  engineState.entryAtMs = open.entryTime ? new Date(open.entryTime).getTime() : Date.now();
  engineState.dayStartedCE = true;
  engineState.peakProfitPoints = 0;
  engineState.trailStopPremium = null;
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
  await resetSessionIfNewDay(clock);
  await persistSettingsToWallet();
  await syncOpenStateFromDb();

  // Mid-day boot: window open, flat, no trades yet → buy CE once (via first poll / tryPending).
  if (
    !engineState.openTradeId
    && engineState.dayTradeCount === 0
    && !engineState.dayStartedCE
    && inEntryWindow(clock.minutes)
  ) {
    logLine('MIDDAY_STARTER_ARMED', { ist: istLabel(clock) });
  }

  startPoll();
  logLine('ENGINE_START', {
    ist: istLabel(clock),
    dayTradeCount: engineState.dayTradeCount,
    dayStartedCE: engineState.dayStartedCE,
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
  return {
    running: engineState.running,
    strategyKey: STRATEGY_KEY,
    symbol: engineState.symbol,
    startedAt: engineState.startedAt,
    settings: engineState.settings,
    lastError: engineState.lastError,
    lastSignalAt: engineState.lastSignalAt,
    dayTradeCount: engineState.dayTradeCount,
    dayStartedCE: engineState.dayStartedCE,
    entriesClosedForDay: engineState.entriesClosedForDay,
    pendingFlipOpposite: engineState.pendingFlipOpposite,
    pendingFlipOptionType: engineState.pendingFlipOptionType,
    pendingSameSideReentry: engineState.pendingSameSideReentry,
    pendingSameSideOptionType: engineState.pendingSameSideOptionType,
    openTradeId: engineState.openTradeId,
    earliestEntryBarOpenMinutes: engineState.earliestEntryBarOpenMinutes,
    earliestNextDecisionMinutes: engineState.earliestEntryBarOpenMinutes,
    peakProfitPoints: engineState.peakProfitPoints,
    trailStopPremium: engineState.trailStopPremium,
    openPositionMark: engineState.openPositionMark,
    lastOptionTick: engineState.lastOptionTick,
    exitMode: 'tick',
  };
}

async function refreshOpenPositionMarkForStatus() {
  const trade = await getOpenTrade();
  if (!trade) return null;
  const ltp = await getMarkPremium(trade);
  if (!Number.isFinite(ltp)) return trade.openPositionMark;
  const entry = Number(trade.entryPremium);
  updateTrailFromLtp(entry, ltp);
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
    exitMode: 'tick',
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
  engineState.entriesClosedForDay = false;
  clearPendingEntryState();
  if (engineState.dayTradeCount === 0) engineState.dayStartedCE = false;
  logLine('CLEAR_DAILY_SKIP', { ist: istLabel(clock) });
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

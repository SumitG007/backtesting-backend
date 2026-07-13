/**
 * Strategy 5 (UI) — Trail Scalp Put/Call paper live.
 * Multi-entry intraday (unlimited trades), 5m bar-close signals 09:20–15:15,
 * real Dhan option LTP, SL + trailing profit + 15:20 square-off.
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
const { fetchTradingDayCandles } = require('./dhanDataService');
const {
  buildPutBuyFilterContext,
  evaluatePutBuyDirection,
  parseDirectionSettings,
  findLastCompletedBarIndex,
  DEFAULT_BAR_INTERVAL_MINUTES,
} = require('../strategies/strategy7/putBuyDayFilters');
const { STRATEGY_NINE_TRAIL_SCALP_LIVE_KEY } = require('../strategies/keys');
const {
  sideLockSkipReason,
  countStopLossesBySide,
  bothSidesLocked,
} = require('../strategies/strategy9/trailScalpSideLockout');

const STRATEGY_KEY = STRATEGY_NINE_TRAIL_SCALP_LIVE_KEY;
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy9:option';
const POLL_INTERVAL_MS = 6000;
const POSITION_POLL_MS = 4000;
const CANDLE_REFRESH_MIN_GAP_MS = 15000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 8000;
const TICK_FRESH_MAX_AGE_MS = 45000;
const MIN_HOLD_MS = 12000;
const DEFAULT_ENTRY_FROM = 560;
const DEFAULT_ENTRY_TO = 915;
const EOD_EXIT = 920;
const SESSION_START_MIN = 555; // 09:15 IST — 5m bar grid
const BAR_INTERVAL = DEFAULT_BAR_INTERVAL_MINUTES;
const DEFAULT_STOP_LOSS_POINTS = 8;
const DEFAULT_TRAIL_ACTIVATION = 4;
const DEFAULT_TRAIL_STEP = 2;
const DEFAULT_MAX_TRADES_CAP = null;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  lastStatusMarkRefreshAt: 0,
  settings: {},
  lotSize: 65,
  expiry: null,
  expiryDateKey: null,
  lastSpot: null,
  lastOptionTick: null,
  todayBars: [],
  prevDayBars: [],
  prevDayKey: null,
  lastCandleFetchAt: 0,
  lastDirectionEval: null,
  sessionDateKey: null,
  lastProcessedDecisionMinutes: null,
  /**
   * Backtest parity with scanFrom = exitIdx + 1:
   * next signal bar open (IST minutes) must be >= this value.
   * Null = no re-entry gate yet today.
   */
  minNextSignalBarOpenMinutes: null,
  dayTradeCount: 0,
  peSlCount: 0,
  ceSlCount: 0,
  openTradeId: null,
  closingTrade: false,
  enteringTrade: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
  peakProfitPoints: 0,
  trailStopPremium: null,
};

function istClockLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logEntry(line, payload = {}) {
  const entry = { at: new Date().toISOString(), line, ...payload };
  engineState.lastEntryDebug = entry;
  console.log(`[TrailScalpPaperLive] ${line}`, JSON.stringify(entry));
}

function getEngineSymbol() {
  return String(engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

function isTruthy(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeSettings(settings = {}) {
  const lotCount = Math.max(1, Number(settings.lotCount) || 5);
  const rawSl = Number(settings.stopLossPoints);
  const stopLossPoints =
    Number.isFinite(rawSl) && rawSl > 0
      ? Math.min(5000, Math.max(0.01, rawSl))
      : DEFAULT_STOP_LOSS_POINTS;
  const rawActivation = Number(settings.trailingActivationPoints ?? settings.targetProfitPoints);
  const trailingActivationPoints =
    Number.isFinite(rawActivation) && rawActivation > 0
      ? Math.min(5000, rawActivation)
      : DEFAULT_TRAIL_ACTIVATION;
  const rawTrailStep = Number(settings.trailingStepPoints);
  const trailingStepPoints =
    Number.isFinite(rawTrailStep) && rawTrailStep > 0
      ? Math.min(5000, rawTrailStep)
      : DEFAULT_TRAIL_STEP;
  const trailingTargetEnabled =
    settings.trailingTargetEnabled == null ? true : isTruthy(settings.trailingTargetEnabled);
  const maxTradesPerDay = DEFAULT_MAX_TRADES_CAP;
  const maxLossesPerSidePerDay = null; // side lockout disabled
  const rawCharges = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawCharges) && rawCharges >= 0 ? rawCharges : 100;
  const { minDirectionScore, enabledPeSignals, enabledCeSignals } = parseDirectionSettings(settings);

  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount,
    entryFromTime: String(settings.entryFromTime || '09:20').trim(),
    entryToTime: String(settings.entryToTime || '15:15').trim(),
    stopLossPoints,
    trailingActivationPoints,
    trailingStepPoints,
    trailingTargetEnabled,
    maxTradesPerDay,
    maxLossesPerSidePerDay,
    strikeMode: String(settings.strikeMode || 'ATM').toUpperCase(),
    perTradeCost,
    minDirectionScore,
    enabledPeSignals,
    enabledCeSignals,
  };
}

function tradeOptionType(trade) {
  return String(trade?.optionType || 'PE').toUpperCase() === 'CE' ? 'CE' : 'PE';
}

function premiumFromChain(chain, optionType) {
  const type = String(optionType || 'PE').toUpperCase();
  const ltp = type === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

function resetSessionIfNewDay(clock) {
  if (engineState.sessionDateKey !== clock.dateKey) {
    engineState.sessionDateKey = clock.dateKey;
    engineState.lastProcessedDecisionMinutes = null;
    engineState.minNextSignalBarOpenMinutes = null;
    engineState.dayTradeCount = 0;
    engineState.peSlCount = 0;
    engineState.ceSlCount = 0;
    engineState.todayBars = [];
    engineState.lastCandleFetchAt = 0;
  }
}

/** 5m bar open minute containing `minutes` (NSE cash session grid from 09:15). */
function fiveMinBarOpenMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return SESSION_START_MIN;
  if (m < SESSION_START_MIN) return SESSION_START_MIN;
  return SESSION_START_MIN + Math.floor((m - SESSION_START_MIN) / BAR_INTERVAL) * BAR_INTERVAL;
}

/**
 * Same re-entry rule as backtest `scanFrom = exitIdx + 1`:
 * after exiting on/in a 5m bar, the next entry may only use a later signal bar.
 */
function setReentryGateFromExitMinutes(exitMinutes) {
  const exitBarOpen = fiveMinBarOpenMinutes(exitMinutes);
  engineState.minNextSignalBarOpenMinutes = exitBarOpen + BAR_INTERVAL;
}

function signalBarOpenForDecision(decisionMinutes) {
  return Number(decisionMinutes) - BAR_INTERVAL;
}

function isReentryBlocked(decisionMinutes) {
  const minOpen = engineState.minNextSignalBarOpenMinutes;
  if (minOpen == null) return false;
  return signalBarOpenForDecision(decisionMinutes) < minOpen;
}

async function syncReentryGateFromDb(dateKey) {
  const lastClosed = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .lean();
  if (!lastClosed?.exitTime) {
    engineState.minNextSignalBarOpenMinutes = null;
    return;
  }
  const exitClock = getIstClock(new Date(lastClosed.exitTime));
  if (exitClock.dateKey !== dateKey) {
    engineState.minNextSignalBarOpenMinutes = null;
    return;
  }
  setReentryGateFromExitMinutes(exitClock.minutes);
}

function getSideLockState() {
  return {
    peSlCount: engineState.peSlCount,
    ceSlCount: engineState.ceSlCount,
    maxLossesPerSidePerDay: engineState.settings.maxLossesPerSidePerDay,
  };
}

async function syncSideSlCountsFromDb(dateKey) {
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
    exitTime: { $ne: null },
    reason: 'STOP_LOSS',
  }).lean();
  const counts = countStopLossesBySide(rows);
  engineState.peSlCount = counts.peSlCount;
  engineState.ceSlCount = counts.ceSlCount;
}

function isEodExitTime(minutes) {
  return minutes >= EOD_EXIT;
}

function optionTickIsFresh() {
  const tick = engineState.lastOptionTick;
  if (!Number.isFinite(tick?.ltp)) return false;
  return Date.now() - (tick.ts || 0) < TICK_FRESH_MAX_AGE_MS;
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

async function getDayTradeCount(dateKey) {
  return LivePaperTrade.countDocuments({ strategyKey: STRATEGY_KEY, entryDateKey: dateKey });
}

async function resolvePrevTradingDayKey(dateKey) {
  if (engineState.prevDayKey && engineState.prevDayKey < dateKey) {
    return engineState.prevDayKey;
  }
  await ensureNseHolidaysLoaded();
  let probe = new Date(`${dateKey}T12:00:00+05:30`);
  for (let i = 0; i < 12; i += 1) {
    probe.setDate(probe.getDate() - 1);
    const dk = getIstClock(probe).dateKey;
    if (isNseCashTradingDay(dk)) {
      engineState.prevDayKey = dk;
      return dk;
    }
  }
  return null;
}

async function refreshTodayCandles(clock, { force = false } = {}) {
  const now = Date.now();
  const inScan = clock.minutes >= parseClockMinutes(engineState.settings.entryFromTime, DEFAULT_ENTRY_FROM)
    && clock.minutes <= parseClockMinutes(engineState.settings.entryToTime, DEFAULT_ENTRY_TO) + BAR_INTERVAL;
  if (!force && !inScan && now - engineState.lastCandleFetchAt < CANDLE_REFRESH_MIN_GAP_MS && engineState.todayBars.length) {
    return engineState.todayBars;
  }
  try {
    const { rows } = await fetchTradingDayCandles({
      symbol: getEngineSymbol(),
      interval: '5',
      dateKey: clock.dateKey,
    });
    engineState.todayBars = rows || [];
    engineState.lastCandleFetchAt = now;
    return engineState.todayBars;
  } catch (err) {
    engineState.lastError = `Today candles: ${err.message}`;
    return engineState.todayBars;
  }
}

async function loadPrevDayCandles(prevKey) {
  if (engineState.prevDayKey === prevKey && engineState.prevDayBars.length > 0) {
    return engineState.prevDayBars;
  }
  try {
    const { rows } = await fetchTradingDayCandles({
      symbol: getEngineSymbol(),
      interval: '5',
      dateKey: prevKey,
    });
    engineState.prevDayKey = prevKey;
    engineState.prevDayBars = rows || [];
    return engineState.prevDayBars;
  } catch (err) {
    engineState.lastError = `Prev day candles: ${err.message}`;
    return [];
  }
}

function getLatestScannableDecisionMinutes(clock) {
  const entryFromMin = parseClockMinutes(engineState.settings.entryFromTime, DEFAULT_ENTRY_FROM);
  const entryToMin = parseClockMinutes(engineState.settings.entryToTime, DEFAULT_ENTRY_TO);
  const capped = Math.min(clock.minutes, entryToMin);
  if (capped < entryFromMin) return null;
  const todayBars = engineState.todayBars;
  if (!todayBars?.length) return null;
  const lastIdx = findLastCompletedBarIndex(todayBars, capped, BAR_INTERVAL);
  if (lastIdx == null || lastIdx >= todayBars.length - 1) return null;
  const barOpen = getIstClock(todayBars[lastIdx][0]).minutes;
  const decision = barOpen + BAR_INTERVAL;
  if (decision < entryFromMin || decision > entryToMin) return null;
  return decision;
}

async function evaluateDirectionAtDecision(clock, decisionMinutes) {
  const todayBars = engineState.todayBars;
  const prevKey = await resolvePrevTradingDayKey(clock.dateKey);
  if (!prevKey) return { skip: true, skipReason: 'no_prev_day', peScore: 0, ceScore: 0 };
  const prevBars = await loadPrevDayCandles(prevKey);
  if (!prevBars.length) return { skip: true, skipReason: 'no_prev_candles', peScore: 0, ceScore: 0 };
  const intraByDay = new Map([[prevKey, prevBars], [clock.dateKey, todayBars]]);
  const ctx = buildPutBuyFilterContext([prevKey, clock.dateKey], intraByDay);
  const { minDirectionScore, enabledPeSignals, enabledCeSignals } = engineState.settings;
  const resolution = evaluatePutBuyDirection({
    dayKey: clock.dateKey,
    dayBars: todayBars,
    filterCtx: ctx,
    entryDecisionMinutes: decisionMinutes,
    minDirectionScore,
    enabledPeSignals,
    enabledCeSignals,
    barIntervalMinutes: BAR_INTERVAL,
    requireFollowingBar: true,
  });
  engineState.lastDirectionEval = {
    at: new Date().toISOString(),
    dateKey: clock.dateKey,
    decisionMinutes,
    ...resolution,
    minDirectionScore,
  };
  return resolution;
}

async function getEntryExpiry(symbol, dateKey) {
  const cachedExpiry = String(engineState.expiry || '').slice(0, 10);
  const isStale = !cachedExpiry || cachedExpiry < dateKey || engineState.expiryDateKey !== dateKey;
  if (isStale) {
    engineState.expiry = await getNearestWeeklyExpiry(symbol);
    engineState.expiryDateKey = dateKey;
  }
  return engineState.expiry;
}

function getOptionMarkFromTrade(trade, chain = null) {
  const optionType = tradeOptionType(trade);
  const chainLtp = premiumFromChain(chain, optionType);
  if (Number.isFinite(chainLtp) && chainLtp > 0) {
    return { optionLtp: chainLtp, spot: Number(chain.chainSpot) || null, source: 'chain', optionType };
  }
  const tickLtp = Number(engineState.lastOptionTick?.ltp);
  if (Number.isFinite(tickLtp) && tickLtp > 0) {
    return { optionLtp: tickLtp, spot: engineState.lastSpot, source: 'websocket', optionType };
  }
  const entryPrem = Number(trade.entryPremium);
  return {
    optionLtp: Number.isFinite(entryPrem) ? entryPrem : 0.05,
    spot: engineState.lastSpot || trade.entrySpot,
    source: 'entry',
    optionType,
  };
}

async function resolveMarkForOpenTrade(trade, { preferTicks = false, forceChain = false } = {}) {
  if (preferTicks || optionTickIsFresh()) {
    const tickMark = getOptionMarkFromTrade(trade, null);
    if (tickMark.source === 'websocket') return tickMark;
  }
  const now = Date.now();
  if (!forceChain && now - engineState.lastChainFetchAt < OPEN_MARK_CHAIN_MIN_GAP_MS) {
    return getOptionMarkFromTrade(trade, null);
  }
  try {
    engineState.lastChainFetchAt = now;
    const chain = await getAtmPremiums({ symbol: trade.symbol, strike: trade.strike, expiry: trade.expiryDate });
    const mark = getOptionMarkFromTrade(trade, chain);
    if (Number.isFinite(mark.spot)) engineState.lastSpot = mark.spot;
    return mark;
  } catch (err) {
    engineState.lastError = `Trail mark: ${err.message}`;
    return getOptionMarkFromTrade(trade, null);
  }
}

function updateTrailingState(entryPremium, optionLtp) {
  if (!engineState.settings.trailingTargetEnabled) {
    engineState.peakProfitPoints = 0;
    engineState.trailStopPremium = null;
    return;
  }
  const profitPts = optionLtp - entryPremium;
  if (profitPts > engineState.peakProfitPoints) engineState.peakProfitPoints = profitPts;
  const activation = engineState.settings.trailingActivationPoints;
  const step = engineState.settings.trailingStepPoints;
  if (engineState.peakProfitPoints >= activation) {
    engineState.trailStopPremium = entryPremium + engineState.peakProfitPoints - step;
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryPremium = Number(trade.entryPremium) || 0;
  const optionLtp = Number(mark?.optionLtp) || 0;
  updateTrailingState(entryPremium, optionLtp);
  const qty = Number(trade.qty) || 0;
  const invested = entryPremium * qty;
  const finalValue = optionLtp * qty;
  const grossPnl = finalValue - invested;
  const isLiveMark = mark?.source === 'websocket' || mark?.source === 'chain';

  return {
    at: new Date().toISOString(),
    source: mark?.source || 'entry',
    isLiveMark,
    priceSourceLabel: isLiveMark ? 'LIVE' : 'STALE (entry)',
    optionType: tradeOptionType(trade),
    optionLtp: Number.isFinite(optionLtp) ? Number(optionLtp.toFixed(2)) : null,
    entryPremium: Number(entryPremium.toFixed(2)),
    investedAmount: Number(invested.toFixed(2)),
    currentValue: Number(finalValue.toFixed(2)),
    grossPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnlPct: invested > 0 ? Number(((grossPnl / invested) * 100).toFixed(2)) : 0,
    stopLossPremium: trade.stopLossPremium,
    trailStopPremium: engineState.trailStopPremium != null ? Number(engineState.trailStopPremium.toFixed(2)) : null,
    peakProfitPoints: Number(engineState.peakProfitPoints.toFixed(2)),
    trailingActivationPoints: engineState.settings.trailingActivationPoints,
    trailingStepPoints: engineState.settings.trailingStepPoints,
    spot: Number.isFinite(Number(mark?.spot)) ? Number(Number(mark.spot).toFixed(2)) : null,
    isProfitable: grossPnl > 0,
    phase: 'INTRADAY_SCALP',
  };
}

async function persistOpenMarkToDb(trade, positionMark) {
  if (!trade?._id || !positionMark) return;
  try {
    await LivePaperTrade.updateOne(
      { _id: trade._id, exitTime: null },
      { $set: { openPositionMark: positionMark, openPositionMarkAt: new Date(positionMark.at || Date.now()) } },
    );
  } catch (err) {
    engineState.lastError = `Trail MTM save: ${err.message}`;
  }
}

async function subscribeOpenOption(trade) {
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.lastOptionTick = null;
  const optionType = tradeOptionType(trade);
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType,
    });
    subscribeLiveInstrument({
      key: OPTION_SUBSCRIPTION_KEY,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: (tick) => onOptionTick(tick),
    });
  } catch (err) {
    engineState.lastError = `Trail ${optionType} WS subscribe failed: ${err.message}`;
  }
}

function clearOpenTrade() {
  stopPositionPoll();
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.lastOptionTick = null;
  engineState.openPositionMark = null;
  engineState.peakProfitPoints = 0;
  engineState.trailStopPremium = null;
}

function stopPositionPoll() {
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function startPositionPoll() {
  stopPositionPoll();
  if (!engineState.openTradeId) return;
  const tick = () => {
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Trail position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

async function syncEngineTradeStateFromDb(clock) {
  resetSessionIfNewDay(clock);
  engineState.dayTradeCount = await getDayTradeCount(clock.dateKey);
  await syncSideSlCountsFromDb(clock.dateKey);
  await syncReentryGateFromDb(clock.dateKey);
  const open = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({ entryTime: -1 });
  if (open) {
    engineState.openTradeId = open._id.toString();
    return;
  }
  if (engineState.openTradeId) clearOpenTrade();
}

async function getEntryGate(clock) {
  if (!engineState.running) return { ok: false, reason: 'ENGINE_OFFLINE' };
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    if (isWeekendDateKey(clock.dateKey)) return { ok: false, reason: 'MARKET_CLOSED_WEEKEND' };
    return { ok: false, reason: 'MARKET_CLOSED_HOLIDAY', holiday: getNseHolidayDescription(clock.dateKey) };
  }
  await syncEngineTradeStateFromDb(clock);
  if (engineState.openTradeId) return { ok: false, reason: 'OPEN_TRADE_EXISTS' };
  const entryToMin = parseClockMinutes(engineState.settings.entryToTime, DEFAULT_ENTRY_TO);
  if (clock.minutes > entryToMin + BAR_INTERVAL) return { ok: false, reason: 'AFTER_SCAN_WINDOW' };
  const maxTrades = engineState.settings.maxTradesPerDay;
  if (maxTrades != null && engineState.dayTradeCount >= maxTrades) {
    return { ok: false, reason: 'MAX_TRADES_REACHED', count: engineState.dayTradeCount };
  }
  if (bothSidesLocked(getSideLockState())) {
    return {
      ok: false,
      reason: 'BOTH_SIDES_LOCKED',
      peSlCount: engineState.peSlCount,
      ceSlCount: engineState.ceSlCount,
    };
  }
  try {
    const expiry = await getEntryExpiry(getEngineSymbol(), clock.dateKey);
    if (!expiry) return { ok: false, reason: 'NO_EXPIRY_FROM_DHAN' };
  } catch (err) {
    return { ok: false, reason: 'EXPIRY_FETCH_FAILED', error: err.message };
  }
  return { ok: true, reason: 'READY_TO_SCAN' };
}

async function evaluateEntry() {
  const clock = getIstClock(new Date());
  resetSessionIfNewDay(clock);
  const gate = await getEntryGate(clock);
  if (!gate.ok) return;

  await refreshTodayCandles(clock, { force: false });
  const decisionMinutes = getLatestScannableDecisionMinutes(clock);
  if (decisionMinutes == null) return;
  if (
    engineState.lastProcessedDecisionMinutes != null
    && decisionMinutes <= engineState.lastProcessedDecisionMinutes
  ) {
    return;
  }

  const resolution = await evaluateDirectionAtDecision(clock, decisionMinutes);
  engineState.lastProcessedDecisionMinutes = decisionMinutes;

  if (!resolution || resolution.skip) {
    logEntry('ENTRY_SKIP', {
      ist: istClockLabel(clock),
      decisionMinutes,
      reason: resolution?.skipReason || 'direction_skip',
      peScore: resolution?.peScore,
      ceScore: resolution?.ceScore,
    });
    return;
  }

  if (isReentryBlocked(decisionMinutes)) {
    logEntry('ENTRY_SKIP', {
      ist: istClockLabel(clock),
      decisionMinutes,
      reason: 'REENTRY_WAIT_NEXT_BAR',
      signalBarOpen: signalBarOpenForDecision(decisionMinutes),
      minNextSignalBarOpenMinutes: engineState.minNextSignalBarOpenMinutes,
      optionType: resolution.optionType,
      peScore: resolution.peScore,
      ceScore: resolution.ceScore,
    });
    return;
  }

  const lockReason = sideLockSkipReason(resolution.optionType, getSideLockState());
  if (lockReason) {
    logEntry('ENTRY_SKIP', {
      ist: istClockLabel(clock),
      decisionMinutes,
      reason: lockReason,
      optionType: resolution.optionType,
      peSlCount: engineState.peSlCount,
      ceSlCount: engineState.ceSlCount,
      maxLossesPerSidePerDay: engineState.settings.maxLossesPerSidePerDay,
    });
    return;
  }

  logEntry('ENTRY_TRIGGER', {
    ist: istClockLabel(clock),
    decisionMinutes,
    optionType: resolution.optionType,
    peScore: resolution.peScore,
    ceScore: resolution.ceScore,
    signals: resolution.signals,
    dayTradeNumber: engineState.dayTradeCount + 1,
  });
  await placeLongOption(clock, resolution, decisionMinutes);
}

async function placeLongOption(clock, resolution, decisionMinutes) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) return;
    const maxTrades = engineState.settings.maxTradesPerDay;
    if (maxTrades != null && engineState.dayTradeCount >= maxTrades) return;
    if (isReentryBlocked(decisionMinutes)) return;
    const lockReason = sideLockSkipReason(resolution?.optionType, getSideLockState());
    if (lockReason) return;

    const symbol = getEngineSymbol();
    const optionType = String(resolution?.optionType || 'PE').toUpperCase() === 'CE' ? 'CE' : 'PE';
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    const chainForSpot = await getAtmPremiums({ symbol, strike: 0, expiry });
    const spot = Number(chainForSpot.chainSpot || chainForSpot.spot);
    if (!Number.isFinite(spot) || spot <= 0) {
      logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), reason: 'NO_SPOT' });
      return;
    }
    const strike = pickStrike({
      entrySpot: spot,
      strikeStep: getStrikeStep(symbol),
      optionType,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), reason: `MISSING_${optionType}`, strike });
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 5);
    const qty = lotSize * lots;
    const stopLossPremium = Math.max(0.05, entryPremium - engineState.settings.stopLossPoints);
    const dayTradeNumber = engineState.dayTradeCount + 1;
    const signalNote = Array.isArray(resolution?.signals) ? resolution.signals.join(',') : '';

    const tradeDoc = await LivePaperTrade.create({
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
      entryTime: new Date(buildIstWallClockTimestamp(clock.dateKey, decisionMinutes)),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(engineState.settings.perTradeCost.toFixed(2)),
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: null,
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `trail#${dayTradeNumber}; ${optionType}; pe=${resolution?.peScore ?? 0}; ce=${resolution?.ceScore ?? 0}; signals=${signalNote}; sl=${stopLossPremium.toFixed(2)}; trail+${engineState.settings.trailingActivationPoints}/${engineState.settings.trailingStepPoints}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.dayTradeCount = dayTradeNumber;
    engineState.lastSpot = spot;
    engineState.lastSignalAt = new Date();
    engineState.peakProfitPoints = 0;
    engineState.trailStopPremium = null;

    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      dayTradeNumber,
      optionType,
      strike,
      entryPremium: Number(entryPremium.toFixed(2)),
    });

    await subscribeOpenOption(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), reason: 'EXCEPTION', error: err.message });
  } finally {
    engineState.enteringTrade = false;
  }
}

async function onOptionTick({ ltp }) {
  engineState.lastOptionTick = { ltp: Number(ltp), ts: Date.now() };
  await checkOpenTrade({ preferTicks: true });
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  if (!engineState.running || engineState.closingTrade) return;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return;

  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    return;
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    forceChain: !preferTicks && !optionTickIsFresh(),
  });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);

  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;
  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) return;

  const entryPremium = Number(trade.entryPremium);

  if (
    engineState.settings.trailingTargetEnabled
    && engineState.trailStopPremium != null
    && optionLtp <= engineState.trailStopPremium
  ) {
    await finalizeTrade(trade, {
      exitPremium: Number(engineState.trailStopPremium),
      mark,
      reason: 'TRAIL_STOP',
    });
    return;
  }

  if (trade.stopLossPremium != null && optionLtp <= Number(trade.stopLossPremium)) {
    await finalizeTrade(trade, { exitPremium: Number(trade.stopLossPremium), mark, reason: 'STOP_LOSS' });
    return;
  }

  if (isEodExitTime(clock.minutes)) {
    await finalizeTrade(trade, { exitPremium: optionLtp, mark, reason: 'DAY_CLOSE', forceChain: true });
  }
}

async function finalizeTrade(trade, { exitPremium, mark, reason, forceChain = false }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  try {
    let resolvedMark = mark;
    if (forceChain || !Number.isFinite(mark?.optionLtp) || mark?.source === 'entry') {
      resolvedMark = await resolveMarkForOpenTrade(trade, { forceChain: true });
    }
    const liveExitMark = resolvedMark?.source === 'websocket' || resolvedMark?.source === 'chain';
    if (!liveExitMark && !forceChain) {
      engineState.lastError = 'Exit blocked — no live Dhan LTP yet';
      return;
    }
    const safeExitPremium = Math.max(0.05, Number(exitPremium) || Number(resolvedMark?.optionLtp) || 0.05);
    const finalValue = safeExitPremium * trade.qty;
    const invested = (Number(trade.entryPremium) || 0) * trade.qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExitPremium.toFixed(2));
    trade.exitSpot = Number(Number(resolvedMark?.spot || engineState.lastSpot || trade.entrySpot).toFixed(2));
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    trade.pnlPct = invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    await trade.save();

    const wallet = await ensureWallet();
    wallet.balance += pnl;
    wallet.realizedPnl += pnl;
    wallet.totalTrades += 1;
    if (pnl > 0) wallet.wins += 1;
    else if (pnl < 0) wallet.losses += 1;
    await wallet.save();

    logEntry('EXIT_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: trade._id.toString(),
      reason,
      pnl,
      exitPremium: safeExitPremium,
    });
    setReentryGateFromExitMinutes(clock.minutes);
    clearOpenTrade();
    engineState.dayTradeCount = await getDayTradeCount(clock.dateKey);
    await syncSideSlCountsFromDb(clock.dateKey);
    logEntry('REENTRY_GATE', {
      ist: istClockLabel(clock),
      minNextSignalBarOpenMinutes: engineState.minNextSignalBarOpenMinutes,
      earliestDecisionMinutes:
        engineState.minNextSignalBarOpenMinutes != null
          ? engineState.minNextSignalBarOpenMinutes + BAR_INTERVAL
          : null,
    });
  } catch (err) {
    engineState.lastError = `Exit failed: ${err.message}`;
  } finally {
    engineState.closingTrade = false;
  }
}

async function refreshOpenPositionMarkForStatus() {
  const now = Date.now();
  if (now - engineState.lastStatusMarkRefreshAt < POSITION_POLL_MS) return engineState.openPositionMark;
  engineState.lastStatusMarkRefreshAt = now;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return null;
  const trade = await LivePaperTrade.findById(engineState.openTradeId).lean();
  if (!trade || trade.exitTime) return null;
  return refreshOpenPositionMark({ forceChain: true, tradeDoc: trade });
}

async function refreshOpenPositionMark({ preferTicks = false, tradeDoc = null, forceChain = false } = {}) {
  const trade = tradeDoc || (engineState.openTradeId ? await LivePaperTrade.findById(engineState.openTradeId).lean() : null);
  if (!trade || trade.exitTime) {
    engineState.openPositionMark = null;
    return null;
  }
  const clock = getIstClock(new Date());
  const mark = await resolveMarkForOpenTrade(trade, { preferTicks, forceChain });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);
  return positionMark;
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    evaluateEntry().catch((err) => { engineState.lastError = `Entry poll: ${err.message}`; });
    checkOpenTrade().catch((err) => { engineState.lastError = `Exit poll: ${err.message}`; });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  if (engineState.running) {
    if (settings && Object.keys(settings).length > 0) {
      engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
      syncEngineSymbolFromSettings();
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings, symbol: settings.symbol || symbol });
  syncEngineSymbolFromSettings();
  engineState.lastError = null;
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    resetSessionIfNewDay(clock);
    engineState.expiry = await getNearestWeeklyExpiry(getEngineSymbol());
    engineState.expiryDateKey = clock.dateKey;
    const orphan = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({ entryTime: -1 });
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      await subscribeOpenOption(orphan);
      startPositionPoll();
      await checkOpenTrade();
    }
  } catch (err) {
    engineState.lastError = `Trail setup: ${err.message}`;
  }
  engineState.running = true;
  engineState.startedAt = new Date();
  startPoll();
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  if (engineState.pollTimer) {
    clearInterval(engineState.pollTimer);
    engineState.pollTimer = null;
  }
  clearOpenTrade();
  engineState.running = false;
  engineState.startedAt = null;
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  const prevSymbol = getEngineSymbol();
  engineState.settings = normalizeSettings({ ...engineState.settings, ...partial });
  syncEngineSymbolFromSettings();
  if (getEngineSymbol() !== prevSymbol) {
    try {
      engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
      engineState.expiry = null;
      engineState.expiryDateKey = null;
    } catch (err) {
      engineState.lastError = `Symbol change: ${err.message}`;
    }
  }
  try {
    const wallet = await ensureWallet();
    wallet.strategy9EngineSettings = engineState.settings;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Settings persist failed: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy9EngineSettings?.toObject?.() || wallet.strategy9EngineSettings || {};
    const normalized = normalizeSettings({ ...persisted, symbol: persisted.symbol || symbol });
    return startEngine({ symbol: normalized.symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `Trail boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

async function resumeOpenPositionFromDb() {
  if (!engineState.running) return { ok: false, reason: 'ENGINE_OFFLINE' };
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return { ok: true, resumed: false, state: getEngineSnapshot() };
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    return { ok: true, resumed: false, state: getEngineSnapshot() };
  }
  await subscribeOpenOption(trade);
  if (!engineState.positionPollTimer) startPositionPoll();
  await checkOpenTrade();
  await refreshOpenPositionMark({ tradeDoc: trade });
  return { ok: true, resumed: true, state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (!engineState.running) return bootEngineFromDb();
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (engineState.openTradeId && !engineState.positionPollTimer) {
    const trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (trade && !trade.exitTime) {
      await subscribeOpenOption(trade);
      startPositionPoll();
    }
  }
  return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    symbol: getEngineSymbol(),
    startedAt: engineState.startedAt,
    lotSize: engineState.lotSize,
    expiry: engineState.expiry,
    settings: engineState.settings,
    lastSpot: engineState.lastSpot,
    lastOptionTick: engineState.lastOptionTick,
    lastDirectionEval: engineState.lastDirectionEval,
    dayTradeCount: engineState.dayTradeCount,
    maxTradesPerDay: engineState.settings.maxTradesPerDay,
    maxLossesPerSidePerDay: engineState.settings.maxLossesPerSidePerDay,
    peSlCount: engineState.peSlCount,
    ceSlCount: engineState.ceSlCount,
    peSideLocked:
      engineState.settings.maxLossesPerSidePerDay != null
      && engineState.peSlCount >= engineState.settings.maxLossesPerSidePerDay,
    ceSideLocked:
      engineState.settings.maxLossesPerSidePerDay != null
      && engineState.ceSlCount >= engineState.settings.maxLossesPerSidePerDay,
    lastProcessedDecisionMinutes: engineState.lastProcessedDecisionMinutes,
    minNextSignalBarOpenMinutes: engineState.minNextSignalBarOpenMinutes,
    earliestNextDecisionMinutes:
      engineState.minNextSignalBarOpenMinutes != null
        ? engineState.minNextSignalBarOpenMinutes + BAR_INTERVAL
        : null,
    openTradeId: engineState.openTradeId,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    openPositionMark: engineState.openPositionMark,
    peakProfitPoints: engineState.peakProfitPoints,
    trailStopPremium: engineState.trailStopPremium,
  };
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY, exitTime: { $ne: null } }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of rows) {
    const p = Number(t.pnl) || 0;
    realizedPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = rows.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return wallet;
}

async function closeOpenPosition({ reason = 'MANUAL_CLOSE' } = {}) {
  if (!engineState.running) throw new Error('Engine is not running');
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) throw new Error('No open position to close');
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    throw new Error('No open position to close');
  }
  const mark = await resolveMarkForOpenTrade(trade, { forceChain: true });
  await finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason, forceChain: true });
  return { ok: true, state: getEngineSnapshot() };
}

async function reconcileOpenTrades() {
  const clock = getIstClock(new Date());
  const openRows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({ entryTime: -1 });
  if (openRows.length <= 1) return openRows[0] || null;
  const [keep, ...duplicates] = openRows;
  for (const dup of duplicates) {
    dup.status = 'CLOSED';
    dup.exitTime = new Date();
    dup.exitDateKey = clock.dateKey;
    dup.reason = 'DUPLICATE_ENTRY';
    dup.pnl = 0;
    await dup.save();
  }
  if (duplicates.length) await recalcWalletFromTrades();
  return keep;
}

async function clearDailySkipState() {
  const clock = getIstClock(new Date());
  engineState.lastProcessedDecisionMinutes = null;
  engineState.dayTradeCount = await getDayTradeCount(clock.dateKey);
  await syncSideSlCountsFromDb(clock.dateKey);
  await syncReentryGateFromDb(clock.dateKey);
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
  refreshOpenPositionMark,
  refreshOpenPositionMarkForStatus,
  ensureWallet,
  recalcWalletFromTrades,
  reconcileOpenTrades,
  resumeOpenPositionFromDb,
  closeOpenPosition,
  clearDailySkipState,
};

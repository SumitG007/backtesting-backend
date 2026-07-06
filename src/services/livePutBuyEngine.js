/**
 * Strategy 3 (UI) — Put & Call buy paper live: scored PE vs CE at entry, same-day exit.
 * Optional premium SL / target; default exit 15:20 IST when target is blank.
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
} = require('../strategies/strategy7/putBuyDayFilters');
const { STRATEGY_SEVEN_PUT_BUY_LIVE_KEY } = require('../strategies/keys');

const STRATEGY_KEY = STRATEGY_SEVEN_PUT_BUY_LIVE_KEY;
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy7:option';
const POLL_INTERVAL_MS = 8000;
const CANDLE_REFRESH_MIN_GAP_MS = 20000;
const POSITION_POLL_MS = 6000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 10000;
const TICK_FRESH_MAX_AGE_MS = 45000;
const MIN_HOLD_MS = 30000;
const DEFAULT_ENTRY_MINUTES = 675; // 11:15 IST
const EOD_EXIT = 920;
const DEFAULT_STOP_LOSS_POINTS = 15;
const DEFAULT_TARGET_PROFIT_POINTS = 150;
const TERMINAL_SKIP_REASONS = new Set(['neutral_day', 'direction_tie', 'bad_combo']);

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  lastStatusMarkRefreshAt: 0,
  settings: {
    symbol: 'NIFTY',
    lotCount: 10,
    entryTime: '11:15',
    entryWindowMinutes: 0,
    stopLossPoints: DEFAULT_STOP_LOSS_POINTS,
    targetProfitPoints: DEFAULT_TARGET_PROFIT_POINTS,
    strikeMode: 'ATM',
    perTradeCost: 100,
    minDirectionScore: 2,
    skipBadCombos: true,
  },
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
  skippedDateKey: null,
  tradeDateKey: null,
  openTradeId: null,
  closingTrade: false,
  enteringTrade: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
};

function istClockLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logEntry(line, payload = {}) {
  const entry = { at: new Date().toISOString(), line, ...payload };
  engineState.lastEntryDebug = entry;
  console.log(`[Strategy3PutBuyPaperLive] ${line}`, JSON.stringify(entry));
}

function getEngineSymbol() {
  return String(engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

function normalizeSettings(settings = {}) {
  const lotCount = Math.max(1, Number(settings.lotCount) || 10);
  const entryWindowMinutes = 0; // 5m bars — decision at exact entryTime (e.g. 11:15), no extra window
  const slRaw = settings.stopLossPoints;
  let hasStopLoss = true;
  let stopLossPoints = DEFAULT_STOP_LOSS_POINTS;
  if (slRaw === '' || slRaw === null || slRaw === undefined) {
    hasStopLoss = true;
    stopLossPoints = DEFAULT_STOP_LOSS_POINTS;
  } else {
    const rawSl = Number(slRaw);
    if (!Number.isFinite(rawSl) || rawSl <= 0) {
      hasStopLoss = false;
      stopLossPoints = 0;
    } else {
      // Legacy paper-live default was 10 — align with backtest default 15.
      const normalizedSl = rawSl === 10 ? DEFAULT_STOP_LOSS_POINTS : rawSl;
      stopLossPoints = Math.min(5000, Math.max(0.01, normalizedSl));
      hasStopLoss = true;
    }
  }
  const tgRaw = settings.targetProfitPoints;
  let hasTarget = true;
  let targetProfitPoints = DEFAULT_TARGET_PROFIT_POINTS;
  if (tgRaw === '' || tgRaw === 0 || tgRaw === '0') {
    hasTarget = false;
    targetProfitPoints = 0;
  } else if (tgRaw === null || tgRaw === undefined) {
    hasTarget = true;
    targetProfitPoints = DEFAULT_TARGET_PROFIT_POINTS;
  } else {
    const rawTg = Number(tgRaw);
    if (!Number.isFinite(rawTg) || rawTg <= 0) {
      hasTarget = false;
      targetProfitPoints = 0;
    } else {
      targetProfitPoints = Math.min(5000, Math.max(0.01, rawTg));
      hasTarget = true;
    }
  }
  const rawCharges = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawCharges) && rawCharges >= 0 ? rawCharges : 100;
  const { minDirectionScore, enabledPeSignals, enabledCeSignals, skipBadCombos } = parseDirectionSettings(settings);

  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount,
    entryTime: String(settings.entryTime || '11:15').trim(),
    entryWindowMinutes,
    stopLossPoints,
    targetProfitPoints,
    hasStopLoss,
    hasTarget,
    strikeMode: String(settings.strikeMode || 'ATM').toUpperCase(),
    perTradeCost,
    minDirectionScore,
    enabledPeSignals,
    enabledCeSignals,
    skipBadCombos,
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

function liveEntryWindowMinutes() {
  return 0;
}

function isInsideEntryWindow(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, DEFAULT_ENTRY_MINUTES);
  return clock.minutes === entryMinutes;
}

async function refreshTodayCandles(clock, { force = false } = {}) {
  const now = Date.now();
  const inEntryWindow = isInsideEntryWindow(clock);
  if (
    !force
    && !inEntryWindow
    && now - engineState.lastCandleFetchAt < CANDLE_REFRESH_MIN_GAP_MS
    && engineState.todayBars.length > 0
  ) {
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

async function evaluateDirectionResolution(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, DEFAULT_ENTRY_MINUTES);
  const todayBars = await refreshTodayCandles(clock, { force: isInsideEntryWindow(clock) });
  if (!todayBars.length) {
    return { skip: true, skipReason: 'no_candles', peScore: 0, ceScore: 0 };
  }
  const prevKey = await resolvePrevTradingDayKey(clock.dateKey);
  if (!prevKey) {
    return { skip: true, skipReason: 'no_prev_day', peScore: 0, ceScore: 0 };
  }
  const prevBars = await loadPrevDayCandles(prevKey);
  if (!prevBars.length) {
    return { skip: true, skipReason: 'no_prev_candles', peScore: 0, ceScore: 0 };
  }
  const intraByDay = new Map([[prevKey, prevBars], [clock.dateKey, todayBars]]);
  const sortedKeys = [prevKey, clock.dateKey];
  const ctx = buildPutBuyFilterContext(sortedKeys, intraByDay);
  const { minDirectionScore, enabledPeSignals, enabledCeSignals, skipBadCombos } = parseDirectionSettings(engineState.settings);
  const decisionMinutes = entryMinutes;
  const resolution = evaluatePutBuyDirection({
    dayKey: clock.dateKey,
    dayBars: todayBars,
    filterCtx: ctx,
    entryDecisionMinutes: decisionMinutes,
    minDirectionScore,
    enabledPeSignals,
    enabledCeSignals,
    requireFollowingBar: false,
    skipBadCombos,
  });
  engineState.lastDirectionEval = {
    at: new Date().toISOString(),
    dateKey: clock.dateKey,
    ...resolution,
    minDirectionScore,
  };
  return resolution;
}

async function maybeMarkEntryWindowClosedWithoutTrade(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, DEFAULT_ENTRY_MINUTES);
  if (clock.minutes <= entryMinutes) return;
  if (engineState.tradeDateKey === clock.dateKey || engineState.skippedDateKey === clock.dateKey) return;
  if (engineState.openTradeId) return;
  const lastEval = engineState.lastDirectionEval;
  const skipReason =
    lastEval?.dateKey === clock.dateKey && lastEval?.skipReason ? lastEval.skipReason : 'no_entry_bar';
  await persistSkippedDay(clock, { skipReason });
}

async function persistSkippedDay(clock, resolution) {
  engineState.tradeDateKey = clock.dateKey;
  engineState.skippedDateKey = clock.dateKey;
  try {
    const wallet = await ensureWallet();
    wallet.strategy7SkippedDateKey = clock.dateKey;
    wallet.strategy7LastSkipReason = resolution?.skipReason || 'neutral_day';
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Strategy 3 skip persist: ${err.message}`;
  }
}

async function loadSkippedDayFromWallet(clock) {
  try {
    const wallet = await ensureWallet();
    if (wallet.strategy7SkippedDateKey === clock.dateKey) {
      engineState.tradeDateKey = clock.dateKey;
      engineState.skippedDateKey = clock.dateKey;
    } else if (engineState.skippedDateKey === clock.dateKey && wallet.strategy7SkippedDateKey !== clock.dateKey) {
      engineState.skippedDateKey = null;
    }
  } catch (err) {
    engineState.lastError = `Strategy 3 skip load: ${err.message}`;
  }
}

function isEodExitTime(minutes) {
  return minutes >= EOD_EXIT;
}

function isNearEntryWindow(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, DEFAULT_ENTRY_MINUTES);
  return clock.minutes >= entryMinutes - 25 && clock.minutes <= entryMinutes + 5;
}

function optionTickIsFresh() {
  const tick = engineState.lastOptionTick;
  if (!Number.isFinite(tick?.ltp)) return false;
  return Date.now() - (tick.ts || 0) < TICK_FRESH_MAX_AGE_MS;
}

function getOptionMarkFromTrade(trade, chain = null) {
  const optionType = tradeOptionType(trade);
  const chainLtp = premiumFromChain(chain, optionType);
  if (Number.isFinite(chainLtp) && chainLtp > 0) {
    return {
      optionLtp: chainLtp,
      spot: Number(chain.chainSpot) || null,
      source: 'chain',
      optionType,
    };
  }
  const tickLtp = Number(engineState.lastOptionTick?.ltp);
  if (Number.isFinite(tickLtp) && tickLtp > 0) {
    return {
      optionLtp: tickLtp,
      spot: engineState.lastSpot,
      source: 'websocket',
      optionType,
    };
  }
  const entryPrem = Number(trade.entryPremium);
  return {
    optionLtp: Number.isFinite(entryPrem) ? entryPrem : 0.05,
    spot: engineState.lastSpot || trade.entrySpot,
    source: 'entry',
    optionType,
  };
}

async function resolveMarkForOpenTrade(trade, { preferTicks = false, allowChain = true, forceChain = false } = {}) {
  if (preferTicks || optionTickIsFresh()) {
    const tickMark = getOptionMarkFromTrade(trade, null);
    if (tickMark.source === 'websocket') return tickMark;
  }
  const now = Date.now();
  const chainGapOk = forceChain || now - engineState.lastChainFetchAt >= OPEN_MARK_CHAIN_MIN_GAP_MS;
  if (!allowChain || !chainGapOk) {
    return getOptionMarkFromTrade(trade, null);
  }
  try {
    engineState.lastChainFetchAt = now;
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const mark = getOptionMarkFromTrade(trade, chain);
    if (Number.isFinite(mark.spot)) engineState.lastSpot = mark.spot;
    return mark;
  } catch (err) {
    engineState.lastError = `Strategy 3 mark: ${err.message}`;
    return getOptionMarkFromTrade(trade, null);
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryPremium = Number(trade.entryPremium) || 0;
  const optionLtp = Number(mark?.optionLtp) || 0;
  const qty = Number(trade.qty) || 0;
  const invested = entryPremium * qty;
  const finalValue = optionLtp * qty;
  const grossPnl = finalValue - invested;
  const entrySpot = Number(trade.entrySpot);
  const spot = Number(mark?.spot);
  const source = mark?.source || 'entry';
  const isLiveMark = source === 'websocket' || source === 'chain';
  const optionType = tradeOptionType(trade);

  return {
    at: new Date().toISOString(),
    source,
    isLiveMark,
    priceSourceLabel: isLiveMark ? 'LIVE' : 'STALE (entry)',
    optionType,
    optionLtp: Number.isFinite(optionLtp) ? Number(optionLtp.toFixed(2)) : null,
    peLtp: Number.isFinite(optionLtp) ? Number(optionLtp.toFixed(2)) : null,
    entryPremium: Number(entryPremium.toFixed(2)),
    investedAmount: Number(invested.toFixed(2)),
    currentValue: Number(finalValue.toFixed(2)),
    grossPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnlPct: invested > 0 ? Number(((grossPnl / invested) * 100).toFixed(2)) : 0,
    stopLossPremium: trade.stopLossPremium,
    targetPremium: trade.targetPremium,
    spot: Number.isFinite(spot) ? Number(spot.toFixed(2)) : null,
    spotChange: Number.isFinite(spot) && Number.isFinite(entrySpot)
      ? Number((spot - entrySpot).toFixed(2))
      : null,
    isProfitable: grossPnl > 0,
    phase: clock.dateKey === trade.entryDateKey ? 'INTRADAY_HOLD' : 'MISSED_EOD',
    pnlAudit: {
      investedAmount: Number(invested.toFixed(2)),
      currentValue: Number(finalValue.toFixed(2)),
      charges: Number(trade.charges) || 0,
      grossPnl: Number(grossPnl.toFixed(2)),
    },
  };
}

async function persistOpenMarkToDb(trade, positionMark) {
  const tradeId = trade?._id;
  if (!tradeId || !positionMark) return;
  try {
    await LivePaperTrade.updateOne(
      { _id: tradeId, exitTime: null },
      {
        $set: {
          openPositionMark: positionMark,
          openPositionMarkAt: new Date(positionMark.at || Date.now()),
        },
      },
    );
  } catch (err) {
    engineState.lastError = `Strategy 3 put buy MTM save: ${err.message}`;
  }
}

async function refreshOpenPositionMark({ preferTicks = false, tradeDoc = null, forceChain = false } = {}) {
  const trade = tradeDoc
    || (engineState.openTradeId
      ? await LivePaperTrade.findById(engineState.openTradeId).lean()
      : null);
  if (!trade || trade.exitTime) {
    engineState.openPositionMark = null;
    return null;
  }
  const clock = getIstClock(new Date());
  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: true,
    forceChain,
  });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);
  return engineState.openPositionMark;
}

async function refreshOpenPositionMarkForStatus() {
  const now = Date.now();
  if (now - engineState.lastStatusMarkRefreshAt < POSITION_POLL_MS) {
    return engineState.openPositionMark;
  }
  engineState.lastStatusMarkRefreshAt = now;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) {
    const openInDb = await LivePaperTrade.findOne({
      strategyKey: STRATEGY_KEY,
      exitTime: null,
    }).sort({ entryTime: -1 });
    if (openInDb) {
      engineState.openTradeId = openInDb._id.toString();
      if (!engineState.positionPollTimer) {
        await subscribeOpenOption(openInDb);
        startPositionPoll();
      }
    }
  }
  return refreshOpenPositionMark({ forceChain: true });
}

async function ensureWallet() {
  const walletKey = 'paper_live_strategy7';
  let wallet = await LiveWallet.findOne({ walletKey });
  if (!wallet) wallet = await LiveWallet.create({ walletKey });
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
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
    engineState.lastError = `Strategy 3 ${optionType} WS subscribe failed: ${err.message}`;
  }
}

async function dedupeOpenTradesInDb(clock) {
  const openRows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  }).sort({ entryTime: -1 });

  if (openRows.length <= 1) {
    return openRows[0] || null;
  }

  const [keep, ...duplicates] = openRows;
  for (const dup of duplicates) {
    dup.status = 'CLOSED';
    dup.exitTime = new Date();
    dup.exitDateKey = clock.dateKey;
    dup.reason = 'DUPLICATE_ENTRY';
    dup.notes = [dup.notes, `auto-closed duplicate at ${clock.dateKey}`].filter(Boolean).join('; ');
    dup.pnl = 0;
    dup.pnlPct = 0;
    await dup.save();
    logEntry('ENGINE_SYNC_CLOSED_DUPLICATE_OPEN_TRADE', {
      ist: istClockLabel(clock),
      tradeId: dup._id.toString(),
      keptTradeId: keep._id.toString(),
    });
  }
  if (duplicates.length > 0) {
    await recalcWalletFromTrades();
  }
  return keep;
}

async function syncEngineTradeStateFromDb(clock) {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  }).sort({ entryTime: -1 });

  if (open) {
    engineState.openTradeId = open._id.toString();
    engineState.tradeDateKey = open.entryDateKey;
    return;
  }

  if (engineState.openTradeId) {
    clearOpenTrade();
    logEntry('ENGINE_SYNC_CLEARED_STALE_OPEN_TRADE', { ist: istClockLabel(clock) });
  }

  await loadSkippedDayFromWallet(clock);

  const tradedToday = await LivePaperTrade.exists({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });

  if (tradedToday) {
    engineState.tradeDateKey = clock.dateKey;
  } else if (engineState.tradeDateKey === clock.dateKey && engineState.skippedDateKey !== clock.dateKey) {
    engineState.tradeDateKey = null;
  }
}

async function getEntryGate(clock) {
  if (!engineState.running) {
    return { ok: false, reason: 'ENGINE_OFFLINE' };
  }
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    if (isWeekendDateKey(clock.dateKey)) {
      return { ok: false, reason: 'MARKET_CLOSED_WEEKEND', dateKey: clock.dateKey };
    }
    return {
      ok: false,
      reason: 'MARKET_CLOSED_HOLIDAY',
      dateKey: clock.dateKey,
      holiday: getNseHolidayDescription(clock.dateKey),
    };
  }
  await syncEngineTradeStateFromDb(clock);
  await loadSkippedDayFromWallet(clock);
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, DEFAULT_ENTRY_MINUTES);
  if (clock.minutes < entryMinutes) {
    return {
      ok: false,
      reason: 'BEFORE_ENTRY_WINDOW',
      entryTime: engineState.settings.entryTime,
      entryMinutes,
      nowMinutes: clock.minutes,
    };
  }
  if (clock.minutes > entryMinutes) {
    return {
      ok: false,
      reason: 'AFTER_ENTRY_WINDOW',
      entryTime: engineState.settings.entryTime,
      entryMinutes,
      nowMinutes: clock.minutes,
    };
  }
  if (engineState.tradeDateKey === clock.dateKey || engineState.skippedDateKey === clock.dateKey) {
    return {
      ok: false,
      reason: engineState.skippedDateKey === clock.dateKey ? 'SKIPPED_TODAY' : 'ALREADY_TRADED_TODAY',
      tradeDateKey: engineState.tradeDateKey,
      skipReason: engineState.lastDirectionEval?.skipReason || null,
    };
  }
  if (engineState.openTradeId) {
    return { ok: false, reason: 'OPEN_TRADE_EXISTS', openTradeId: engineState.openTradeId };
  }
  try {
    const expiry = await getEntryExpiry(getEngineSymbol(), clock.dateKey);
    if (!expiry) {
      return { ok: false, reason: 'NO_EXPIRY_FROM_DHAN' };
    }
  } catch (err) {
    return { ok: false, reason: 'EXPIRY_FETCH_FAILED', error: err.message };
  }
  return {
    ok: true,
    reason: 'READY_TO_ENTER',
    entryTime: engineState.settings.entryTime,
    entryWindowMinutes: 0,
  };
}

async function evaluateEntry() {
  const clock = getIstClock(new Date());
  await maybeMarkEntryWindowClosedWithoutTrade(clock);
  const gate = await getEntryGate(clock);
  if (!gate.ok) {
    if (isNearEntryWindow(clock)) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), ...gate });
    }
    return;
  }

  const resolution = await evaluateDirectionResolution(clock);
  if (!resolution || resolution.skip) {
    if (resolution?.skip && TERMINAL_SKIP_REASONS.has(resolution.skipReason)) {
      await persistSkippedDay(clock, resolution);
    }
    logEntry('ENTRY_SKIP', {
      ist: istClockLabel(clock),
      reason: resolution?.skipReason || 'direction_skip',
      peScore: resolution?.peScore,
      ceScore: resolution?.ceScore,
      minDirectionScore: engineState.settings.minDirectionScore,
    });
    return;
  }

  logEntry('ENTRY_TRIGGER', {
    ist: istClockLabel(clock),
    optionType: resolution.optionType,
    peScore: resolution.peScore,
    ceScore: resolution.ceScore,
    signals: resolution.signals,
    ...gate,
  });
  await placeLongOption(clock, resolution);
}

async function placeLongOption(clock, resolution) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    const existingOpen = await LivePaperTrade.findOne({
      strategyKey: STRATEGY_KEY,
      exitTime: null,
    }).sort({ entryTime: -1 });
    if (existingOpen) {
      engineState.openTradeId = existingOpen._id.toString();
      engineState.tradeDateKey = existingOpen.entryDateKey;
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'OPEN_TRADE_EXISTS_IN_DB',
        tradeId: existingOpen._id.toString(),
      });
      return;
    }
    const tradedToday = await LivePaperTrade.exists({
      strategyKey: STRATEGY_KEY,
      entryDateKey: clock.dateKey,
    });
    if (tradedToday) {
      engineState.tradeDateKey = clock.dateKey;
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'ALREADY_TRADED_TODAY_IN_DB',
        entryDateKey: clock.dateKey,
      });
      return;
    }

    const symbol = getEngineSymbol();
    const optionType = String(resolution?.optionType || 'PE').toUpperCase() === 'CE' ? 'CE' : 'PE';
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    engineState.expiry = expiry;
    logEntry('ENTRY_FETCH_CHAIN', { ist: istClockLabel(clock), expiry, optionType });
    const chainForSpot = await getAtmPremiums({ symbol, strike: 0, expiry });
    const spot = Number(chainForSpot.chainSpot || chainForSpot.spot);
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'Strategy 3 entry skipped: live spot unavailable';
      logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), reason: 'NO_SPOT' });
      return;
    }
    const strikeStep = getStrikeStep(symbol);
    const strike = pickStrike({
      entrySpot: spot,
      strikeStep,
      optionType,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `Strategy 3 entry skipped: missing ${optionType} premium for ${strike}`;
      logEntry('ENTRY_FAILED', {
        ist: istClockLabel(clock),
        reason: `MISSING_${optionType}`,
        strike,
        entryPremium,
      });
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 10);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;
    const charges = engineState.settings.perTradeCost;
    const stopLossPremium = engineState.settings.hasStopLoss
      ? Math.max(0.05, entryPremium - engineState.settings.stopLossPoints)
      : null;
    const targetPremium = engineState.settings.hasTarget
      ? entryPremium + engineState.settings.targetProfitPoints
      : null;
    const signalNote = Array.isArray(resolution?.signals) ? resolution.signals.join(',') : '';
    const entryMinutes = parseClockMinutes(engineState.settings.entryTime, DEFAULT_ENTRY_MINUTES);

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
      entryTime: new Date(buildIstWallClockTimestamp(clock.dateKey, entryMinutes)),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number(invested.toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `entry=${clock.dateKey}; ${optionType}; pe=${resolution?.peScore ?? 0}; ce=${resolution?.ceScore ?? 0}; signals=${signalNote}; sl=${stopLossPremium ?? 'off'}; tg=${targetPremium ?? 'eod'}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradeDateKey = clock.dateKey;
    engineState.skippedDateKey = null;
    engineState.lastSpot = spot;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      expiry,
      entryPremium: Number(entryPremium.toFixed(2)),
      spot: Number(spot.toFixed(2)),
      peScore: resolution?.peScore,
      ceScore: resolution?.ceScore,
    });
    try {
      const wallet = await ensureWallet();
      if (wallet.strategy7SkippedDateKey === clock.dateKey) {
        wallet.strategy7SkippedDateKey = null;
        wallet.strategy7LastSkipReason = null;
        await wallet.save();
      }
    } catch (err) {
      engineState.lastError = `Strategy 3 skip clear: ${err.message}`;
    }
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

  if (clock.dateKey !== trade.entryDateKey) {
    const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    await finalizeTrade(trade, {
      exitPremium: mark.optionLtp,
      mark,
      reason: 'DAY_CLOSE',
      forceChain: true,
    });
    return;
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: true,
    forceChain: !preferTicks && !optionTickIsFresh(),
  });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);

  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;

  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) {
    const leg = tradeOptionType(trade);
    engineState.lastError = `Strategy 3 mark: waiting for live ${leg} LTP from Dhan`;
    return;
  }

  if (trade.stopLossPremium != null && optionLtp <= Number(trade.stopLossPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.stopLossPremium),
      mark,
      reason: 'STOP_LOSS',
    });
    return;
  }

  if (trade.targetPremium != null && optionLtp >= Number(trade.targetPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.targetPremium),
      mark,
      reason: 'TARGET',
    });
    return;
  }

  if (isEodExitTime(clock.minutes)) {
    await finalizeTrade(trade, {
      exitPremium: optionLtp,
      mark,
      reason: 'DAY_CLOSE',
      forceChain: true,
    });
  }
}

async function finalizeTrade(trade, { exitPremium, mark, reason, forceChain = false }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  try {
    let resolvedMark = mark;
    if (forceChain || !Number.isFinite(mark?.optionLtp) || mark?.source === 'entry') {
      resolvedMark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    }
    const markSource = resolvedMark?.source || 'unknown';
    const liveExitMark = markSource === 'websocket' || markSource === 'chain';
    if (!liveExitMark && !forceChain) {
      const leg = tradeOptionType(trade);
      engineState.lastError = `Exit blocked — no live Dhan ${leg} LTP yet`;
      return;
    }
    const safeExitPremium = Math.max(
      0.05,
      Number(exitPremium) || Number(resolvedMark?.optionLtp) || 0.05,
    );
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
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct = investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.notes = [trade.notes, `exitMark=${markSource}; pnl=${Number(pnl.toFixed(2))}`].filter(Boolean).join(' | ').slice(0, 500);
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
      markSource,
    });
    clearOpenTrade();
  } catch (err) {
    engineState.lastError = `Exit failed (will retry): ${err.message}`;
    logEntry('EXIT_FAILED', { tradeId: trade._id?.toString(), error: err.message });
  } finally {
    engineState.closingTrade = false;
  }
}

function clearOpenTrade() {
  stopPositionPoll();
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.lastOptionTick = null;
  engineState.openPositionMark = null;
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
      engineState.lastError = `Strategy 3 put buy position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    evaluateEntry().catch((err) => {
      engineState.lastError = `Strategy 3 put buy entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Strategy 3 put buy exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  if (engineState.running) {
    if (settings && Object.keys(settings).length > 0) {
      engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
      syncEngineSymbolFromSettings();
      logEntry('ENGINE_ALREADY_RUNNING_SETTINGS_MERGED', { settings: engineState.settings });
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings, symbol: settings.symbol || symbol });
  syncEngineSymbolFromSettings();
  engineState.lastError = null;
  logEntry('ENGINE_START', { symbol: getEngineSymbol(), settings: engineState.settings });
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    await loadSkippedDayFromWallet(clock);
    await dedupeOpenTradesInDb(clock);
    engineState.expiry = await getNearestWeeklyExpiry(getEngineSymbol());
    engineState.expiryDateKey = clock.dateKey;
    const orphan = await dedupeOpenTradesInDb(clock);
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.tradeDateKey = orphan.entryDateKey;
      logEntry('ENGINE_ADOPTED_OPEN_TRADE', {
        tradeId: orphan._id.toString(),
        entryDateKey: orphan.entryDateKey,
      });
      await subscribeOpenOption(orphan);
      startPositionPoll();
      await checkOpenTrade();
      await refreshOpenPositionMark({ tradeDoc: orphan });
    }
  } catch (err) {
    engineState.lastError = `Strategy 3 put buy setup: ${err.message}`;
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
  const next = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.settings = next;
  syncEngineSymbolFromSettings();
  if (getEngineSymbol() !== prevSymbol) {
    try {
      engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
      engineState.expiry = null;
      engineState.expiryDateKey = null;
    } catch (err) {
      engineState.lastError = `Strategy 3 symbol change: ${err.message}`;
    }
  }
  try {
    const wallet = await ensureWallet();
    wallet.strategy7EngineSettings = next;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Strategy 3 settings persist failed: ${err.message}`;
  }
  logEntry('SETTINGS_UPDATED', { settings: next, running: engineState.running });
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy7EngineSettings
      ? wallet.strategy7EngineSettings.toObject?.() || wallet.strategy7EngineSettings
      : {};
    const normalized = normalizeSettings({ ...persisted, symbol: persisted.symbol || symbol });
    const prevSl = Number(persisted.stopLossPoints);
    // Persist normalized defaults when SL legacy (10) or target never set.
    if (!persisted.stopLossPoints || prevSl === 10 || persisted.targetProfitPoints == null) {
      wallet.strategy7EngineSettings = normalized;
      await wallet.save();
    }
    return startEngine({ symbol: normalized.symbol || symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `Strategy 3 put buy boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

async function resumeOpenPositionFromDb() {
  if (!engineState.running) {
    return { ok: false, reason: 'ENGINE_OFFLINE' };
  }
  const clock = getIstClock(new Date());
  try {
    await syncEngineTradeStateFromDb(clock);
    if (!engineState.openTradeId) {
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    const trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (!trade || trade.exitTime) {
      clearOpenTrade();
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    await subscribeOpenOption(trade);
    if (!engineState.positionPollTimer) startPositionPoll();
    await checkOpenTrade();
    await refreshOpenPositionMark({ tradeDoc: trade });
    logEntry('ENGINE_RESUMED_OPEN_TRADE', {
      ist: istClockLabel(clock),
      tradeId: trade._id.toString(),
      entryDateKey: trade.entryDateKey,
    });
  } catch (err) {
    engineState.lastError = `Strategy 3 resume open position: ${err.message}`;
  }
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    return bootEngineFromDb();
  }
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
    skippedDateKey: engineState.skippedDateKey,
    tradeDateKey: engineState.tradeDateKey,
    openTradeId: engineState.openTradeId,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    openPositionMark: engineState.openPositionMark,
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
  if (!engineState.running) {
    throw new Error('Engine is not running');
  }
  await ensureNseHolidaysLoaded();
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) {
    throw new Error('No open position to close');
  }
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    throw new Error('No open position to close');
  }
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
  await finalizeTrade(trade, {
    exitPremium: mark.optionLtp,
    mark,
    reason,
    forceChain: true,
  });
  logEntry('MANUAL_CLOSE', { ist: istClockLabel(clock), tradeId: trade._id.toString(), reason });
  return { ok: true, state: getEngineSnapshot() };
}

async function reconcileOpenTrades() {
  const clock = getIstClock(new Date());
  return dedupeOpenTradesInDb(clock);
}

async function clearDailySkipState() {
  engineState.skippedDateKey = null;
  engineState.lastDirectionEval = null;
  if (!engineState.openTradeId) {
    engineState.tradeDateKey = null;
  }
  try {
    const wallet = await ensureWallet();
    wallet.strategy7SkippedDateKey = null;
    wallet.strategy7LastSkipReason = null;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Strategy 3 skip clear: ${err.message}`;
  }
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

/**
 * OI Scalp paper-live (strategy-10 / strategy13).
 * Bias from live OI + ΔOI + walls; trigger on closed 1m candle;
 * multiple trades/day with fixed premium target/SL points.
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const { getStrikeStep } = require('../utils/market');
const { pickStrike } = require('../strategies/shared/intradayOptions');
const {
  getAtmPremiums,
  getOptionChainOiSnapshot,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');
const { fetchTradingDayCandles } = require('./dhanDataService');
const { STRATEGY_THIRTEEN_OI_SCALP_LIVE_KEY } = require('../strategies/keys');
const { pushNotification } = require('./notificationHub');

const STRATEGY_KEY = STRATEGY_THIRTEEN_OI_SCALP_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy13';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy13:option';

const POLL_INTERVAL_MS = 2000;
const POSITION_POLL_MS = 1000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 4000;
const TICK_FRESH_MAX_AGE_MS = 20000;
const MIN_HOLD_MS = 2000;
const OI_BOARD_REFRESH_MIN_GAP_MS = 4000;
const CANDLE_REFRESH_MIN_GAP_MS = 8000;
const OI_BOARD_LOOKAROUND = 12;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  settings: {
    symbol: 'NIFTY',
    lotCount: 5,
    tradeFromTime: '09:20',
    tradeToTime: '15:10',
    eodExitTime: '15:15',
    targetPoints: 5,
    stopLossPoints: 5,
    proximityPoints: 30,
    strikeLookaround: 10,
    strikeMode: 'ATM',
    maxTradesPerDay: 8,
    cooldownMinutes: 2,
    candleInterval: '1',
    perTradeCost: 100,
  },
  lotSize: 65,
  expiry: null,
  expiryDateKey: null,
  lastSpot: null,
  lastOptionTick: null,
  liveOiBoard: null,
  lastOiBoardFetchAt: 0,
  lastOiError: null,
  scalpSignal: null,
  todayBars1m: [],
  lastCandleFetchAt: 0,
  lastCandleError: null,
  tradesTodayCount: 0,
  tradesTodayDateKey: null,
  lastExitAtMs: 0,
  openTradeId: null,
  closingTrade: false,
  enteringTrade: false,
  evaluatingEntry: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
};

function getEngineSymbol() {
  return String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = getEngineSymbol();
}

function tradeFromMin() {
  return parseClockMinutes(engineState.settings.tradeFromTime) ?? 560;
}
function tradeToMin() {
  return parseClockMinutes(engineState.settings.tradeToTime) ?? 910;
}
function eodExitMin() {
  return parseClockMinutes(engineState.settings.eodExitTime) ?? 915;
}
function isEodExitTime(minutes) {
  return minutes >= eodExitMin();
}

function istClockLabel(clock) {
  return `${clock.dateKey} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')} IST`;
}

function logEntry(tag, payload = {}) {
  console.log(`[OI-SCALP] ${tag}`, payload);
}

function normalizeSettings(settings = {}) {
  const targetPoints = Math.max(1, Number(settings.targetPoints) || 5);
  const stopLossPoints = Math.max(1, Number(settings.stopLossPoints) || 5);
  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount: Math.max(1, Math.floor(Number(settings.lotCount) || 5)),
    tradeFromTime: settings.tradeFromTime || '09:20',
    tradeToTime: settings.tradeToTime || '15:10',
    eodExitTime: settings.eodExitTime || '15:15',
    targetPoints,
    stopLossPoints,
    proximityPoints: Math.max(10, Math.floor(Number(settings.proximityPoints) || 30)),
    strikeLookaround: Math.max(3, Math.floor(Number(settings.strikeLookaround) || 10)),
    strikeMode: settings.strikeMode === 'ITM' ? 'ITM' : 'ATM',
    maxTradesPerDay: Math.max(1, Math.min(20, Math.floor(Number(settings.maxTradesPerDay) || 8))),
    cooldownMinutes: Math.max(0, Math.min(30, Number(settings.cooldownMinutes) || 2)),
    candleInterval: '1',
    perTradeCost: Math.max(0, Number(settings.perTradeCost) || 100),
  };
}

function premiumFromChain(chain, optionType) {
  if (!chain) return null;
  const v = optionType === 'PE' ? Number(chain.peLtp) : Number(chain.ceLtp);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function tradeOptionType(trade) {
  return String(trade.optionType || '').toUpperCase() === 'PE' ? 'PE' : 'CE';
}

function clearOpenTrade() {
  engineState.openTradeId = null;
  engineState.openPositionMark = null;
  engineState.lastOptionTick = null;
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) wallet = await LiveWallet.create({ walletKey: WALLET_KEY });
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

async function syncTradesToday(clock) {
  if (engineState.tradesTodayDateKey === clock.dateKey) return;
  const count = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });
  engineState.tradesTodayCount = count;
  engineState.tradesTodayDateKey = clock.dateKey;
  const last = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .select({ exitTime: 1 })
    .lean();
  engineState.lastExitAtMs = last?.exitTime ? new Date(last.exitTime).getTime() : 0;
}

async function syncEngineTradeStateFromDb(clock) {
  await syncTradesToday(clock);
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  })
    .sort({ entryTime: -1 })
    .lean();
  if (open) {
    engineState.openTradeId = open._id.toString();
  } else if (engineState.openTradeId) {
    clearOpenTrade();
  }
}

async function refreshLiveOiBoard(clock, { force = false } = {}) {
  const now = Date.now();
  if (
    !force
    && engineState.liveOiBoard
    && now - engineState.lastOiBoardFetchAt < OI_BOARD_REFRESH_MIN_GAP_MS
  ) {
    return engineState.liveOiBoard;
  }
  try {
    const symbol = getEngineSymbol();
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    if (!expiry) {
      engineState.lastOiError = 'No weekly expiry from Dhan';
      return engineState.liveOiBoard;
    }
    const lookaround = Math.max(
      OI_BOARD_LOOKAROUND,
      Number(engineState.settings.strikeLookaround) || 10,
    );
    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      lookaroundStrikes: lookaround,
    });
    engineState.lastOiBoardFetchAt = now;
    if (Number.isFinite(snapshot.spot)) engineState.lastSpot = snapshot.spot;

    const strikes = (snapshot.strikes || []).map((r) => ({
      strike: r.strike,
      putOi: r.putOi,
      callOi: r.callOi,
      putChgOi: r.putChgOi,
      callChgOi: r.callChgOi,
      totalOi: (Number(r.putOi) || 0) + (Number(r.callOi) || 0),
      ceLtp: r.ceLtp,
      peLtp: r.peLtp,
      distanceFromAtm: r.distanceFromAtm,
    }));

    let maxPut = null;
    let maxCall = null;
    let maxTotal = null;
    for (const row of strikes) {
      if (Number.isFinite(row.putOi) && (!maxPut || row.putOi > maxPut.putOi)) maxPut = row;
      if (Number.isFinite(row.callOi) && (!maxCall || row.callOi > maxCall.callOi)) maxCall = row;
      if (!maxTotal || row.totalOi > maxTotal.totalOi) maxTotal = row;
    }

    const totals = snapshot.totals || {};
    const pcr = Number(totals.pcr);
    const nearPcr = Number(totals.nearPcr);
    let pcrBias = 'NEUTRAL';
    const biasPcr = Number.isFinite(nearPcr) ? nearPcr : pcr;
    if (Number.isFinite(biasPcr)) {
      if (biasPcr >= 1.1) pcrBias = 'PUT_HEAVY';
      else if (biasPcr <= 0.9) pcrBias = 'CALL_HEAVY';
    }

    engineState.liveOiBoard = {
      at: new Date().toISOString(),
      dateKey: clock.dateKey,
      spot: snapshot.spot,
      atm: snapshot.atm,
      expiry,
      strikeStep: snapshot.strikeStep,
      strikes,
      totals: {
        callOi: totals.callOi ?? null,
        putOi: totals.putOi ?? null,
        pcr: Number.isFinite(pcr) ? pcr : null,
        nearPcr: Number.isFinite(nearPcr) ? nearPcr : null,
        pcrBias,
      },
      highlight: {
        maxPutStrike: maxPut?.strike ?? null,
        maxCallStrike: maxCall?.strike ?? null,
        maxTotalStrike: maxTotal?.strike ?? null,
      },
    };
    engineState.lastOiError = null;
    if (String(engineState.lastError || '').startsWith('OI board:')) engineState.lastError = null;
    return engineState.liveOiBoard;
  } catch (err) {
    const msg = err.message || 'OI board fetch failed';
    engineState.lastOiError = msg;
    if (!engineState.liveOiBoard) engineState.lastError = `OI board: ${msg}`;
    return engineState.liveOiBoard;
  }
}

async function refreshOneMinuteCandles(clock, { force = false } = {}) {
  const now = Date.now();
  if (
    !force
    && engineState.todayBars1m.length > 0
    && now - engineState.lastCandleFetchAt < CANDLE_REFRESH_MIN_GAP_MS
  ) {
    return engineState.todayBars1m;
  }
  try {
    const { rows } = await fetchTradingDayCandles({
      symbol: getEngineSymbol(),
      interval: '1',
      dateKey: clock.dateKey,
    });
    engineState.todayBars1m = Array.isArray(rows) ? rows : [];
    engineState.lastCandleFetchAt = now;
    engineState.lastCandleError = null;
    return engineState.todayBars1m;
  } catch (err) {
    engineState.lastCandleError = err.message || 'Candle fetch failed';
    logEntry('CANDLE_FETCH_ERROR', { error: engineState.lastCandleError });
    return engineState.todayBars1m;
  }
}

function readClosedCandle(rows) {
  if (!Array.isArray(rows) || rows.length < 1) return null;
  // Prefer previous bar as closed; last may still be forming.
  const barIdx = rows.length >= 2 ? rows.length - 2 : rows.length - 1;
  const bar = rows[barIdx];
  const prev = barIdx > 0 ? rows[barIdx - 1] : null;
  const open = Number(bar[1]);
  const high = Number(bar[2]);
  const low = Number(bar[3]);
  const close = Number(bar[4]);
  const prevClose = prev != null ? Number(prev[4]) : null;
  if (![open, high, low, close].every(Number.isFinite)) return null;
  return {
    open,
    high,
    low,
    close,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    green: close > open,
    red: close < open,
  };
}

/**
 * Strong scalp setup from OI board + closed 1m candle.
 */
function buildScalpSetup(board, candle, oiError = null) {
  if (!board || !Array.isArray(board.strikes) || board.strikes.length === 0) {
    const cooling = /cooling down/i.test(String(oiError || ''));
    return {
      action: 'WAIT',
      reason: cooling ? 'OI_COOLDOWN' : 'NO_OI_BOARD',
      detail: oiError || 'Waiting for live OI chain…',
    };
  }
  if (!candle) {
    return { action: 'WAIT', reason: 'NO_1M_CANDLE', detail: 'Waiting for 1m candles…' };
  }

  const spot = Number(board.spot);
  const atm = Number(board.atm);
  const step = Number(board.strikeStep) || getStrikeStep(getEngineSymbol());
  const hi = board.highlight || {};
  const totals = board.totals || {};
  const pcr = Number(totals.nearPcr ?? totals.pcr);
  const pcrBias = String(totals.pcrBias || '');
  const maxCall = Number(hi.maxCallStrike);
  const maxPut = Number(hi.maxPutStrike);
  const wall = Number(hi.maxTotalStrike);
  const prox = engineState.settings.proximityPoints;

  let nearCallChg = 0;
  let nearPutChg = 0;
  for (const r of board.strikes) {
    if (!Number.isFinite(atm) || Math.abs(Number(r.strike) - atm) > step * 3) continue;
    const cc = Number(r.callChgOi);
    const pc = Number(r.putChgOi);
    if (Number.isFinite(cc)) nearCallChg += cc;
    if (Number.isFinite(pc)) nearPutChg += pc;
  }

  let bull = 0;
  let bear = 0;
  const why = [];

  if (pcrBias === 'PUT_HEAVY' || (Number.isFinite(pcr) && pcr >= 1.1)) {
    bull += 2;
    why.push(`PCR put-heavy ${Number.isFinite(pcr) ? pcr.toFixed(2) : ''}`);
  } else if (pcrBias === 'CALL_HEAVY' || (Number.isFinite(pcr) && pcr <= 0.9)) {
    bear += 2;
    why.push(`PCR call-heavy ${Number.isFinite(pcr) ? pcr.toFixed(2) : ''}`);
  }

  if (nearPutChg > nearCallChg && Math.abs(nearPutChg - nearCallChg) > 0) {
    bull += 2;
    why.push('Put ΔOI rising faster near ATM');
  } else if (nearCallChg > nearPutChg) {
    bear += 2;
    why.push('Call ΔOI rising faster near ATM');
  }

  const support = Number.isFinite(maxPut) ? maxPut : Number.isFinite(wall) && wall <= spot ? wall : null;
  const resist = Number.isFinite(maxCall) ? maxCall : Number.isFinite(wall) && wall >= spot ? wall : null;

  if (!Number.isFinite(spot)) return { action: 'WAIT', reason: 'NO_SPOT', why };

  // CE: bounce near support / reclaim with green candle
  if (bull - bear >= 2 && candle.green) {
    const level = Number.isFinite(support) ? support : atm;
    const nearLevel = Math.abs(spot - level) <= prox || candle.low <= level + prox;
    const bounce = Number.isFinite(candle.prevClose) ? candle.close >= candle.prevClose : true;
    if (nearLevel && bounce) {
      return {
        action: 'BUY_CE',
        optionType: 'CE',
        levelStrike: level,
        entryReason: `Buy CE · bounce near ${level} · ${why.slice(0, 2).join(' · ')} · 1m green`,
        why,
        spot,
        support,
        resist,
      };
    }
  }

  // PE: rejection near resistance with red candle
  if (bear - bull >= 2 && candle.red) {
    const level = Number.isFinite(resist) ? resist : atm;
    const nearLevel = Math.abs(spot - level) <= prox || candle.high >= level - prox;
    const reject = Number.isFinite(candle.prevClose) ? candle.close <= candle.prevClose : true;
    if (nearLevel && reject) {
      return {
        action: 'BUY_PE',
        optionType: 'PE',
        levelStrike: level,
        entryReason: `Buy PE · reject near ${level} · ${why.slice(0, 2).join(' · ')} · 1m red`,
        why,
        spot,
        support,
        resist,
      };
    }
  }

  return {
    action: 'WAIT',
    reason: bull === bear ? 'MIXED_OI' : bull > bear ? 'WAIT_CE_CANDLE_OR_LEVEL' : 'WAIT_PE_CANDLE_OR_LEVEL',
    why,
    spot,
    support,
    resist,
    bull,
    bear,
  };
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

async function resolveMarkForOpenTrade(trade, { preferTicks = false, allowChain = true, forceChain = false } = {}) {
  if (preferTicks || optionTickIsFresh()) {
    const tickMark = getOptionMarkFromTrade(trade, null);
    if (tickMark.source === 'websocket') return tickMark;
  }
  const now = Date.now();
  const chainGapOk = forceChain || now - engineState.lastChainFetchAt >= OPEN_MARK_CHAIN_MIN_GAP_MS;
  if (!allowChain || !chainGapOk) return getOptionMarkFromTrade(trade, null);
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
    engineState.lastError = `Mark fetch: ${err.message}`;
    return getOptionMarkFromTrade(trade, null);
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entry = Number(trade.entryPremium) || 0;
  const ltp = Number(mark.optionLtp) || 0;
  const qty = Number(trade.qty) || 0;
  const unrealized = (ltp - entry) * qty - (Number(trade.charges) || 0);
  return {
    optionType: tradeOptionType(trade),
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    spot: mark.spot,
    source: mark.source,
    isLiveMark: mark.source === 'websocket' || mark.source === 'chain',
    unrealizedPnl: Number(unrealized.toFixed(2)),
    at: new Date().toISOString(),
    ist: istClockLabel(clock),
  };
}

async function persistOpenMarkToDb(trade, positionMark) {
  trade.openPositionMark = positionMark;
  trade.openPositionMarkAt = new Date();
  await trade.save();
}

async function subscribeOpenOption(trade) {
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.lastOptionTick = null;
  const optionType = tradeOptionType(trade);
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      optionType,
      expiry: trade.expiryDate,
    });
    if (!instrument?.securityId) return;
    subscribeLiveInstrument({
      key: OPTION_SUBSCRIPTION_KEY,
      exchangeSegment: instrument.exchangeSegment,
      securityId: instrument.securityId,
      onTick: (tick) => onOptionTick(tick),
    });
  } catch (err) {
    engineState.lastError = `Option subscribe: ${err.message}`;
  }
}

function startPositionPoll() {
  if (engineState.positionPollTimer) clearInterval(engineState.positionPollTimer);
  const tick = () => {
    checkOpenTrade().catch((err) => {
      engineState.lastError = `OI Scalp position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

async function onOptionTick({ ltp }) {
  engineState.lastOptionTick = { ltp: Number(ltp), ts: Date.now() };
  await checkOpenTrade({ preferTicks: true });
}

async function evaluateEntry() {
  if (engineState.evaluatingEntry) return;
  engineState.evaluatingEntry = true;
  try {
    const clock = getIstClock(new Date());
    await ensureNseHolidaysLoaded();
    if (!isNseCashTradingDay(clock.dateKey)) {
      engineState.lastEntryDebug = {
        reason: isWeekendDateKey(clock.dateKey) ? 'WEEKEND' : 'HOLIDAY',
        holiday: getNseHolidayDescription(clock.dateKey),
      };
      return;
    }
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) {
      engineState.lastEntryDebug = { reason: 'POSITION_OPEN' };
      return;
    }

    if (clock.minutes < tradeFromMin() || clock.minutes > tradeToMin()) {
      engineState.lastEntryDebug = { reason: 'OUTSIDE_TRADE_WINDOW' };
      engineState.scalpSignal = { action: 'WAIT', reason: 'OUTSIDE_TRADE_WINDOW', at: new Date().toISOString() };
      return;
    }

    await syncTradesToday(clock);
    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
      engineState.lastEntryDebug = { reason: 'MAX_TRADES', count: engineState.tradesTodayCount };
      engineState.scalpSignal = { action: 'WAIT', reason: 'MAX_TRADES', at: new Date().toISOString() };
      return;
    }

    const cooldownMs = (Number(engineState.settings.cooldownMinutes) || 0) * 60 * 1000;
    if (cooldownMs > 0 && engineState.lastExitAtMs && Date.now() - engineState.lastExitAtMs < cooldownMs) {
      engineState.lastEntryDebug = { reason: 'COOLDOWN' };
      engineState.scalpSignal = { action: 'WAIT', reason: 'COOLDOWN', at: new Date().toISOString() };
      return;
    }

    const board = await refreshLiveOiBoard(clock);
    const bars = await refreshOneMinuteCandles(clock);
    const candle = readClosedCandle(bars);
    const setup = buildScalpSetup(board, candle, engineState.lastOiError);
    engineState.scalpSignal = {
      ...setup,
      at: new Date().toISOString(),
      bars: Array.isArray(bars) ? bars.length : 0,
      candleError: engineState.lastCandleError,
      oiError: engineState.lastOiError,
      candle: candle
        ? { open: candle.open, high: candle.high, low: candle.low, close: candle.close, green: candle.green, red: candle.red }
        : null,
    };
    engineState.lastEntryDebug = { reason: setup.reason || setup.action, setup: setup.action };

    if (setup.action !== 'BUY_CE' && setup.action !== 'BUY_PE') return;

    await placeLongOption(clock, setup);
  } catch (err) {
    engineState.lastError = `Entry loop: ${err.message}`;
    logEntry('ENTRY_LOOP_ERROR', { error: err.message });
  } finally {
    engineState.evaluatingEntry = false;
  }
}

async function placeLongOption(clock, setup) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) return;

    const symbol = getEngineSymbol();
    const optionType = setup.optionType === 'PE' ? 'PE' : 'CE';
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    const strikeStep = getStrikeStep(symbol);
    const spot = Number(setup.spot) || Number(engineState.lastSpot);
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'OI Scalp: spot missing';
      return;
    }

    const strike = pickStrike({
      entrySpot: spot,
      strikeStep,
      optionType,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `OI Scalp: missing ${optionType} premium for ${strike}`;
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 5);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;
    const charges = engineState.settings.perTradeCost;
    const tgPts = engineState.settings.targetPoints;
    const slPts = engineState.settings.stopLossPoints;
    const targetPremium = entryPremium + tgPts;
    const stopLossPremium = Math.max(0.05, entryPremium - slPts);
    const entryReason = String(setup.entryReason || `${optionType} scalp @ ${strike}`).slice(0, 240);

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
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number(invested.toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason,
      notes: `oi_scalp; level=${setup.levelStrike}; tg=+${tgPts}; sl=-${slPts}; ${entryReason}`.slice(0, 500),
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradesTodayCount += 1;
    engineState.tradesTodayDateKey = clock.dateKey;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      entryPremium,
      entryReason,
    });
    pushNotification({
      type: 'ENTRY',
      strategy: 'OI Scalp',
      title: `Scalp ${optionType} ${strike}`,
      body: `${entryReason} · tgt +${tgPts} · SL -${slPts}`,
      meta: { tradeId: tradeDoc._id.toString(), optionType, strike },
      dedupeKey: `oi-scalp-entry:${tradeDoc._id.toString()}`,
    });
    await subscribeOpenOption(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { error: err.message });
  } finally {
    engineState.enteringTrade = false;
  }
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
    await finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason: 'DAY_CLOSE', forceChain: true });
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
  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) return;

  if (trade.stopLossPremium != null && optionLtp <= Number(trade.stopLossPremium)) {
    await finalizeTrade(trade, { exitPremium: Number(trade.stopLossPremium), mark, reason: 'STOP_LOSS' });
    return;
  }
  if (trade.targetPremium != null && optionLtp >= Number(trade.targetPremium)) {
    await finalizeTrade(trade, { exitPremium: Number(trade.targetPremium), mark, reason: 'TARGET' });
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
      resolvedMark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    }
    const markSource = resolvedMark?.source || 'unknown';
    const liveExitMark = markSource === 'websocket' || markSource === 'chain';
    if (!liveExitMark && !forceChain) {
      engineState.lastError = 'Exit blocked — waiting for live Dhan LTP';
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
    trade.notes = [trade.notes, `exit=${reason}; mark=${markSource}; pnl=${Number(pnl.toFixed(2))}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    await trade.save();

    const wallet = await ensureWallet();
    wallet.balance += pnl;
    wallet.realizedPnl += pnl;
    wallet.totalTrades += 1;
    if (pnl > 0) wallet.wins += 1;
    else if (pnl < 0) wallet.losses += 1;
    await wallet.save();

    engineState.lastExitAtMs = Date.now();
    logEntry('EXIT_SUCCESS', { tradeId: trade._id.toString(), reason, pnl });
    pushNotification({
      type: 'EXIT',
      strategy: 'OI Scalp',
      title: `Closed ${trade.optionType} ${trade.strike}`,
      body: `${reason} · P/L ₹${Number(pnl.toFixed(2))}`,
      meta: { tradeId: trade._id.toString(), reason, pnl },
      dedupeKey: `oi-scalp-exit:${trade._id.toString()}`,
    });
    clearOpenTrade();
  } catch (err) {
    engineState.lastError = `Exit failed: ${err.message}`;
  } finally {
    engineState.closingTrade = false;
  }
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  // Stagger first OI pull slightly so we share Dhan cache with OI Wall instead of double-hitting.
  const bootDelayMs = 2500;
  const startedAt = Date.now();
  const tick = () => {
    const clock = getIstClock(new Date());
    const allowOi = Date.now() - startedAt >= bootDelayMs;
    if (allowOi) {
      refreshLiveOiBoard(clock).catch((err) => {
        engineState.lastOiError = err.message || 'OI board failed';
      });
    }
    evaluateEntry().catch((err) => {
      engineState.lastError = `OI Scalp entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `OI Scalp exit poll: ${err.message}`;
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
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({
    ...engineState.settings,
    ...settings,
    symbol: settings.symbol || symbol,
  });
  syncEngineSymbolFromSettings();
  engineState.lastError = null;
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    engineState.expiry = await getNearestWeeklyExpiry(getEngineSymbol());
    engineState.expiryDateKey = clock.dateKey;
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) {
      const trade = await LivePaperTrade.findById(engineState.openTradeId);
      if (trade && !trade.exitTime) {
        await subscribeOpenOption(trade);
        startPositionPoll();
      }
    }
  } catch (err) {
    engineState.lastError = `OI Scalp setup: ${err.message}`;
  }
  engineState.running = true;
  engineState.startedAt = new Date();
  startPoll();
  return { ok: true, state: getEngineSnapshot() };
}

async function stopEngine() {
  // Always-on paper engine — ignore hard stop; keep polling.
  return { ok: true, ignored: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(settings = {}) {
  try {
    const next = normalizeSettings({ ...engineState.settings, ...settings });
    engineState.settings = next;
    syncEngineSymbolFromSettings();
    const wallet = await ensureWallet();
    wallet.strategy13EngineSettings = next;
    await wallet.save();
    return { ok: true, settings: next };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function bootEngineFromDb() {
  const wallet = await ensureWallet();
  const persisted = wallet.strategy13EngineSettings
    ? wallet.strategy13EngineSettings.toObject?.() || wallet.strategy13EngineSettings
    : null;
  const settings = normalizeSettings(persisted || engineState.settings);
  if (persisted) {
    wallet.strategy13EngineSettings = settings;
    await wallet.save();
  }
  return startEngine({ symbol: settings.symbol, settings });
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
    scalpSignal: engineState.scalpSignal,
    liveOiBoard: engineState.liveOiBoard,
    lastOiError: engineState.lastOiError,
    lastCandleError: engineState.lastCandleError,
    candleInterval: '1',
    oneMinuteBars: engineState.todayBars1m.length,
    tradesTodayCount: engineState.tradesTodayCount,
    openTradeId: engineState.openTradeId,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    openPositionMark: engineState.openPositionMark,
    scenarioLabel: 'OI Scalp',
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

async function reconcileOpenTrades() {
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (engineState.openTradeId && engineState.running && !engineState.positionPollTimer) {
    const openInDb = await LivePaperTrade.findById(engineState.openTradeId);
    if (openInDb && !openInDb.exitTime) {
      await subscribeOpenOption(openInDb);
      startPositionPoll();
    }
  }
  return { ok: true };
}

async function resumeOpenPositionFromDb() {
  if (!engineState.running) return { ok: false, reason: 'ENGINE_OFFLINE' };
  const clock = getIstClock(new Date());
  try {
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
  } catch (err) {
    engineState.lastError = `Resume: ${err.message}`;
  }
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function closeOpenPosition() {
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return { ok: false, error: 'No open trade' };
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return { ok: false, error: 'No open trade' };
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
  await finalizeTrade(trade, {
    exitPremium: mark.optionLtp,
    mark,
    reason: 'MANUAL_CLOSE',
    forceChain: true,
  });
  return { ok: true, state: getEngineSnapshot() };
}

async function refreshOpenPositionMarkForStatus() {
  if (!engineState.openTradeId) return null;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return null;
  const clock = getIstClock(new Date());
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: false });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);
  return positionMark;
}

function clearDailySkipState() {
  return { ok: true };
}

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  ensureEngineRunning,
  getEngineSnapshot,
  ensureWallet,
  recalcWalletFromTrades,
  reconcileOpenTrades,
  resumeOpenPositionFromDb,
  closeOpenPosition,
  refreshOpenPositionMarkForStatus,
  clearDailySkipState,
};

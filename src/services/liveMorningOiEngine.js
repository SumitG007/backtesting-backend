/**
 * Strategy 7 (UI) — NIFTY Morning Option Chain OI paper live.
 * 09:15–09:20: fetch live OI (memory only, never Mongo). Dominant Put → CE, Call → PE.
 * Wait for spot near level + reaction candle, then one ATM long. Target % on premium; SL % optional.
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
  getOptionChainOiSnapshot,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');
const { fetchTradingDayCandles } = require('./dhanDataService');
const { STRATEGY_TWELVE_MORNING_OI_LIVE_KEY } = require('../strategies/keys');

const STRATEGY_KEY = STRATEGY_TWELVE_MORNING_OI_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy12';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy12:option';
/** Scalp-fast polls for option premium exits. */
const POLL_INTERVAL_MS = 3000;
const POSITION_POLL_MS = 1000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 6000;
const TICK_FRESH_MAX_AGE_MS = 20000;
const MIN_HOLD_MS = 2000;
const OI_REFRESH_MIN_GAP_MS = 12000;
const OI_BOARD_REFRESH_MIN_GAP_MS = 10000;
const CANDLE_REFRESH_MIN_GAP_MS = 8000;
const DEFAULT_TARGET_PCT = 15;
const DEFAULT_CANDLE_INTERVAL = '1';
const DEFAULT_OI_FROM = 555; // 09:15
const DEFAULT_OI_TO = 560; // 09:20
const DEFAULT_LAST_ENTRY = 630; // 10:30
const DEFAULT_EOD = 920; // 15:20
/** Board shows enough strikes around spot to catch the real high-OI wall (e.g. 24000). */
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
    oiScanFromTime: '09:15',
    oiScanToTime: '09:20',
    lastEntryTime: '10:30',
    eodExitTime: '15:20',
    targetPct: DEFAULT_TARGET_PCT,
    stopLossPct: 10,
    hasStopLoss: true,
    proximityPoints: 25,
    strikeLookaround: 10,
    strikeMode: 'ATM',
    candleInterval: DEFAULT_CANDLE_INTERVAL,
    perTradeCost: 100,
  },
  lotSize: 65,
  expiry: null,
  expiryDateKey: null,
  lastSpot: null,
  lastOptionTick: null,
  /** In-memory only — never written to Mongo. */
  morningSignal: null,
  /** Live OI board for UI (memory only). */
  liveOiBoard: null,
  lastOiBoardFetchAt: 0,
  lastOiFetchAt: 0,
  lastOiError: null,
  todayBars1m: [],
  lastCandleFetchAt: 0,
  lastCandleError: null,
  skippedDateKey: null,
  tradeDateKey: null,
  openTradeId: null,
  closingTrade: false,
  enteringTrade: false,
  evaluatingEntry: false,
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
  console.log(`[MorningOiPaperLive] ${line}`, JSON.stringify(entry));
}

function getEngineSymbol() {
  return String(engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

function normalizeSettings(settings = {}) {
  const lotCount = Math.max(1, Number(settings.lotCount) || 5);
  const targetRaw = Number(settings.targetPct);
  const targetPct =
    Number.isFinite(targetRaw) && targetRaw > 0 ? Math.min(500, targetRaw) : DEFAULT_TARGET_PCT;

  let hasStopLoss = true;
  let stopLossPct = 10;
  if (Object.prototype.hasOwnProperty.call(settings, 'stopLossPct')) {
    const slRaw = settings.stopLossPct;
    if (slRaw === '' || slRaw === null || slRaw === undefined) {
      hasStopLoss = false;
      stopLossPct = null;
    } else {
      const n = Number(slRaw);
      if (!Number.isFinite(n) || n <= 0) {
        hasStopLoss = false;
        stopLossPct = null;
      } else {
        hasStopLoss = true;
        stopLossPct = Math.min(90, n);
      }
    }
  }

  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 25);
  const strikeLookaround = Math.max(1, Math.floor(Number(settings.strikeLookaround) || 10));
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount,
    oiScanFromTime: String(settings.oiScanFromTime || '09:15'),
    oiScanToTime: String(settings.oiScanToTime || '09:20'),
    lastEntryTime: String(settings.lastEntryTime || '10:30'),
    eodExitTime: String(settings.eodExitTime || '15:20'),
    targetPct,
    stopLossPct,
    hasStopLoss,
    proximityPoints,
    strikeLookaround,
    strikeMode: String(settings.strikeMode || 'ATM').toUpperCase() === 'ITM' ? 'ITM' : 'ATM',
    candleInterval: '1',
    perTradeCost,
  };
}

function oiScanFromMin() {
  return parseClockMinutes(engineState.settings.oiScanFromTime, DEFAULT_OI_FROM);
}

function oiScanToMin() {
  return parseClockMinutes(engineState.settings.oiScanToTime, DEFAULT_OI_TO);
}

function lastEntryMin() {
  return parseClockMinutes(engineState.settings.lastEntryTime, DEFAULT_LAST_ENTRY);
}

function eodExitMin() {
  return parseClockMinutes(engineState.settings.eodExitTime, DEFAULT_EOD);
}

function isEodExitTime(minutes) {
  return minutes >= eodExitMin();
}

function tradeOptionType(trade) {
  return String(trade?.optionType || 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE';
}

function premiumFromChain(chain, optionType) {
  if (!chain) return null;
  const n = optionType === 'CE' ? Number(chain.ceLtp) : Number(chain.peLtp);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Level = highest total OI near spot (the real wall, e.g. 24000).
 * Bias on that strike only: Put OI ≥ Call OI → Buy CE, else Buy PE.
 * No 1.5× / ΔOI filters for picking the level — those caused far junk strikes (e.g. 23650).
 */
function pickDominantStrike(snapshot) {
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  const atm = Number(snapshot?.atm);
  const step = Math.max(1, Number(snapshot?.strikeStep) || 50);
  let best = null;

  for (const row of strikes) {
    const putOi = Number(row.putOi);
    const callOi = Number(row.callOi);
    if (!Number.isFinite(putOi) || !Number.isFinite(callOi)) continue;
    if (putOi < 0 || callOi < 0) continue;
    if (putOi <= 0 && callOi <= 0) continue;

    const oiMass = putOi + callOi;
    if (!(oiMass > 0)) continue;

    const distSteps =
      Number.isFinite(atm) && Number.isFinite(row.strike)
        ? Math.abs(row.strike - atm) / step
        : 0;
    // Soft near-spot preference only — never enough to beat a real Cr wall far from a tiny ATM print.
    const nearBoost = 1 / (1 + distSteps * 0.12);
    const score = oiMass * nearBoost;

    if (!best || score > best.score) {
      const putDom = putOi >= callOi;
      const putChg = Number(row.putChgOi);
      const callChg = Number(row.callChgOi);
      const hasChg = Number.isFinite(putChg) && Number.isFinite(callChg);
      const ratio = putDom
        ? putOi / Math.max(callOi, 1)
        : callOi / Math.max(putOi, 1);

      best = {
        strike: row.strike,
        dominantSide: putDom ? 'PUT' : 'CALL',
        optionType: putDom ? 'CE' : 'PE',
        putOi,
        callOi,
        putChgOi: Number.isFinite(putChg) ? putChg : null,
        callChgOi: Number.isFinite(callChg) ? callChg : null,
        hasChangeOi: hasChg,
        ratio: Number(ratio.toFixed(2)),
        oiMass,
        score,
        ceLtp: row.ceLtp,
        peLtp: row.peLtp,
      };
    }
  }
  return best;
}

/**
 * Live OI board for UI — memory only, refreshed often so we can see the real high-OI strike near spot.
 */
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

    engineState.liveOiBoard = {
      at: new Date().toISOString(),
      dateKey: clock.dateKey,
      spot: snapshot.spot,
      atm: snapshot.atm,
      expiry,
      strikeStep: snapshot.strikeStep,
      strikes,
      highlight: {
        maxPutStrike: maxPut?.strike ?? null,
        maxCallStrike: maxCall?.strike ?? null,
        maxTotalStrike: maxTotal?.strike ?? null,
      },
    };
    engineState.lastOiError = null;
    return engineState.liveOiBoard;
  } catch (err) {
    engineState.lastOiError = err.message || 'OI board fetch failed';
    engineState.lastError = `OI board: ${engineState.lastOiError}`;
    return engineState.liveOiBoard;
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
    engineState.lastError = `Morning OI WS subscribe failed: ${err.message}`;
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
      engineState.lastError = `Morning OI position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

async function dedupeOpenTradesInDb(clock) {
  const openRows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
    entryTime: -1,
  });
  if (openRows.length <= 1) return openRows[0] || null;
  const [keep, ...duplicates] = openRows;
  for (const dup of duplicates) {
    dup.status = 'CLOSED';
    dup.exitTime = new Date();
    dup.exitDateKey = clock.dateKey;
    dup.reason = 'DUPLICATE_ENTRY';
    dup.pnl = 0;
    dup.pnlPct = 0;
    await dup.save();
  }
  if (duplicates.length > 0) await recalcWalletFromTrades();
  return keep;
}

async function syncEngineTradeStateFromDb(clock) {
  const open = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
    entryTime: -1,
  });
  if (open) {
    engineState.openTradeId = open._id.toString();
    engineState.tradeDateKey = open.entryDateKey;
    return;
  }
  if (engineState.openTradeId) clearOpenTrade();
  const tradedToday = await LivePaperTrade.exists({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });
  if (tradedToday) engineState.tradeDateKey = clock.dateKey;
  else if (engineState.tradeDateKey === clock.dateKey && engineState.skippedDateKey !== clock.dateKey) {
    engineState.tradeDateKey = null;
  }
  if (engineState.morningSignal?.dateKey && engineState.morningSignal.dateKey !== clock.dateKey) {
    engineState.morningSignal = null;
  }
}

async function captureMorningOiSignal(clock) {
  const from = oiScanFromMin();
  const to = oiScanToMin();
  const existing = engineState.morningSignal;
  const sameDay = existing?.dateKey === clock.dateKey;

  // After scan window: keep locked signal (success or terminal skip).
  if (sameDay && clock.minutes > to) return existing;
  // Before scan window: nothing yet.
  if (clock.minutes < from) return sameDay ? existing : null;

  // During scan window: refresh periodically so OI/ΔOI stay live.
  if (
    sameDay
    && !existing?.skip
    && Date.now() - engineState.lastOiFetchAt < OI_REFRESH_MIN_GAP_MS
  ) {
    return existing;
  }
  if (
    sameDay
    && existing?.skip
    && existing.skipReason === 'no_dominant_oi'
    && Date.now() - engineState.lastOiFetchAt < OI_REFRESH_MIN_GAP_MS
  ) {
    return existing;
  }

  try {
    const symbol = getEngineSymbol();
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    if (!expiry) {
      engineState.lastOiError = 'No weekly expiry from Dhan';
      engineState.lastError = `Morning OI: ${engineState.lastOiError}`;
      logEntry('OI_SCAN_ERROR', { ist: istClockLabel(clock), error: engineState.lastOiError });
      return existing || null;
    }

    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      lookaroundStrikes: Math.max(
        OI_BOARD_LOOKAROUND,
        Number(engineState.settings.strikeLookaround) || 10,
      ),
    });
    engineState.lastOiFetchAt = Date.now();
    engineState.lastOiError = null;

    if (!Array.isArray(snapshot.strikes) || snapshot.strikes.length === 0) {
      engineState.lastOiError = 'Empty option chain / no nearby strikes';
      engineState.lastError = `Morning OI: ${engineState.lastOiError}`;
      logEntry('OI_SCAN_EMPTY', {
        ist: istClockLabel(clock),
        allStrikeCount: snapshot.allStrikeCount || 0,
        spot: snapshot.spot,
      });
      return existing || null;
    }

    if (Number.isFinite(snapshot.spot)) engineState.lastSpot = snapshot.spot;

    const withOi = snapshot.strikes.filter(
      (r) => Number.isFinite(r.putOi) && Number.isFinite(r.callOi) && r.putOi > 0 && r.callOi > 0,
    );
    const withChg = withOi.filter(
      (r) => Number.isFinite(r.putChgOi) && Number.isFinite(r.callChgOi),
    );

    const dominant = pickDominantStrike(snapshot);
    if (!dominant) {
      engineState.morningSignal = {
        dateKey: clock.dateKey,
        skip: true,
        skipReason: 'no_dominant_oi',
        spot: snapshot.spot,
        atm: snapshot.atm,
        scanned: snapshot.strikes.length,
        withOi: withOi.length,
        withChangeOi: withChg.length,
        candleInterval: '1',
        at: new Date().toISOString(),
      };
      logEntry('OI_SCAN_NO_SIGNAL', engineState.morningSignal);
      return engineState.morningSignal;
    }

    engineState.morningSignal = {
      dateKey: clock.dateKey,
      skip: false,
      levelStrike: dominant.strike,
      optionType: dominant.optionType,
      dominantSide: dominant.dominantSide,
      putOi: dominant.putOi,
      callOi: dominant.callOi,
      putChgOi: dominant.putChgOi,
      callChgOi: dominant.callChgOi,
      hasChangeOi: Boolean(dominant.hasChangeOi),
      ratio: dominant.ratio,
      oiMass: dominant.oiMass,
      spotAtScan: snapshot.spot,
      atm: snapshot.atm,
      expiry,
      scanned: snapshot.strikes.length,
      withOi: withOi.length,
      withChangeOi: withChg.length,
      candleInterval: '1',
      at: new Date().toISOString(),
    };
    logEntry('OI_SCAN_SIGNAL', engineState.morningSignal);
    return engineState.morningSignal;
  } catch (err) {
    engineState.lastOiError = err.message || 'OI fetch failed';
    engineState.lastError = `Morning OI chain: ${engineState.lastOiError}`;
    logEntry('OI_SCAN_ERROR', { ist: istClockLabel(clock), error: engineState.lastOiError });
    return existing || null;
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
    engineState.lastCandleError = err.message || '1m candle fetch failed';
    engineState.lastError = `1m candles: ${engineState.lastCandleError}`;
    return engineState.todayBars1m;
  }
}

async function hasReactionConfirmation(clock, signal) {
  const rows = await refreshOneMinuteCandles(clock);
  if (!Array.isArray(rows) || rows.length < 2) {
    logEntry('WAIT_REACTION', {
      ist: istClockLabel(clock),
      reason: 'NO_1M_CANDLES',
      bars: rows?.length || 0,
      candleError: engineState.lastCandleError,
    });
    return false;
  }
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const open = Number(last[1]);
  const high = Number(last[2]);
  const low = Number(last[3]);
  const close = Number(last[4]);
  const prevClose = Number(prev[4]);
  if (![open, high, low, close].every(Number.isFinite)) return false;

  const level = Number(signal.levelStrike);
  const prox = engineState.settings.proximityPoints;
  if (!Number.isFinite(level)) return false;

  if (signal.optionType === 'CE') {
    const nearSupport = low <= level + prox;
    const green = close > open;
    const bounce = Number.isFinite(prevClose) ? close >= prevClose : true;
    return nearSupport && green && bounce;
  }
  const nearResist = high >= level - prox;
  const red = close < open;
  const reject = Number.isFinite(prevClose) ? close <= prevClose : true;
  return nearResist && red && reject;
}

async function evaluateEntry() {
  if (engineState.evaluatingEntry) return;
  engineState.evaluatingEntry = true;
  try {
    const clock = getIstClock(new Date());
    await ensureNseHolidaysLoaded();
    if (!isNseCashTradingDay(clock.dateKey)) {
      if (clock.minutes >= oiScanFromMin() && clock.minutes <= lastEntryMin()) {
        logEntry('ENTRY_SKIP', {
          ist: istClockLabel(clock),
          reason: isWeekendDateKey(clock.dateKey) ? 'WEEKEND' : 'HOLIDAY',
          holiday: getNseHolidayDescription(clock.dateKey),
        });
      }
      return;
    }
    await syncEngineTradeStateFromDb(clock);

    if (engineState.tradeDateKey === clock.dateKey || engineState.openTradeId) return;
    if (clock.minutes > lastEntryMin()) {
      if (!engineState.skippedDateKey && clock.minutes < eodExitMin()) {
        engineState.skippedDateKey = clock.dateKey;
        logEntry('DAY_SKIP_NO_ENTRY', { ist: istClockLabel(clock), reason: 'PAST_LAST_ENTRY' });
      }
      return;
    }

    let signal;
    try {
      signal = await captureMorningOiSignal(clock);
    } catch (err) {
      engineState.lastError = `OI signal: ${err.message}`;
      return;
    }
    if (!signal) return;
    if (signal.skip) {
      if (clock.minutes > oiScanToMin()) {
        engineState.skippedDateKey = clock.dateKey;
        engineState.tradeDateKey = clock.dateKey;
      }
      return;
    }
    if (clock.minutes < oiScanFromMin()) return;

    let spot;
    try {
      const spotMark = await getAtmPremiums({
        symbol: getEngineSymbol(),
        strike: signal.levelStrike,
        expiry: signal.expiry || engineState.expiry,
      });
      spot = Number(spotMark.chainSpot || spotMark.spot);
    } catch (err) {
      engineState.lastError = `Live spot: ${err.message}`;
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'SPOT_FETCH_FAILED', error: err.message });
      return;
    }
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'Live spot unavailable from Dhan chain';
      return;
    }
    engineState.lastSpot = spot;

    const dist = Math.abs(spot - Number(signal.levelStrike));
    if (dist > engineState.settings.proximityPoints) {
      logEntry('WAIT_PROXIMITY', {
        ist: istClockLabel(clock),
        spot,
        level: signal.levelStrike,
        dist: Number(dist.toFixed(1)),
        need: engineState.settings.proximityPoints,
      });
      return;
    }

    let confirmed = false;
    try {
      confirmed = await hasReactionConfirmation(clock, signal);
    } catch (err) {
      engineState.lastError = `1m reaction: ${err.message}`;
      return;
    }
    if (!confirmed) {
      logEntry('WAIT_REACTION', {
        ist: istClockLabel(clock),
        optionType: signal.optionType,
        level: signal.levelStrike,
        spot,
        candleInterval: '1',
      });
      return;
    }

    await placeLongOption(clock, signal, spot);
  } catch (err) {
    engineState.lastError = `Entry loop: ${err.message}`;
    logEntry('ENTRY_LOOP_ERROR', { error: err.message });
  } finally {
    engineState.evaluatingEntry = false;
  }
}

async function placeLongOption(clock, signal, spot) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId || engineState.tradeDateKey === clock.dateKey) return;

    const symbol = getEngineSymbol();
    const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    const expiry = signal.expiry || (await getEntryExpiry(symbol, clock.dateKey));
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
      engineState.lastError = `Morning OI: missing ${optionType} premium for ${strike}`;
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 5);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;
    const charges = engineState.settings.perTradeCost;
    const targetPremium = entryPremium * (1 + engineState.settings.targetPct / 100);
    const stopLossPremium = engineState.settings.hasStopLoss
      ? Math.max(0.05, entryPremium * (1 - engineState.settings.stopLossPct / 100))
      : null;

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
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: engineState.settings.hasStopLoss ? 'PCT' : null,
      targetMode: 'PCT',
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `morning_oi; level=${signal.levelStrike}; side=${signal.dominantSide}; ratio=${signal.ratio}; putOi=${signal.putOi}; callOi=${signal.callOi}; tg=${engineState.settings.targetPct}%; sl=${engineState.settings.hasStopLoss ? `${engineState.settings.stopLossPct}%` : 'off'}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradeDateKey = clock.dateKey;
    engineState.skippedDateKey = null;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      levelStrike: signal.levelStrike,
      entryPremium: Number(entryPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossPremium,
    });
    await subscribeOpenOption(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), error: err.message });
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
    trade.notes = [trade.notes, `exitMark=${markSource}; pnl=${Number(pnl.toFixed(2))}`]
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

    logEntry('EXIT_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: trade._id.toString(),
      reason,
      pnl,
      exitPremium: safeExitPremium,
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
  const tick = () => {
    const clock = getIstClock(new Date());
    refreshLiveOiBoard(clock).catch((err) => {
      engineState.lastError = `OI board: ${err.message}`;
    });
    evaluateEntry().catch((err) => {
      engineState.lastError = `Morning OI entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Morning OI exit poll: ${err.message}`;
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
  logEntry('ENGINE_START', { symbol: getEngineSymbol(), settings: engineState.settings });
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    await dedupeOpenTradesInDb(clock);
    engineState.expiry = await getNearestWeeklyExpiry(getEngineSymbol());
    engineState.expiryDateKey = clock.dateKey;
    const orphan = await dedupeOpenTradesInDb(clock);
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.tradeDateKey = orphan.entryDateKey;
      await subscribeOpenOption(orphan);
      startPositionPoll();
      await checkOpenTrade();
    }
  } catch (err) {
    engineState.lastError = `Morning OI setup: ${err.message}`;
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
      engineState.morningSignal = null;
    } catch (err) {
      engineState.lastError = `Symbol change: ${err.message}`;
    }
  }
  try {
    const wallet = await ensureWallet();
    wallet.strategy12EngineSettings = next;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Settings persist failed: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy12EngineSettings
      ? wallet.strategy12EngineSettings.toObject?.() || wallet.strategy12EngineSettings
      : {};
    const normalized = normalizeSettings({ ...persisted, symbol: persisted.symbol || symbol });
    return startEngine({ symbol: normalized.symbol || symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `Morning OI boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
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
    morningSignal: engineState.morningSignal,
    liveOiBoard: engineState.liveOiBoard,
    lastOiError: engineState.lastOiError,
    lastCandleError: engineState.lastCandleError,
    candleInterval: '1',
    oneMinuteBars: engineState.todayBars1m.length,
    skippedDateKey: engineState.skippedDateKey,
    tradeDateKey: engineState.tradeDateKey,
    openTradeId: engineState.openTradeId,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    openPositionMark: engineState.openPositionMark,
    scenarioLabel: 'Morning OI',
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
  await dedupeOpenTradesInDb(clock);
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
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);
  return positionMark;
}

async function clearDailySkipState() {
  engineState.skippedDateKey = null;
  engineState.morningSignal = null;
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

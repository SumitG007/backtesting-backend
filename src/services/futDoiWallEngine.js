/**
 * FUT ΔOI Wall V1 — paper signal + trade engine.
 * Separate strategyKey + wallet. ADX + 20 DMA · 1.5× ΔOI wall · 1 ITM · +16/−8.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { FUT_DOI_WALL_LIVE_KEY } = require('../strategies/keys');
const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const { calculateDmi, calculateSma } = require('../strategies/shared/indicators');
const { buildSignalFromBoard } = require('../strategies/futDoiWall/signals');
const { fetchTradingDayCandles } = require('./dhanDataService');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getFutureLtp,
} = require('./dhanLiveService');

const STRATEGY_KEY = FUT_DOI_WALL_LIVE_KEY;
const WALLET_KEY = 'paper_live_fut_doi_wall';
const STRATEGY_ID = 'fut-doi-wall';

const LOOP_MS = 5000;
const MIN_HOLD_MS = 20000;
/** Ignore tiny LTP noise vs entry before counting as real target/SL. */
const EXIT_EPS = 0.15;
const TREND_CACHE_MS = 60_000;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:45',
  tradeToTime: '13:00',
  eodExitTime: '15:15',
  targetPoints: 16,
  stopLossPoints: 8,
  proximityPoints: 20,
  entryDistancePoints: 10,
  minOiRatio: 1.5,
  adxEntryThreshold: 25,
  adxWatchThreshold: 20,
  dmaPeriod: 20,
  consecutiveWinsCap: 7,
  nearExpiryDays: 10,
  nearExpiryMinAdx: 30,
  cooldownSeconds: 60,
  perTradeCost: 100,
};

const engineState = {
  running: false,
  startedAt: null,
  settings: { ...DEFAULT_SETTINGS },
  loopTimer: null,
  tickInFlight: false,
  openTradeId: null,
  lastExitAtMs: 0,
  /** After an exit, require signal to leave TAKE_ENTRY before next arm. */
  entryArmed: true,
  lastEntryKey: null,
  lastSignal: null,
  lastBoardAt: null,
  lastError: null,
  lastEntryDebug: null,
  closingTrade: false,
  enteringTrade: false,
  lotSize: null,
  expiry: null,
  dailySlStopDateKey: null,
  dailySlStopAt: null,
  dailyWinCapDateKey: null,
  dailyWinCapAt: null,
  consecutiveWinsToday: 0,
  trendCache: { atMs: 0, adx: null, dma: null, futPrice: null },
};

function consecutiveWinsCap() {
  return Math.max(1, Math.floor(Number(engineState.settings.consecutiveWinsCap) || 7));
}

function parseHhmmToMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function inWindow(clockMinutes, fromStr, toStr) {
  const from = parseHhmmToMinutes(fromStr);
  const to = parseHhmmToMinutes(toStr);
  if (from == null || to == null) return true;
  return clockMinutes >= from && clockMinutes <= to;
}

function isEod(clockMinutes, eodStr) {
  const eod = parseHhmmToMinutes(eodStr);
  return eod != null && clockMinutes >= eod;
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      cashLedger: false,
      futDoiWallEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.enabled = Boolean(s.enabled);
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.targetPoints = Math.max(1, Number(s.targetPoints) || 16);
  s.stopLossPoints = Math.max(1, Number(s.stopLossPoints) || 8);
  s.proximityPoints = Math.max(5, Number(s.proximityPoints) || 20);
  s.entryDistancePoints = Math.max(3, Number(s.entryDistancePoints) || 10);
  s.minOiRatio = Math.max(1.05, Math.min(3, Number(s.minOiRatio) || 1.5));
  s.adxEntryThreshold = Math.max(10, Number(s.adxEntryThreshold) || 25);
  s.adxWatchThreshold = Math.max(5, Number(s.adxWatchThreshold) || 20);
  s.dmaPeriod = Math.max(5, Math.min(50, Math.floor(Number(s.dmaPeriod) || 20)));
  s.consecutiveWinsCap = Math.max(1, Math.min(20, Math.floor(Number(s.consecutiveWinsCap) || 7)));
  s.nearExpiryDays = Math.max(0, Math.min(21, Math.floor(Number(s.nearExpiryDays) || 10)));
  s.nearExpiryMinAdx = Math.max(10, Number(s.nearExpiryMinAdx) || 30);
  s.cooldownSeconds = Math.max(30, Math.floor(Number(s.cooldownSeconds) || 60));
  s.perTradeCost = Number.isFinite(Number(s.perTradeCost)) && Number(s.perTradeCost) >= 0 ? Number(s.perTradeCost) : 100;
  s.tradeFromTime = String(s.tradeFromTime || '09:45');
  s.tradeToTime = String(s.tradeToTime || '13:00');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  return s;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.futDoiWallEngineSettings || {});
  const rawLots = wallet.futDoiWallEngineSettings?.lotCount;
  if (rawLots == null || rawLots === '' || Number(rawLots) === 1) {
    engineState.settings = await saveSettingsToDb({ lotCount: 10 });
  }
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.futDoiWallEngineSettings?.toObject?.() || wallet.futDoiWallEngineSettings || {}),
    ...partial,
  });
  wallet.futDoiWallEngineSettings = next;
  await wallet.save();
  engineState.settings = next;
  return next;
}

/** ADX(14) + SMA(dmaPeriod) on today's index 5m bars (trend permission for V1). */
async function loadTrendContext(symbol) {
  const now = Date.now();
  if (
    engineState.trendCache.atMs
    && now - engineState.trendCache.atMs < TREND_CACHE_MS
    && Number.isFinite(engineState.trendCache.adx)
  ) {
    return engineState.trendCache;
  }
  try {
    const clock = getIstClock(new Date());
    const candles = await fetchTradingDayCandles({
      symbol: symbol || 'NIFTY',
      interval: 5,
      dateKey: clock.dateKey,
    });
    const rows = Array.isArray(candles?.rows) ? candles.rows : [];
    const highs = rows.map((r) => Number(r[2]));
    const lows = rows.map((r) => Number(r[3]));
    const closes = rows.map((r) => Number(r[4]));
    const period = Math.max(5, Number(engineState.settings.dmaPeriod) || 20);
    const { adx } = calculateDmi(highs, lows, closes, 14, 14);
    const sma = calculateSma(closes, period);
    const last = closes.length - 1;
    let adxVal = null;
    let dmaVal = null;
    for (let i = last; i >= 0; i -= 1) {
      if (adxVal == null && Number.isFinite(adx[i])) adxVal = adx[i];
      if (dmaVal == null && Number.isFinite(sma[i])) dmaVal = sma[i];
      if (adxVal != null && dmaVal != null) break;
    }
    let futPrice = null;
    try {
      const fut = await getFutureLtp({
        symbol: symbol || 'NIFTY',
        expiry: engineState.expiry || (await getNearestWeeklyExpiry(symbol || 'NIFTY')),
        maxWaitMs: 1200,
      });
      if (Number.isFinite(fut?.ltp)) futPrice = Number(fut.ltp);
    } catch {
      /* optional */
    }
    engineState.trendCache = {
      atMs: now,
      adx: adxVal,
      dma: dmaVal,
      futPrice,
    };
  } catch (err) {
    engineState.trendCache = {
      atMs: now,
      adx: engineState.trendCache.adx,
      dma: engineState.trendCache.dma,
      futPrice: engineState.trendCache.futPrice,
      error: err.message,
    };
  }
  return engineState.trendCache;
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
  }).lean();
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

async function syncOpenTradeId() {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  engineState.openTradeId = open ? String(open._id) : null;
  return open || null;
}

async function resolveOptionLtp(trade) {
  const optionType = String(trade.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
  let futSpot = null;
  try {
    const fut = await getFutureLtp({
      symbol: trade.symbol,
      expiry: trade.expiryDate,
      maxWaitMs: 1200,
    });
    if (Number.isFinite(fut?.ltp) && fut.ltp > 0) futSpot = fut.ltp;
  } catch {
    /* optional */
  }

  try {
    const inst = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType,
    });
    if (inst) {
      const ltp = await fetchInstrumentLtp(inst, { maxWaitMs: 2000, forceFresh: true });
      if (Number.isFinite(ltp) && ltp > 0) {
        return { optionLtp: ltp, spot: futSpot, source: 'marketfeed' };
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const prem = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const ltp = optionType === 'PE' ? Number(prem.peLtp) : Number(prem.ceLtp);
    const spot =
      (Number.isFinite(futSpot) && futSpot > 0)
        ? futSpot
        : (Number(prem.spot) > 0 ? Number(prem.spot) : Number(prem.chainSpot));
    if (Number.isFinite(ltp) && ltp > 0) {
      return {
        optionLtp: ltp,
        spot: Number.isFinite(spot) && spot > 0 ? spot : null,
        source: 'chain',
      };
    }
  } catch {
    /* fall through */
  }
  return { optionLtp: null, spot: futSpot, source: 'none' };
}

function pickExitSpot(mark, trade, futFallback = null) {
  for (const raw of [mark?.spot, futFallback, trade?.entrySpot, trade?.openPositionMark?.spot]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Number(n.toFixed(2));
  }
  return null;
}

function resetDailySlStopIfNewDay(dateKey) {
  if (engineState.dailySlStopDateKey && engineState.dailySlStopDateKey !== dateKey) {
    engineState.dailySlStopDateKey = null;
    engineState.dailySlStopAt = null;
  }
}

function resetDailyWinCapIfNewDay(dateKey) {
  if (engineState.dailyWinCapDateKey && engineState.dailyWinCapDateKey !== dateKey) {
    engineState.dailyWinCapDateKey = null;
    engineState.dailyWinCapAt = null;
    engineState.consecutiveWinsToday = 0;
  }
}

function applyClosedTradeToWinStreak(trade, dateKey) {
  const pnl = Number(trade.pnl);
  const reason = String(trade.reason || '').toUpperCase();
  if (pnl > 0) {
    engineState.consecutiveWinsToday += 1;
    if (engineState.consecutiveWinsToday >= consecutiveWinsCap()) {
      engineState.dailyWinCapDateKey = dateKey;
      engineState.dailyWinCapAt = trade.exitTime || new Date();
    }
  } else if (reason === 'STOP_LOSS' || pnl < 0) {
    engineState.consecutiveWinsToday = 0;
  }
}

/** Replay today's closed trades to hydrate win streak / cap after boot. */
async function hydrateWinStreakFromDb(dateKey) {
  resetDailyWinCapIfNewDay(dateKey);
  engineState.consecutiveWinsToday = 0;
  engineState.dailyWinCapDateKey = null;
  engineState.dailyWinCapAt = null;

  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
    status: 'CLOSED',
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  })
    .sort({ exitTime: 1 })
    .select({ pnl: 1, reason: 1, exitTime: 1 })
    .lean();

  for (const row of rows) {
    applyClosedTradeToWinStreak(row, dateKey);
  }
}

/** True when today's consecutive-wins cap already hit — block new entries until next IST day. */
async function isDailyWinCapActive(dateKey) {
  resetDailyWinCapIfNewDay(dateKey);
  if (engineState.dailyWinCapDateKey === dateKey) return true;
  await hydrateWinStreakFromDb(dateKey);
  return engineState.dailyWinCapDateKey === dateKey;
}

/** True when today's first STOP_LOSS already hit — block new entries until next IST trading day. */
async function isDailySlStopActive(dateKey) {
  resetDailySlStopIfNewDay(dateKey);
  if (engineState.dailySlStopDateKey === dateKey) return true;
  const firstSl = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    reason: 'STOP_LOSS',
    exitDateKey: dateKey,
  })
    .sort({ exitTime: 1 })
    .select({ exitTime: 1 })
    .lean();
  if (firstSl?.exitTime) {
    engineState.dailySlStopDateKey = dateKey;
    engineState.dailySlStopAt = firstSl.exitTime;
    return true;
  }
  return false;
}

async function secondsSinceLastExit() {
  if (engineState.lastExitAtMs > 0) {
    return (Date.now() - engineState.lastExitAtMs) / 1000;
  }
  const last = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .select({ exitTime: 1 })
    .lean();
  if (!last?.exitTime) return Infinity;
  const ms = Date.now() - new Date(last.exitTime).getTime();
  engineState.lastExitAtMs = new Date(last.exitTime).getTime();
  return ms / 1000;
}

async function finalizeTrade(trade, { exitPremium, mark, reason, futFallback = null }) {
  if (engineState.closingTrade) return null;
  engineState.closingTrade = true;
  try {
    let resolved = mark;
    if (!Number.isFinite(mark?.optionLtp) || mark?.optionLtp <= 0) {
      resolved = await resolveOptionLtp(trade);
    }
    const safeExit = Math.max(
      0.05,
      Number(exitPremium) || Number(resolved?.optionLtp) || Number(trade.entryPremium) || 0.05,
    );
    const qty = Number(trade.qty) || 0;
    const invested = (Number(trade.entryPremium) || 0) * qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const finalValue = safeExit * qty;
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());

    const exitSpot = pickExitSpot(resolved, trade, futFallback);
    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExit.toFixed(2));
    // Never persist 0 — UI treated 0 as a real FUT print.
    trade.exitSpot = exitSpot != null ? exitSpot : Number(trade.entrySpot) || undefined;
    if (!(Number(trade.exitSpot) > 0)) trade.exitSpot = undefined;
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct = investedAmount > 0
      ? Number(((pnl / investedAmount) * 100).toFixed(2))
      : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.notes = [trade.notes, `exitMark=${resolved?.source || 'n/a'}; pnl=${trade.pnl}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    await trade.save();

    await recalcWalletFromTrades();
    engineState.openTradeId = null;
    engineState.lastExitAtMs = Date.now();
    engineState.entryArmed = false;
    if (reason === 'STOP_LOSS') {
      engineState.dailySlStopDateKey = clock.dateKey;
      engineState.dailySlStopAt = trade.exitTime;
      engineState.consecutiveWinsToday = 0;
    } else {
      applyClosedTradeToWinStreak(trade, clock.dateKey);
    }
    return trade;
  } finally {
    engineState.closingTrade = false;
  }
}

async function checkOpenTrade(signal, board = null) {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) {
    engineState.openTradeId = null;
    return;
  }
  engineState.openTradeId = String(open._id);

  const clock = getIstClock(new Date());
  const mark = await resolveOptionLtp(open);
  const futFallback = Number(signal?.fut || board?.fut || open.entrySpot);
  if (Number.isFinite(mark.optionLtp) && mark.optionLtp > 0) {
    open.openPositionMark = {
      optionLtp: Number(mark.optionLtp.toFixed(2)),
      spot: Number.isFinite(mark.spot) && mark.spot > 0
        ? mark.spot
        : (Number.isFinite(futFallback) && futFallback > 0 ? futFallback : null),
      source: mark.source,
      at: new Date().toISOString(),
    };
    open.openPositionMarkAt = new Date();
    await open.save();
  }

  if (isEod(clock.minutes, engineState.settings.eodExitTime)) {
    await finalizeTrade(open, {
      exitPremium: mark.optionLtp,
      mark,
      reason: 'DAY_CLOSE',
      futFallback,
    });
    return;
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;
  // Prefer live mark for exits; chain-only marks can be stale vs entry.
  if (mark.source === 'chain' && heldMs < MIN_HOLD_MS * 2) return;

  const entry = Number(open.entryPremium);
  if (open.stopLossPremium != null && optionLtp <= Number(open.stopLossPremium) - EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: Math.min(optionLtp, Number(open.stopLossPremium)),
      mark,
      reason: 'STOP_LOSS',
      futFallback,
    });
    return;
  }
  if (open.targetPremium != null && optionLtp >= Number(open.targetPremium) + EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: Math.max(optionLtp, Number(open.targetPremium)),
      mark,
      reason: 'TARGET',
      futFallback,
    });
    return;
  }
  const targetPts = Number(engineState.settings.targetPoints) || 16;
  if (Number.isFinite(entry) && optionLtp >= entry + targetPts - EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark,
      reason: 'TARGET',
      futFallback,
    });
  }

  // No OI conflict / side-flip exits — Spot vs FUT basis conflict is normal.
  // Open trades exit only on TARGET, STOP_LOSS, DAY_CLOSE, or manual close.
}

async function tryEnter(signal, board) {
  if (!engineState.settings.enabled) return;
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (signal?.status !== 'TAKE_ENTRY' || !signal.buyLive || !signal.optionType) {
    // Leaving TAKE_ENTRY re-arms for the next clean setup.
    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }
    return;
  }
  if (!engineState.entryArmed) {
    engineState.lastEntryDebug = { skip: 'waiting_rearm', status: signal.status };
    return;
  }

  const clock = getIstClock(new Date());
  if (isWeekendDateKey(clock.dateKey)) {
    engineState.lastEntryDebug = { skip: 'weekend', dateKey: clock.dateKey };
    return;
  }
  if (await isDailySlStopActive(clock.dateKey)) {
    engineState.lastEntryDebug = {
      skip: 'daily_sl_stop',
      dateKey: clock.dateKey,
      stoppedAt: engineState.dailySlStopAt,
    };
    return;
  }
  if (await isDailyWinCapActive(clock.dateKey)) {
    engineState.lastEntryDebug = {
      skip: 'daily_win_cap',
      dateKey: clock.dateKey,
      stoppedAt: engineState.dailyWinCapAt,
      consecutiveWins: consecutiveWinsCap(),
    };
    return;
  }
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) {
    engineState.lastEntryDebug = { skip: 'OUTSIDE_WINDOW' };
    return;
  }
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) return;

  const cooldownSec = Math.max(30, Number(engineState.settings.cooldownSeconds) || 60);
  const sinceExit = await secondsSinceLastExit();
  if (sinceExit < cooldownSec) {
    engineState.lastEntryDebug = {
      skip: 'cooldown',
      sinceExitSec: Number(sinceExit.toFixed(1)),
      need: cooldownSec,
    };
    return;
  }

  const existing = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).lean();
  if (existing) {
    engineState.openTradeId = String(existing._id);
    return;
  }

  engineState.enteringTrade = true;
  try {
    const symbol = engineState.settings.symbol || 'NIFTY';
    const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    const step = Math.max(1, Number(board?.strikeStep) || 50);
    const atm = Number(board?.atm || signal.atm || signal.levelStrike);
    const itmStrike = optionType === 'PE' ? atm + step : atm - step;
    const strike = Number(signal.entryStrike || itmStrike);
    const expiry = String(board?.expiry || engineState.expiry || (await getNearestWeeklyExpiry(symbol)) || '').slice(0, 10);
    if (!Number.isFinite(strike) || !expiry) {
      engineState.lastEntryDebug = { skip: 'missing_strike_or_expiry' };
      return;
    }

    // Near-expiry filter: last N days need stronger ADX.
    const nearDays = Math.max(0, Number(engineState.settings.nearExpiryDays) || 10);
    if (nearDays > 0 && expiry) {
      const today = clock.dateKey;
      const expMs = Date.parse(`${expiry}T00:00:00+05:30`);
      const todayMs = Date.parse(`${today}T00:00:00+05:30`);
      const daysLeft = Number.isFinite(expMs) && Number.isFinite(todayMs)
        ? Math.round((expMs - todayMs) / 86400000)
        : null;
      const needAdx = Number(engineState.settings.nearExpiryMinAdx) || 30;
      if (daysLeft != null && daysLeft >= 0 && daysLeft <= nearDays) {
        const adxNow = Number(signal.adx);
        if (!Number.isFinite(adxNow) || adxNow < needAdx) {
          engineState.lastEntryDebug = {
            skip: 'EXPIRY_FILTER',
            daysLeft,
            adx: adxNow,
            needAdx,
          };
          return;
        }
      }
    }

    // Prefer fresh marketfeed LTP so entry matches real premium (not stale chain).
    let entryPremium = null;
    let entrySource = 'none';
    try {
      const inst = await resolveOptionInstrument({ symbol, strike, expiry, optionType });
      if (inst) {
        const live = await fetchInstrumentLtp(inst, { maxWaitMs: 2000, forceFresh: true });
        if (Number.isFinite(live) && live > 0) {
          entryPremium = live;
          entrySource = 'marketfeed';
        }
      }
    } catch {
      /* fall through */
    }
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastEntryDebug = {
        skip: 'no_live_premium',
        strike,
        optionType,
        expiry,
        hint: 'Skipped — need live option LTP (avoid stale chain fills)',
      };
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    engineState.expiry = expiry;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 10);
    const qty = lotSize * lots;
    const charges = Math.max(0, Number(engineState.settings.perTradeCost) || 0);
    const targetPoints = Number(engineState.settings.targetPoints) || 16;
    const stopLossPoints = Number(engineState.settings.stopLossPoints) || 8;
    const targetPremium = entryPremium + targetPoints;
    const stopLossPremium = Math.max(0.05, entryPremium - stopLossPoints);
    const fut = Number(signal.fut || board?.fut);
    const entryFut = Number.isFinite(fut) && fut > 0 ? fut : null;

    const entryKey = `${clock.dateKey}:${optionType}:${strike}:${Math.round(entryPremium * 10)}`;
    if (engineState.lastEntryKey === entryKey && sinceExit < cooldownSec * 2) {
      engineState.lastEntryDebug = { skip: 'duplicate_entry_key', entryKey };
      return;
    }

    const tradeDoc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType,
      product: 'OPTION',
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: entryFut != null ? Number(entryFut.toFixed(2)) : Number(entryPremium.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `FUT ΔOI Wall ${optionType} 1ITM · wall ${signal.levelStrike} · ADX ${signal.adx} · Spot ${signal.spotState}`,
      notes: `fut_doi_wall; wall=${signal.levelStrike}; side=${signal.dominantSide}; ratio=${signal.ratio}; tg=${targetPoints}; sl=${stopLossPoints}; entrySrc=${entrySource}; spot=${signal.spotState}; cluster=${signal.futAgree}/3`,
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.lastEntryKey = entryKey;
    engineState.entryArmed = false; // consume arm until next non-TAKE_ENTRY then re-arm
    engineState.lastEntryDebug = {
      at: new Date().toISOString(),
      tradeId: engineState.openTradeId,
      optionType,
      strike,
      entryPremium,
      entrySource,
      targetPremium,
      stopLossPremium,
      signal,
    };
  } catch (err) {
    engineState.lastError = err.message;
    engineState.lastEntryDebug = { skip: 'entry_error', error: err.message };
  } finally {
    engineState.enteringTrade = false;
  }
}

async function fetchBoard() {
  const manualEngine = require('./manualTradeEngine');
  return manualEngine.getLiveOiBoard({
    symbol: engineState.settings.symbol || 'NIFTY',
    lookaroundStrikes: 10,
  });
}

async function tickOnce() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    await loadSettingsFromDb();
    const clock = getIstClock(new Date());
    resetDailySlStopIfNewDay(clock.dateKey);
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }
    const board = await fetchBoard();
    engineState.lastBoardAt = board?.at || new Date().toISOString();
    const trend = await loadTrendContext(engineState.settings.symbol);
    const signal = buildSignalFromBoard(board, engineState.settings, {
      adx: trend.adx,
      dma: trend.dma,
      futPrice: trend.futPrice ?? board?.fut,
    });

    // Re-arm only when signal leaves TAKE_ENTRY (fresh setup required).
    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }

    engineState.lastSignal = {
      ...signal,
      at: engineState.lastBoardAt,
      enabled: engineState.settings.enabled,
      entryArmed: engineState.entryArmed,
    };

    const hadOpen = Boolean(engineState.openTradeId);
    await checkOpenTrade(signal, board);
    const closedThisTick = hadOpen && !engineState.openTradeId;

    // Never enter in the same tick as an exit.
    if (!engineState.openTradeId && !closedThisTick) {
      await tryEnter(signal, board);
    }
    engineState.lastError = null;
  } catch (err) {
    engineState.lastError = err.message;
  } finally {
    engineState.tickInFlight = false;
  }
}

function startLoop() {
  if (engineState.loopTimer) return;
  engineState.loopTimer = setInterval(() => {
    tickOnce().catch((err) => {
      engineState.lastError = err.message;
    });
  }, LOOP_MS);
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    await loadSettingsFromDb();
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }
    await syncOpenTradeId();
    await recalcWalletFromTrades();
    await secondsSinceLastExit(); // hydrate lastExitAtMs from DB
    const bootClock = getIstClock(new Date());
    await isDailySlStopActive(bootClock.dateKey);
    await isDailyWinCapActive(bootClock.dateKey);
    engineState.running = true;
    engineState.startedAt = new Date();
    engineState.entryArmed = true;
    startLoop();
    tickOnce().catch(() => {});
    console.log('FUT ΔOI Wall paper engine started');
    return { ok: true, started: true };
  }
  await syncOpenTradeId();
  return { ok: true, alreadyRunning: true };
}

async function getStatus() {
  await ensureEngineRunning();
  const wallet = await ensureWallet();
  const open = engineState.openTradeId
    ? await LivePaperTrade.findById(engineState.openTradeId).lean()
    : await LivePaperTrade.findOne({
      strategyKey: STRATEGY_KEY,
      status: 'OPEN',
      exitTime: null,
    }).lean();

  return {
    strategyId: STRATEGY_ID,
    strategyKey: STRATEGY_KEY,
    running: engineState.running,
    settings: engineState.settings,
    enabled: Boolean(engineState.settings.enabled),
    signal: engineState.lastSignal,
    openTrade: open || null,
    openTradeId: open ? String(open._id) : null,
    wallet: {
      walletKey: WALLET_KEY,
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    lastBoardAt: engineState.lastBoardAt,
    startedAt: engineState.startedAt,
    dailySlStop: engineState.dailySlStopDateKey
      ? {
        dateKey: engineState.dailySlStopDateKey,
        stoppedAt: engineState.dailySlStopAt,
      }
      : null,
    dailyWinCap: engineState.dailyWinCapDateKey
      ? {
        dateKey: engineState.dailyWinCapDateKey,
        stoppedAt: engineState.dailyWinCapAt,
        consecutiveWins: consecutiveWinsCap(),
      }
      : null,
    consecutiveWinsToday: engineState.consecutiveWinsToday,
  };
}

async function setEnabled(enabled) {
  const settings = await saveSettingsToDb({ enabled: Boolean(enabled) });
  await ensureEngineRunning();
  return { ok: true, enabled: settings.enabled, settings };
}

async function updateSettings(partial = {}) {
  const settings = await saveSettingsToDb(partial);
  return { ok: true, settings };
}

async function listTrades({ status, page = 1, pageSize = 50 } = {}) {
  const q = { strategyKey: STRATEGY_KEY };
  if (status === 'OPEN') {
    q.status = 'OPEN';
    q.exitTime = null;
  } else if (status === 'CLOSED') {
    q.$or = [{ status: 'CLOSED' }, { exitTime: { $ne: null } }];
  }
  const size = Math.max(1, Math.min(200, Math.floor(Number(pageSize) || 50)));
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const total = await LivePaperTrade.countDocuments(q);
  const trades = await LivePaperTrade.find(q)
    .sort({ entryTime: -1 })
    .skip((p - 1) * size)
    .limit(size)
    .lean();
  return {
    trades,
    pagination: {
      page: p,
      pageSize: size,
      totalRows: total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    },
  };
}

async function getBookSummary() {
  const wallet = await recalcWalletFromTrades();
  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();

  let openMtm = 0;
  for (const t of open) {
    const markLtp = Number(t.openPositionMark?.optionLtp);
    if (Number.isFinite(markLtp) && Number.isFinite(t.entryPremium)) {
      openMtm += (markLtp - Number(t.entryPremium)) * Number(t.qty) - (Number(t.charges) || 0);
    }
  }

  return {
    settings: engineState.settings,
    enabled: Boolean(engineState.settings.enabled),
    signal: engineState.lastSignal,
    wallet: {
      walletKey: WALLET_KEY,
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    openTrades: open,
    closedTrades: [],
    openCount: open.length,
    closedCount: wallet.totalTrades,
    openMtm: Number(openMtm.toFixed(2)),
    lastError: engineState.lastError,
  };
}

async function closeOpenTradeManual(reason = 'MANUAL_CLOSE') {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) throw new Error('No open auto trade');
  const mark = await resolveOptionLtp(open);
  return finalizeTrade(open, {
    exitPremium: mark.optionLtp,
    mark,
    reason,
    futFallback: mark.spot || open.entrySpot,
  });
}

module.exports = {
  STRATEGY_KEY,
  WALLET_KEY,
  STRATEGY_ID,
  ensureEngineRunning,
  getStatus,
  setEnabled,
  updateSettings,
  listTrades,
  getBookSummary,
  closeOpenTradeManual,
  buildSignalFromBoard,
  recalcWalletFromTrades,
};

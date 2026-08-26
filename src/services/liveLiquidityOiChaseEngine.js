/**
 * Liquidity OI Chase — paper live.
 * 5m liquidity sweep+break + OI Flow fuel (streak / lead / ΔPCR) → ATM CE/PE.
 * SL = index beyond swept pool · Target = next opposite pool (spot) · EOD 15:15.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { LIQUIDITY_OI_CHASE_LIVE_KEY } = require('../strategies/keys');
const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getIndexLtp,
} = require('./dhanLiveService');
const { fetchTradingDayCandles } = require('./dhanDataService');
const { buildLiquiditySwings, detectSweepBreak } = require('./liquiditySwings');
const { enrichOiWindow, buildChaseSignal } = require('./liquidityOiChaseSignal');
const { pushNotification } = require('./notificationHub');
const { isNseCashTradingDay } = require('./nseHolidayService');

const STRATEGY_KEY = LIQUIDITY_OI_CHASE_LIVE_KEY;
const NOTIF_STRATEGY = 'Liquidity OI Chase';
const WALLET_KEY = 'paper_live_liquidity_oi_chase';
const STRATEGY_ID = 'liquidity-oi-chase';
const LOOP_MS = 5000;
const OPEN_MARK_MS = 1000;
const MIN_HOLD_MS = 20000;
const EXIT_EPS = 0.15;
const CANDLE_CACHE_MS = 45 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 1,
  tradeFromTime: '09:30',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  // Daily-leaning profile: shorter swings + light OI fuel (still needs sweep+break).
  swingLength: 5,
  oiWindowMins: 10,
  minStreak: 1,
  requireLead: false,
  requireTopAct: false,
  slBufferPts: 8,
  breakBufferPts: 0,
  maxDeltaPcrFight: 0.15,
  maxSlAtrMult: 2,
  fallbackTargetPts: 35,
  softTargetOptionPts: 12,
  maxTradesPerDay: 3,
  cooldownSeconds: 120,
  perTradeCost: 0,
  settingsVersion: 2,
};

const engineState = {
  running: false,
  startedAt: null,
  settings: { ...DEFAULT_SETTINGS },
  loopTimer: null,
  markTimer: null,
  tickInFlight: false,
  openTradeId: null,
  lastExitAtMs: 0,
  lastSignalKey: null,
  entryArmed: true,
  lastDecision: null,
  lastError: null,
  lastEntryDebug: null,
  liveOpenMark: null,
  closingTrade: false,
  enteringTrade: false,
  lotSize: null,
  expiry: null,
  candleCache: { at: 0, dateKey: null, rows: [] },
  liveSignal: null,
};

function parseHhmmToMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
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

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.enabled = raw.enabled === false ? false : true;
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(20, Math.floor(Number(s.lotCount) || 1)));
  s.swingLength = Math.max(3, Math.min(30, Math.floor(Number(s.swingLength) || 5)));
  s.oiWindowMins = Math.max(5, Math.min(60, Math.floor(Number(s.oiWindowMins) || 10)));
  s.minStreak = Math.max(1, Math.min(10, Math.floor(Number(s.minStreak) || 1)));
  s.requireLead = raw.requireLead === true;
  s.requireTopAct = raw.requireTopAct === true;
  s.slBufferPts = Math.max(2, Math.min(30, Number(s.slBufferPts) || 8));
  s.breakBufferPts = Math.max(0, Math.min(10, Number(s.breakBufferPts) || 0));
  s.maxDeltaPcrFight = Math.max(0.02, Math.min(0.4, Number(s.maxDeltaPcrFight) || 0.15));
  s.maxSlAtrMult = Math.max(0.8, Math.min(3, Number(s.maxSlAtrMult) || 2));
  s.fallbackTargetPts = Math.max(15, Math.min(120, Number(s.fallbackTargetPts) || 35));
  s.softTargetOptionPts = Math.max(5, Math.min(50, Number(s.softTargetOptionPts) || 12));
  s.maxTradesPerDay = Math.max(1, Math.min(8, Math.floor(Number(s.maxTradesPerDay) || 3)));
  s.cooldownSeconds = Math.max(60, Math.floor(Number(s.cooldownSeconds) || 120));
  s.perTradeCost = Math.max(0, Number(s.perTradeCost) || 0);
  s.tradeFromTime = String(s.tradeFromTime || '09:30');
  s.tradeToTime = String(s.tradeToTime || '14:30');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  s.settingsVersion = Math.max(2, Math.floor(Number(s.settingsVersion) || 2));
  return s;
}

async function ensureWallet() {
  let w = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!w) {
    w = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      liquidityOiChaseEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return w;
}

async function loadSettingsFromDb() {
  const w = await ensureWallet();
  const raw = w.liquidityOiChaseEngineSettings || {};
  // One-time migrate tight v1 → daily-leaning v2 (keep user's lotCount / enabled).
  if (Number(raw.settingsVersion || 0) < 2) {
    const migrated = normalizeSettings({
      ...raw,
      swingLength: 5,
      oiWindowMins: 10,
      minStreak: 1,
      requireLead: false,
      requireTopAct: false,
      maxDeltaPcrFight: 0.15,
      maxSlAtrMult: 2,
      fallbackTargetPts: 35,
      softTargetOptionPts: 12,
      maxTradesPerDay: Math.max(3, Number(raw.maxTradesPerDay) || 3),
      cooldownSeconds: 120,
      tradeToTime: raw.tradeToTime && raw.tradeToTime > '14:00' ? raw.tradeToTime : '14:30',
      settingsVersion: 2,
    });
    w.liquidityOiChaseEngineSettings = migrated;
    await w.save();
    engineState.settings = migrated;
    return migrated;
  }
  engineState.settings = normalizeSettings(raw);
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const w = await ensureWallet();
  const next = normalizeSettings({ ...(w.liquidityOiChaseEngineSettings || {}), ...partial });
  w.liquidityOiChaseEngineSettings = next;
  await w.save();
  engineState.settings = next;
  return next;
}

async function recalcWalletFromTrades() {
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
  }).select({ pnl: 1 }).lean();
  let realized = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
    const p = Number(t.pnl) || 0;
    realized += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  const w = await ensureWallet();
  w.realizedPnl = Number(realized.toFixed(2));
  w.balance = Number(realized.toFixed(2));
  w.totalTrades = closed.length;
  w.wins = wins;
  w.losses = losses;
  await w.save();
  return w;
}

function tradeQty(trade) {
  const q = Number(trade?.qty);
  if (Number.isFinite(q) && q > 0) return q;
  return (Number(trade?.lotSize) || 65) * (Number(trade?.lots) || 1);
}

function computeOpenMtm(trade, optionLtp) {
  const entry = Number(trade.entryPremium);
  const qty = tradeQty(trade);
  if (!Number.isFinite(entry) || !Number.isFinite(optionLtp) || !(qty > 0)) return null;
  return (optionLtp - entry) * qty - Math.max(0, Number(trade.charges) || 0);
}

async function resolveOptionLtp(trade) {
  try {
    const spotRes = await getIndexLtp({ symbol: trade.symbol || 'NIFTY' }).catch(() => null);
    const spot = Number(spotRes?.ltp);
    const securityId = trade.signalSnapshot?.securityId;
    const exchangeSegment = trade.signalSnapshot?.exchangeSegment || 'NSE_FNO';
    if (securityId) {
      const ltp = await fetchInstrumentLtp(
        { securityId, exchangeSegment },
        { maxWaitMs: 600, forceFresh: true },
      ).catch(() => null);
      if (Number(ltp) > 0) {
        return { optionLtp: Number(ltp), spot: Number(spot) || null, source: 'marketfeed', securityId };
      }
    }
    const prem = await getAtmPremiums({
      symbol: trade.symbol || 'NIFTY',
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const optionLtp = trade.optionType === 'PE' ? prem?.peLtp : prem?.ceLtp;
    return {
      optionLtp: Number(optionLtp) || Number(trade.entryPremium),
      spot: Number(spot) || Number(trade.entrySpot),
      source: 'chain',
    };
  } catch (err) {
    return { optionLtp: Number(trade.entryPremium), spot: Number(trade.entrySpot), source: 'fallback', error: err.message };
  }
}

async function loadFiveMinCandles(dateKey) {
  const now = Date.now();
  if (
    engineState.candleCache.dateKey === dateKey &&
    now - engineState.candleCache.at < CANDLE_CACHE_MS &&
    engineState.candleCache.rows.length
  ) {
    return engineState.candleCache.rows;
  }
  const payload = await fetchTradingDayCandles({
    symbol: engineState.settings.symbol || 'NIFTY',
    interval: '5',
    dateKey,
  });
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  // Drop forming bar (last incomplete 5m) if session live — keep confirmed closes only for pivots.
  const clock = getIstClock(new Date());
  let use = rows;
  if (clock.dateKey === dateKey && rows.length > 2) {
    use = rows.slice(0, -1);
  }
  engineState.candleCache = { at: now, dateKey, rows: use };
  return use;
}

async function loadMinuteRows(dateKey) {
  return OiFlowMinuteRow.find({
    symbol: engineState.settings.symbol || 'NIFTY',
    dateKey,
  })
    .sort({ minutes: 1 })
    .select('-strikes')
    .lean();
}

async function readLatestSignal() {
  const clock = getIstClock(new Date());
  const sessionOpen =
    inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)
    && !isEod(clock.minutes, engineState.settings.eodExitTime);

  if (isWeekendDateKey(clock.dateKey) || !isNseCashTradingDay(clock.dateKey)) {
    engineState.liveSignal = {
      status: 'WAIT',
      detail: 'Market closed',
      headline: 'Market closed',
      buyLive: false,
      checks: [],
      at: new Date().toISOString(),
    };
    return null;
  }
  let candles;
  try {
    candles = await loadFiveMinCandles(clock.dateKey);
    engineState.lastError = null;
  } catch (err) {
    engineState.lastError = `Candles: ${err.message}`;
    engineState.liveSignal = {
      status: 'WAIT',
      detail: engineState.lastError,
      headline: 'Candles unavailable',
      buyLive: false,
      checks: [
        {
          id: 'candles',
          name: '5m candles',
          short: 'Cdl',
          ok: false,
          value: 'err',
          need: 'Dhan historical',
          note: err.message,
        },
      ],
      at: new Date().toISOString(),
    };
    return null;
  }
  const swings = buildLiquiditySwings(candles, { length: engineState.settings.swingLength });
  const sweep = detectSweepBreak(swings, {
    slBufferPts: engineState.settings.slBufferPts,
    breakBufferPts: engineState.settings.breakBufferPts,
  });
  sweep.highCount = swings.highs?.length || 0;
  sweep.lowCount = swings.lows?.length || 0;
  const minutes = await loadMinuteRows(clock.dateKey);
  const oiFuel = enrichOiWindow(minutes, engineState.settings.oiWindowMins);
  const signal = buildChaseSignal({
    sweep,
    oiFuel,
    settings: engineState.settings,
    inWindow: sessionOpen,
  });
  signal.swings = {
    atr: swings.atr,
    highCount: swings.highs?.length || 0,
    lowCount: swings.lows?.length || 0,
    lastClose: swings.lastClose,
    lastOpen: swings.lastOpen,
    lastHigh: swings.lastHigh,
    lastLow: swings.lastLow,
    barCount: swings.barCount,
    length: swings.length,
    // Recent pools for live chart overlays (slim objects)
    highs: (swings.highs || []).map((z) => ({
      kind: z.kind,
      index: z.index,
      time: z.time,
      top: z.top,
      bottom: z.bottom,
      mid: z.mid,
      broken: Boolean(z.broken),
    })),
    lows: (swings.lows || []).map((z) => ({
      kind: z.kind,
      index: z.index,
      time: z.time,
      top: z.top,
      bottom: z.bottom,
      mid: z.mid,
      broken: Boolean(z.broken),
    })),
  };
  // Chart payload — same confirmed 5m series the engine used
  signal.chart = {
    symbol: engineState.settings.symbol || 'NIFTY',
    interval: '5',
    dateKey: clock.dateKey,
    candles: candles,
    updatedAt: new Date().toISOString(),
  };
  signal.spot = Number(swings.lastClose) || null;
  signal.time = `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`;
  if (signal.status !== 'TAKE_ENTRY') {
    engineState.entryArmed = true;
  }
  // Fallback target from ATR / fixed pts
  if (signal.buyLive && !(Number(signal.targetSpot) > 0) && Number(swings.lastClose) > 0) {
    const pts = Number(engineState.settings.fallbackTargetPts) || 40;
    signal.targetSpot =
      signal.optionType === 'CE' ? swings.lastClose + pts : swings.lastClose - pts;
  }
  // Skip if SL too wide vs ATR
  if (signal.buyLive && Number(swings.atr) > 0 && Number(signal.stopSpot) > 0 && Number(swings.lastClose) > 0) {
    const width = Math.abs(swings.lastClose - signal.stopSpot);
    const maxW = swings.atr * (Number(engineState.settings.maxSlAtrMult) || 1.5);
    if (width > maxW) {
      signal.status = 'CAUTION';
      signal.buyLive = false;
      signal.detail = `SL too wide (${width.toFixed(0)} > ${maxW.toFixed(0)} ATR cap)`;
      signal.headline = 'SL too wide';
      if (Array.isArray(signal.checks)) {
        signal.checks.push({
          id: 'slwidth',
          name: 'SL vs ATR',
          short: 'SL',
          ok: false,
          value: width.toFixed(0),
          need: `≤ ${maxW.toFixed(0)}`,
          note: signal.detail,
        });
      }
    }
  }
  engineState.liveSignal = signal;
  engineState.lastDecision = signal;
  return signal.buyLive && sessionOpen ? signal : null;
}

async function finalizeTrade(trade, { exitPremium, mark, reason }) {
  if (engineState.closingTrade) return null;
  engineState.closingTrade = true;
  try {
    const safeExit = Math.max(
      0.05,
      Number(exitPremium) || Number(mark?.optionLtp) || Number(trade.entryPremium) || 0.05,
    );
    const qty = tradeQty(trade) || Number(trade.qty) || 0;
    const invested = (Number(trade.entryPremium) || 0) * qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const finalValue = safeExit * qty;
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());
    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExit.toFixed(2));
    trade.exitSpot = Number.isFinite(Number(mark?.spot)) ? Number(Number(mark.spot).toFixed(2)) : trade.entrySpot;
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    trade.pnlPct = invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    await trade.save();
    await recalcWalletFromTrades();
    engineState.openTradeId = null;
    engineState.liveOpenMark = null;
    engineState.lastExitAtMs = Date.now();
    engineState.entryArmed = false;
    pushNotification({
      type: 'EXIT',
      strategy: NOTIF_STRATEGY,
      title: `Closed ${trade.optionType || ''} ${trade.strike || ''}`.trim(),
      body: `${reason} · P/L ₹${Number(pnl.toFixed(2))}`,
      meta: { tradeId: String(trade._id), reason, pnl },
      dedupeKey: `liq-chase-exit:${trade._id}`,
    });
    return trade;
  } finally {
    engineState.closingTrade = false;
  }
}

async function secondsSinceLastExit() {
  if (engineState.lastExitAtMs > 0) return (Date.now() - engineState.lastExitAtMs) / 1000;
  const last = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: { $ne: null } })
    .sort({ exitTime: -1 })
    .select({ exitTime: 1 })
    .lean();
  if (!last?.exitTime) return Infinity;
  engineState.lastExitAtMs = new Date(last.exitTime).getTime();
  return (Date.now() - engineState.lastExitAtMs) / 1000;
}

async function tradesTodayCount(dateKey) {
  return LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
  });
}

async function checkOpenTrade() {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) {
    engineState.openTradeId = null;
    engineState.liveOpenMark = null;
    return;
  }
  engineState.openTradeId = String(open._id);
  const clock = getIstClock(new Date());
  const mark = await resolveOptionLtp(open);
  const optionLtp = Number(mark.optionLtp);
  const spot = Number(mark.spot);

  if (Number.isFinite(optionLtp) && optionLtp > 0) {
    const mtm = computeOpenMtm(open, optionLtp);
    engineState.liveOpenMark = {
      tradeId: String(open._id),
      mark: {
        optionLtp: Number(optionLtp.toFixed(2)),
        spot: Number.isFinite(spot) ? Number(spot.toFixed(2)) : null,
        source: mark.source,
        at: new Date().toISOString(),
        mtm: mtm != null ? Number(mtm.toFixed(2)) : null,
        qty: tradeQty(open),
        stopSpot: Number(open.combinedStopSpot) || null,
        targetSpot: Number(open.signalSnapshot?.targetSpot) || null,
        targetPremium: Number(open.targetPremium) || null,
      },
    };
    open.openPositionMark = engineState.liveOpenMark.mark;
    open.openPositionMarkAt = new Date();
    await open.save().catch(() => {});
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  if (isEod(clock.minutes, engineState.settings.eodExitTime)) {
    await finalizeTrade(open, { exitPremium: optionLtp, mark, reason: 'DAY_CLOSE' });
    return;
  }

  const stopSpot = Number(open.combinedStopSpot);
  if (Number.isFinite(stopSpot) && Number.isFinite(spot) && spot > 0) {
    const hit =
      open.optionType === 'CE' ? spot <= stopSpot : spot >= stopSpot;
    if (hit) {
      await finalizeTrade(open, { exitPremium: optionLtp, mark, reason: 'STOP_LOSS' });
      return;
    }
  }

  const targetSpot = Number(open.targetSpot) || Number(open.signalSnapshot?.targetSpot);
  if (Number.isFinite(targetSpot) && Number.isFinite(spot) && spot > 0) {
    const hit =
      open.optionType === 'CE' ? spot >= targetSpot : spot <= targetSpot;
    if (hit) {
      await finalizeTrade(open, { exitPremium: optionLtp, mark, reason: 'TARGET' });
      return;
    }
  }

  if (open.targetPremium != null && Number.isFinite(optionLtp) && optionLtp >= Number(open.targetPremium) + EXIT_EPS) {
    await finalizeTrade(open, { exitPremium: optionLtp, mark, reason: 'TARGET' });
  }
}

async function tryEnter(signal) {
  if (!signal?.buyLive || !engineState.settings.enabled) return;
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (!engineState.entryArmed) {
    engineState.lastEntryDebug = { skip: 'waiting_rearm' };
    return;
  }
  const clock = getIstClock(new Date());
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) return;
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) return;
  if (isWeekendDateKey(clock.dateKey) || !isNseCashTradingDay(clock.dateKey)) return;

  const todayN = await tradesTodayCount(clock.dateKey);
  if (todayN >= (Number(engineState.settings.maxTradesPerDay) || 2)) {
    engineState.lastEntryDebug = { skip: 'max_trades_day', todayN };
    return;
  }

  const cool = Math.max(60, Number(engineState.settings.cooldownSeconds) || 300);
  const since = await secondsSinceLastExit();
  if (since < cool) {
    engineState.lastEntryDebug = { skip: 'cooldown', since, need: cool };
    return;
  }

  const signalKey = `${clock.dateKey}:${signal.optionType}:${Number(signal.stopSpot)?.toFixed?.(0)}:${Number(signal.swings?.lastClose)?.toFixed?.(0)}`;
  if (engineState.lastSignalKey === signalKey) {
    engineState.lastEntryDebug = { skip: 'same_setup', signalKey };
    return;
  }

  engineState.enteringTrade = true;
  try {
    const symbol = engineState.settings.symbol || 'NIFTY';
    const optionType = signal.optionType;
    const [idxRes, expiry, lotSize] = await Promise.all([
      getIndexLtp({ symbol, maxWaitMs: 800, forceFresh: true }),
      getNearestWeeklyExpiry(symbol),
      getCurrentLotSize(symbol),
    ]);
    engineState.expiry = String(expiry || '').slice(0, 10);
    if (Number(lotSize) > 0) engineState.lotSize = Number(lotSize);
    const spot = Number(idxRes?.ltp) || Number(signal.swings?.lastClose);
    if (!(spot > 0) || !engineState.expiry) {
      engineState.lastEntryDebug = { skip: 'no_spot_or_expiry' };
      return;
    }
    const step = symbol === 'BANKNIFTY' ? 100 : 50;
    const strike = Math.round(spot / step) * step;
    const instrument = await resolveOptionInstrument({
      symbol,
      strike,
      expiry: engineState.expiry,
      optionType,
    });
    const securityId = instrument?.securityId;
    if (!securityId) {
      engineState.lastEntryDebug = { skip: 'no_instrument', strike, optionType };
      return;
    }
    let livePremium = await fetchInstrumentLtp(
      { securityId, exchangeSegment: instrument.exchangeSegment || 'NSE_FNO' },
      { maxWaitMs: 800, forceFresh: true },
    ).catch(() => null);
    if (!(Number(livePremium) > 0)) {
      const prem = await getAtmPremiums({ symbol, strike, expiry: engineState.expiry });
      livePremium = optionType === 'PE' ? prem?.peLtp : prem?.ceLtp;
    }
    livePremium = Number(livePremium);
    if (!(livePremium > 0)) {
      engineState.lastEntryDebug = { skip: 'no_premium' };
      return;
    }

    const lots = engineState.settings.lotCount;
    const qty = (engineState.lotSize || 65) * lots;
    const softTg = livePremium + (Number(engineState.settings.softTargetOptionPts) || 15);
    const charges = Math.max(0, Number(engineState.settings.perTradeCost) || 0);

    const trade = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType,
      product: 'OPTION',
      strike,
      expiryDate: engineState.expiry,
      lotSize: engineState.lotSize || 65,
      lots,
      qty,
      entryPremium: Number(livePremium.toFixed(2)),
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      targetPremium: Number(softTg.toFixed(2)),
      stopLossPremium: null,
      combinedStopSpot: Number(signal.stopSpot),
      targetSpot: Number(signal.targetSpot) > 0 ? Number(signal.targetSpot) : null,
      charges,
      investedAmount: Number((livePremium * qty).toFixed(2)),
      entryReason: String(signal.detail || 'Liquidity OI Chase').slice(0, 200),
      signalSnapshot: {
        status: signal.status,
        detail: signal.detail,
        stopSpot: signal.stopSpot,
        targetSpot: signal.targetSpot,
        oiFuel: signal.oiFuel,
        pool: signal.sweep?.pool,
        atr: signal.swings?.atr,
        securityId: String(securityId),
        exchangeSegment: instrument.exchangeSegment || 'NSE_FNO',
      },
      notes: `liq-chase ${optionType} stop=${signal.stopSpot} tgSpot=${signal.targetSpot}`,
    });

    engineState.openTradeId = String(trade._id);
    engineState.lastSignalKey = signalKey;
    engineState.entryArmed = false;
    engineState.lastEntryDebug = { ok: true, tradeId: String(trade._id), strike, optionType, premium: livePremium };

    pushNotification({
      type: 'ENTRY',
      strategy: NOTIF_STRATEGY,
      title: `Entered ${optionType} ${strike}`,
      body: `${signal.detail} · ₹${livePremium.toFixed(2)}`,
      meta: { tradeId: String(trade._id) },
      dedupeKey: `liq-chase-entry:${trade._id}`,
    });
  } catch (err) {
    engineState.lastError = `Entry: ${err.message}`;
    engineState.lastEntryDebug = { skip: 'exception', error: err.message };
  } finally {
    engineState.enteringTrade = false;
  }
}

async function tickOnce() {
  if (engineState.tickInFlight || !engineState.running) return;
  engineState.tickInFlight = true;
  try {
    await checkOpenTrade();
    // Always refresh live tape (even when paper entries are disabled).
    const signal = await readLatestSignal();
    if (!engineState.settings.enabled) return;
    if (signal) await tryEnter(signal);
  } catch (err) {
    engineState.lastError = err.message;
  } finally {
    engineState.tickInFlight = false;
  }
}

async function markOnce() {
  if (!engineState.running || !engineState.openTradeId) return;
  try {
    await checkOpenTrade();
  } catch {
    /* ignore */
  }
}

async function ensureEngineRunning() {
  if (engineState.running) return { ok: true, already: true };
  await loadSettingsFromDb();
  await recalcWalletFromTrades().catch(() => {});
  const open = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, status: 'OPEN', exitTime: null });
  if (open) engineState.openTradeId = String(open._id);
  engineState.running = true;
  engineState.startedAt = new Date().toISOString();
  engineState.loopTimer = setInterval(() => {
    tickOnce().catch(() => {});
  }, LOOP_MS);
  engineState.markTimer = setInterval(() => {
    markOnce().catch(() => {});
  }, OPEN_MARK_MS);
  tickOnce().catch(() => {});
  return { ok: true, started: true };
}

async function setEnabled(enabled) {
  await ensureEngineRunning();
  const next = await saveSettingsToDb({ enabled: Boolean(enabled) });
  return { ok: true, settings: next, enabled: next.enabled };
}

async function updateSettings(body = {}) {
  await ensureEngineRunning();
  const allowed = Object.keys(DEFAULT_SETTINGS);
  const partial = {};
  for (const k of allowed) {
    if (body[k] !== undefined) partial[k] = body[k];
  }
  const next = await saveSettingsToDb(partial);
  return { ok: true, settings: next };
}

async function getStatus() {
  await ensureEngineRunning();
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  const wallet = await ensureWallet();
  return {
    running: engineState.running,
    startedAt: engineState.startedAt,
    enabled: Boolean(engineState.settings.enabled),
    settings: engineState.settings,
    strategyKey: STRATEGY_KEY,
    strategyId: STRATEGY_ID,
    strategyLabel: 'Liquidity OI Chase · sweep+break · streak/lead/ΔPCR · next-pool target',
    openTrade: open || null,
    signal: engineState.liveSignal,
    lastDecision: engineState.lastDecision,
    lastEntryDebug: engineState.lastEntryDebug,
    lastError: engineState.lastError,
    wallet: {
      walletKey: WALLET_KEY,
      realizedPnl: wallet.realizedPnl,
      balance: wallet.balance,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
  };
}

async function listTrades({ status, page = 1, pageSize = 50 } = {}) {
  await ensureEngineRunning();
  const clock = getIstClock(new Date());
  const filter = { strategyKey: STRATEGY_KEY };
  const statusKey = String(status || 'ALL').toUpperCase();
  if (statusKey === 'OPEN') {
    filter.status = 'OPEN';
    filter.exitTime = null;
  } else if (statusKey === 'CLOSED') {
    filter.$or = [{ status: 'CLOSED' }, { exitTime: { $ne: null } }];
  } else if (statusKey === 'TODAY') {
    filter.$or = [
      { entryDateKey: clock.dateKey },
      { exitDateKey: clock.dateKey },
      { status: 'OPEN', exitTime: null },
    ];
  }
  const lim = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const p = Math.max(1, Number(page) || 1);
  const [rows, total] = await Promise.all([
    LivePaperTrade.find(filter).sort({ entryTime: -1 }).skip((p - 1) * lim).limit(lim).lean(),
    LivePaperTrade.countDocuments(filter),
  ]);
  return {
    trades: rows,
    total,
    page: p,
    pageSize: lim,
    dateKey: clock.dateKey,
    pagination: {
      page: p,
      pageSize: lim,
      totalRows: total,
      totalPages: Math.max(1, Math.ceil(total / lim)),
    },
  };
}

async function getBookSummary() {
  await ensureEngineRunning();
  const wallet = await ensureWallet();
  const clock = getIstClock(new Date());
  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  const live = engineState.liveOpenMark;
  let openMtm = 0;
  for (const t of open) {
    if (live && String(t._id) === String(live.tradeId) && live.mark) {
      t.openPositionMark = live.mark;
      if (Number.isFinite(live.mark.mtm)) openMtm += live.mark.mtm;
    }
  }
  const closedCount = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
  });
  // Keep UI tape fresh even if the loop just started / last tick was delayed.
  if (!engineState.liveSignal || !engineState.liveSignal.checks || !engineState.liveSignal.chart) {
    await readLatestSignal().catch(() => {});
  }
  return {
    settings: engineState.settings,
    enabled: Boolean(engineState.settings.enabled),
    signal: engineState.liveSignal,
    wallet: {
      walletKey: WALLET_KEY,
      realizedPnl: wallet.realizedPnl,
      balance: wallet.balance,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    openTrades: open,
    openMtm: Number(openMtm.toFixed(2)),
    openCount: open.length,
    closedCount,
    dateKey: clock.dateKey,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    entryArmed: engineState.entryArmed,
  };
}

async function closeOpenTradeManual(reason = 'MANUAL_CLOSE') {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) throw new Error('No open trade');
  const mark = await resolveOptionLtp(open);
  return finalizeTrade(open, { exitPremium: mark.optionLtp, mark, reason });
}

module.exports = {
  STRATEGY_KEY,
  WALLET_KEY,
  STRATEGY_ID,
  DEFAULT_SETTINGS,
  ensureEngineRunning,
  getStatus,
  getBookSummary,
  listTrades,
  setEnabled,
  updateSettings,
  closeOpenTradeManual,
  recalcWalletFromTrades,
};

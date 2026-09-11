/**
 * Cover Scalp (OCC) — paper live.
 * Closed 5m Cover → ATM CE/PE. Exits: option +5/−5 · EOD.
 * No flip · 15m pause after SL · day lock +5/−10 option pts.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { OI_COVER_CHASE_LIVE_KEY } = require('../strategies/keys');
const { buildSignalFromOiFlow } = require('../strategies/oiCoverChase/signals');
const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const { round } = require('../utils/oiFlowPlaybook');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getFutureLtp,
} = require('./dhanLiveService');

const STRATEGY_KEY = OI_COVER_CHASE_LIVE_KEY;
const WALLET_KEY = 'paper_live_oi_cover_chase';
const STRATEGY_ID = 'oi-cover-chase';

const LOOP_MS = 5000;
const MIN_HOLD_MS = 8000;
/** After a STOP_LOSS, block new entries for this long. */
const SL_COOLDOWN_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:45',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  stepMin: 5,
  /** Option premium target / stop (strike LTP pts). */
  optionTpPts: 5,
  optionSlPts: 5,
  minSpotDelta: 3,
  /** Flip disabled — kept for settings compatibility only. */
  allowFlip: false,
  minFlipScore: 90,
  minAbsDeltaFlip: 10,
  /** Day option-pts lock (sum of closed favor pts). */
  dailyTarget: 5,
  dailyLoss: 10,
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
  /** Timestamp of last STOP_LOSS exit — used for 15m no-entry cooldown. */
  lastStopLossAtMs: 0,
  entryArmed: true,
  lastEntryKey: null,
  lastEntryBarMinutes: null,
  lastRecipeKey: null,
  lastSignal: null,
  lastTapeAt: null,
  lastError: null,
  lastEntryDebug: null,
  closingTrade: false,
  enteringTrade: false,
  lotSize: null,
  expiry: null,
  dayPtsDateKey: null,
  dayPts: 0,
  dayDone: false,
  dayLockReason: null,
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

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      cashLedger: false,
      oiCoverChaseEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.enabled = true; // always live
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.stepMin = Math.max(5, Math.min(60, Math.floor(Number(s.stepMin) || 5)));
  // Fresh option peanuts (ignore legacy Nifty stopPts / targetPts for defaults)
  s.optionTpPts = Math.max(1, Math.min(80, Number(s.optionTpPts) || 5));
  s.optionSlPts = Math.max(1, Math.min(80, Number(s.optionSlPts) || 5));
  s.minSpotDelta = Math.max(1, Math.min(20, Number(s.minSpotDelta) || 3));
  s.allowFlip = false; // scalp mode — never flip
  s.minFlipScore = Math.max(0, Math.min(100, Number(s.minFlipScore) || 90));
  s.minAbsDeltaFlip = Math.max(0, Math.min(50, Number(s.minAbsDeltaFlip) || 10));
  s.dailyTarget = Math.max(1, Number(s.dailyTarget) || 5);
  s.dailyLoss = Math.max(1, Number(s.dailyLoss) || 10);
  s.perTradeCost = Number.isFinite(Number(s.perTradeCost)) && Number(s.perTradeCost) >= 0 ? Number(s.perTradeCost) : 100;
  s.tradeFromTime = String(s.tradeFromTime || '09:45');
  s.tradeToTime = String(s.tradeToTime || '14:30');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  delete s.stopPts;
  delete s.targetPts;
  delete s.timeStopBars;
  delete s.maxStreak;
  delete s.minStreak;
  delete s.rMult;
  delete s.callMinSpotDelta;
  return s;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.oiCoverChaseEngineSettings || {});
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.oiCoverChaseEngineSettings?.toObject?.() || wallet.oiCoverChaseEngineSettings || {}),
    ...partial,
  });
  wallet.oiCoverChaseEngineSettings = next;
  await wallet.save();
  engineState.settings = next;
  return next;
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
    isTesting: { $ne: true },
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

function favorPtsFromTrade(trade) {
  const snap = trade?.signalSnapshot || {};
  if (Number.isFinite(Number(snap.favorPts))) return Number(snap.favorPts);
  const entryPrem = Number(trade.entryPremium);
  const exitPrem = Number(trade.exitPremium);
  if (Number.isFinite(entryPrem) && Number.isFinite(exitPrem)) {
    return round(exitPrem - entryPrem);
  }
  return 0;
}

async function refreshDayBook(dateKey) {
  if (engineState.dayPtsDateKey !== dateKey) {
    engineState.dayPtsDateKey = dateKey;
    engineState.dayPts = 0;
    engineState.lastEntryBarMinutes = null;
    engineState.lastRecipeKey = null;
    engineState.dayDone = false;
    engineState.dayLockReason = null;
  }

  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
    status: 'CLOSED',
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  })
    .sort({ entryTime: 1 })
    .lean();

  let dayPts = 0;
  let lastBar = null;
  let dayDone = false;
  let dayLockReason = null;
  const dailyTarget = Number(engineState.settings.dailyTarget) || 5;
  const dailyLoss = Number(engineState.settings.dailyLoss) || 10;

  for (const t of closed) {
    const snap = t.signalSnapshot || {};
    if (Number.isFinite(Number(snap.barMinutes))) lastBar = Number(snap.barMinutes);
    let pts = favorPtsFromTrade(t);
    const reason = String(t.reason || '').toUpperCase();
    const risk = Number(snap.riskPts);
    const reward = Number(snap.rewardPts);
    if (reason === 'STOP_LOSS' && Number.isFinite(risk)) pts = -Math.abs(risk);
    if (reason === 'TARGET' && Number.isFinite(reward)) pts = Math.abs(reward);
    dayPts = round(dayPts + pts);
    if (!dayDone && dayPts >= dailyTarget) {
      dayDone = true;
      dayLockReason = `Daily target +${dailyTarget}`;
    } else if (!dayDone && dayPts <= -Math.abs(dailyLoss)) {
      dayDone = true;
      dayLockReason = `Daily loss −${dailyLoss}`;
    }
  }

  engineState.dayPts = dayPts;
  engineState.lastEntryBarMinutes = lastBar;
  engineState.dayDone = dayDone;
  engineState.dayLockReason = dayLockReason;
  return {
    dayPts,
    lastEntryBarMinutes: lastBar,
    lastRecipeKey: engineState.lastRecipeKey,
    dayDone,
    dayLockReason,
  };
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
      Number.isFinite(futSpot) && futSpot > 0
        ? futSpot
        : Number(prem.spot) > 0
          ? Number(prem.spot)
          : Number(prem.chainSpot);
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

async function finalizeTrade(trade, { exitPremium, mark, reason, futFallback = null, favorPts = null }) {
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

    const snap = { ...(trade.signalSnapshot || {}) };
    let pts = favorPts;
    if (!Number.isFinite(pts)) {
      const entryPrem = Number(trade.entryPremium);
      if (Number.isFinite(entryPrem) && Number.isFinite(safeExit)) {
        pts = round(safeExit - entryPrem);
      }
    }
    const r = String(reason || '').toUpperCase();
    if (r === 'STOP_LOSS' && Number.isFinite(Number(snap.riskPts))) pts = -Math.abs(Number(snap.riskPts));
    if (r === 'TARGET' && Number.isFinite(Number(snap.rewardPts))) pts = Math.abs(Number(snap.rewardPts));
    snap.favorPts = Number.isFinite(pts) ? round(pts) : 0;
    snap.exitReason = reason;

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExit.toFixed(2));
    trade.exitSpot = exitSpot != null ? exitSpot : Number(trade.entrySpot) || undefined;
    if (!(Number(trade.exitSpot) > 0)) trade.exitSpot = undefined;
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct = investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.signalSnapshot = snap;
    trade.notes = [trade.notes, `exitMark=${resolved?.source || 'n/a'}; favorPts=${snap.favorPts}; pnl=${trade.pnl}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    await trade.save();

    await recalcWalletFromTrades();
    await refreshDayBook(clock.dateKey);
    engineState.openTradeId = null;
    engineState.lastExitAtMs = Date.now();
    if (String(reason || '').toUpperCase() === 'STOP_LOSS') {
      engineState.lastStopLossAtMs = Date.now();
    }
    // Re-arm unless day locked (tryEnter still respects 15m SL cooldown)
    engineState.entryArmed = !engineState.dayDone;
    return trade;
  } finally {
    engineState.closingTrade = false;
  }
}

async function checkOpenTrade(signal, tape) {
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
  const spotFallback = Number(
    mark.spot
    || signal?.spot
    || tape?.displayRow?.spotPrice
    || open.entrySpot,
  );
  const spotNow = Number.isFinite(spotFallback) ? spotFallback : null;

  if (Number.isFinite(mark.optionLtp) && mark.optionLtp > 0) {
    const entryPrem = Number(open.entryPremium);
    const favor =
      Number.isFinite(entryPrem)
        ? round(Number(mark.optionLtp) - entryPrem)
        : null;
    open.openPositionMark = {
      optionLtp: Number(mark.optionLtp.toFixed(2)),
      spot: Number.isFinite(spotNow) && spotNow > 0 ? spotNow : null,
      favorPts: Number.isFinite(favor) ? favor : null,
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
      futFallback: spotNow,
    });
    return;
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const snap = open.signalSnapshot || {};

  // Flip disabled in scalp mode — hold until option TP/SL or EOD only
  const allowFlip = Boolean(engineState.settings.allowFlip);
  if (allowFlip && signal?.flipOpposite && signal?.status === 'TAKE_ENTRY') {
    const entryPrem = Number(open.entryPremium);
    const ltp = Number(mark.optionLtp);
    let favor = null;
    if (Number.isFinite(ltp) && Number.isFinite(entryPrem)) {
      favor = round(ltp - entryPrem);
    }
    await finalizeTrade(open, {
      exitPremium: mark.optionLtp,
      mark,
      reason: 'FLIP_OPPOSITE',
      futFallback: spotNow,
      favorPts: favor,
    });
    return;
  }

  // Option premium TP / SL on this strike (no Nifty spot SL/TP)
  const entryPrem = Number(open.entryPremium);
  const ltp = Number(mark.optionLtp);
  const slPts = Math.max(
    1,
    Number(snap.riskPts) || Number(engineState.settings.optionSlPts) || 5,
  );
  const tpPts = Math.max(
    1,
    Number(snap.rewardPts) || Number(engineState.settings.optionTpPts) || 5,
  );
  const stopPrem = Number.isFinite(Number(open.stopLossPremium))
    ? Number(open.stopLossPremium)
    : Number.isFinite(entryPrem)
      ? entryPrem - slPts
      : null;
  const targetPrem = Number.isFinite(Number(open.targetPremium))
    ? Number(open.targetPremium)
    : Number.isFinite(entryPrem)
      ? entryPrem + tpPts
      : null;

  if (Number.isFinite(ltp) && ltp > 0 && Number.isFinite(entryPrem)) {
    if (Number.isFinite(stopPrem) && ltp <= stopPrem) {
      await finalizeTrade(open, {
        exitPremium: ltp,
        mark,
        reason: 'STOP_LOSS',
        futFallback: spotNow,
        favorPts: -slPts,
      });
      return;
    }
    if (Number.isFinite(targetPrem) && ltp >= targetPrem) {
      await finalizeTrade(open, {
        exitPremium: ltp,
        mark,
        reason: 'TARGET',
        futFallback: spotNow,
        favorPts: tpPts,
      });
    }
  }
}

async function tryEnter(signal, tape) {
  if (!engineState.settings.enabled) return;
  if (engineState.dayDone) {
    engineState.lastEntryDebug = { skip: 'day_lock', reason: engineState.dayLockReason };
    return;
  }
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (signal?.flipOpposite) return; // ignore legacy flip signals
  if (signal?.status !== 'TAKE_ENTRY' || !signal.buyLive || !signal.optionType) {
    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }
    return;
  }
  if (!engineState.entryArmed) return;

  if (engineState.lastStopLossAtMs > 0) {
    const sinceSlMs = Date.now() - engineState.lastStopLossAtMs;
    if (sinceSlMs < SL_COOLDOWN_MS) {
      const remainSec = Math.ceil((SL_COOLDOWN_MS - sinceSlMs) / 1000);
      engineState.lastEntryDebug = {
        skip: 'sl_cooldown',
        remainSec,
        needSec: Math.floor(SL_COOLDOWN_MS / 1000),
      };
      return;
    }
  }

  const clock = getIstClock(new Date());
  if (isWeekendDateKey(clock.dateKey)) return;
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) {
    return;
  }
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) return;

  const entryKey = `${clock.dateKey}:${signal.barMinutes}:${signal.optionType}`;
  if (engineState.lastEntryKey === entryKey) return;

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
    const strike = Number(signal.entryStrike || tape?.displayRow?.atm || signal.atm);
    const expiry = String(
      tape?.displayRow?.expiry || tape?.expiry || engineState.expiry || (await getNearestWeeklyExpiry(symbol)) || '',
    ).slice(0, 10);
    if (!Number.isFinite(strike) || !expiry) {
      engineState.lastEntryDebug = { skip: 'missing_strike_or_expiry' };
      return;
    }

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
      engineState.lastEntryDebug = { skip: 'no_live_premium', strike, optionType, expiry };
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    engineState.expiry = expiry;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 10);
    const qty = lotSize * lots;
    const charges = Math.max(0, Number(engineState.settings.perTradeCost) || 0);
    const entrySpot = Number(
      signal.entrySpotPlan || signal.entrySpot || signal.spot || tape?.displayRow?.spotPrice,
    );
    const slPts = Math.max(1, Number(signal.riskPts) || Number(engineState.settings.optionSlPts) || 5);
    const tpPts = Math.max(1, Number(signal.rewardPts) || Number(engineState.settings.optionTpPts) || 5);
    const stopLossPremium = Number((entryPremium - slPts).toFixed(2));
    const targetPremium = Number((entryPremium + tpPts).toFixed(2));

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
      entrySpot: Number.isFinite(entrySpot) && entrySpot > 0 ? Number(entrySpot.toFixed(2)) : undefined,
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium,
      targetPremium,
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      combinedStopSpot: null,
      targetSpot: null,
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Cover Scalp ${optionType} · ${signal.barTime || ''} · ${signal.patternName || ''}`,
      notes: `oi_cover_chase; pattern=${signal.patternId}; optionTP=+${tpPts}; optionSL=-${slPts}; recipe=${signal.recipeKey}; entrySrc=${entrySource}`,
      signalSnapshot: {
        patternId: signal.patternId,
        patternName: signal.patternName,
        decision: signal.patternName,
        strength: signal.strength,
        flowBias: signal.flowBias,
        streak: signal.streak,
        deltaPcr: signal.deltaPcr,
        callAct: signal.callAct,
        putAct: signal.putAct,
        act: signal.act,
        spotDelta: signal.spotDelta,
        recipeKey: signal.recipeKey,
        barTime: signal.barTime,
        barMinutes: signal.barMinutes,
        entryMinutes: signal.barMinutes,
        riskPts: slPts,
        rewardPts: tpPts,
        optionSlPts: slPts,
        optionTpPts: tpPts,
        stopLossPremium,
        targetPremium,
        stopSpot: null,
        targetSpot: null,
      },
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.entryArmed = false;
    engineState.lastRecipeKey = signal.recipeKey || null;
    engineState.lastEntryKey = entryKey;
    engineState.lastEntryBarMinutes = Number(signal.barMinutes);
    engineState.lastEntryDebug = {
      at: new Date().toISOString(),
      tradeId: engineState.openTradeId,
      optionType,
      strike,
      entryPremium,
      entrySource,
      optionTpPts: tpPts,
      optionSlPts: slPts,
      signal,
    };
  } catch (err) {
    engineState.lastError = err.message;
    engineState.lastEntryDebug = { skip: 'entry_error', error: err.message };
  } finally {
    engineState.enteringTrade = false;
  }
}

async function fetchTape() {
  const oiFlow = require('./oiFlowMinuteEngine');
  return oiFlow.listTodayRows();
}

async function tickOnce() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    await loadSettingsFromDb();
    const clock = getIstClock(new Date());
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }

    const dayBook = await refreshDayBook(clock.dateKey);
    const tape = await fetchTape();
    engineState.lastTapeAt = tape?.displayRow?.fetchedAt || new Date().toISOString();
    const openOpt = engineState.openTradeId
      ? (await LivePaperTrade.findById(engineState.openTradeId).select('optionType').lean())?.optionType
      : null;
    const signal = buildSignalFromOiFlow(tape, engineState.settings, {
      lastEntryBarMinutes: dayBook.lastEntryBarMinutes ?? engineState.lastEntryBarMinutes,
      lastRecipeKey: engineState.lastRecipeKey,
      dayDone: engineState.dayDone,
      dayLockReason: engineState.dayLockReason,
      openOptionType: openOpt || null,
    });

    if (signal?.clearRecipe) {
      engineState.lastRecipeKey = null;
    }

    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }

    engineState.lastSignal = {
      ...signal,
      at: engineState.lastTapeAt,
      enabled: engineState.settings.enabled,
      entryArmed: engineState.entryArmed,
      dayPts: dayBook.dayPts,
      lastRecipeKey: engineState.lastRecipeKey,
      dayDone: engineState.dayDone,
      dayLockReason: engineState.dayLockReason,
    };

    const hadOpen = Boolean(engineState.openTradeId);
    await checkOpenTrade(signal, tape);
    const closedThisTick = hadOpen && !engineState.openTradeId;
    // After exit, re-arm (same-bar blocked by lastEntryKey; no same-tick flip reverse)
    if (closedThisTick && !engineState.dayDone) {
      engineState.entryArmed = true;
    }

    if (!engineState.openTradeId && !closedThisTick) {
      await tryEnter(signal, tape);
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

async function hydrateLastStopLossCooldown() {
  const lastSl = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'CLOSED',
    reason: 'STOP_LOSS',
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  })
    .sort({ exitTime: -1 })
    .lean();
  if (!lastSl?.exitTime) {
    engineState.lastStopLossAtMs = 0;
    return;
  }
  const ms = new Date(lastSl.exitTime).getTime();
  if (!Number.isFinite(ms)) {
    engineState.lastStopLossAtMs = 0;
    return;
  }
  if (Date.now() - ms < SL_COOLDOWN_MS) {
    engineState.lastStopLossAtMs = ms;
  } else {
    engineState.lastStopLossAtMs = 0;
  }
}

function slCooldownSnapshot() {
  if (!(engineState.lastStopLossAtMs > 0)) {
    return { active: false, remainSec: 0, needSec: Math.floor(SL_COOLDOWN_MS / 1000) };
  }
  const since = Date.now() - engineState.lastStopLossAtMs;
  const remainMs = SL_COOLDOWN_MS - since;
  if (remainMs <= 0) {
    return { active: false, remainSec: 0, needSec: Math.floor(SL_COOLDOWN_MS / 1000) };
  }
  return {
    active: true,
    remainSec: Math.ceil(remainMs / 1000),
    needSec: Math.floor(SL_COOLDOWN_MS / 1000),
  };
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    await loadSettingsFromDb();
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }
    await syncOpenTradeId();
    await recalcWalletFromTrades();
    await hydrateLastStopLossCooldown();
    const bootClock = getIstClock(new Date());
    await refreshDayBook(bootClock.dateKey);
    engineState.running = true;
    engineState.startedAt = new Date();
    engineState.entryArmed = true;
    startLoop();
    tickOnce().catch(() => {});
    console.log('Cover Scalp (OCC) engine started · +5/−5 · no flip · 15m after SL');
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
    wallet: {
      walletKey: WALLET_KEY,
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    dayPts: engineState.dayPts,
    lastRecipeKey: engineState.lastRecipeKey,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    lastTapeAt: engineState.lastTapeAt,
  };
}

async function setEnabled(_enabled) {
  // Always live — ignore off requests
  const settings = await saveSettingsToDb({ enabled: true });
  await ensureEngineRunning();
  return { ok: true, enabled: true, settings };
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
  const clock = getIstClock(new Date());
  const dayBook = await refreshDayBook(clock.dateKey);
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
    openCount: open.length,
    closedCount: wallet.totalTrades,
    openMtm: Number(openMtm.toFixed(2)),
    dayPts: dayBook.dayPts,
    dayDone: dayBook.dayDone,
    dayLockReason: dayBook.dayLockReason,
    slCooldown: slCooldownSnapshot(),
    lastEntryDebug: engineState.lastEntryDebug,
    lastRecipeKey: engineState.lastRecipeKey,
    lastError: engineState.lastError,
  };
}

async function closeOpenTradeManual(reason = 'MANUAL_CLOSE') {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) throw new Error('No open Cover Scalp trade');
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
  buildSignalFromOiFlow,
};

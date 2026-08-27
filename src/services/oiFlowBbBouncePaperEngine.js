/**
 * OI Flow BB Bounce paper — reclaim (always on).
 * Prev bar at BB, this bar closes inside + strong OI ≥ 1L → ATM CE/PE.
 * TP +10 option pts · SL on NIFTY INDEX (IDX_I) 1.5× last 5-min range (min 10 pts).
 * Never mix index BB/SL with NIFTY futures LTP.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const OiFlowOptionTick = require('../models/oiFlowOptionTick');
const { OI_FLOW_BB_BOUNCE_LIVE_KEY } = require('../strategies/keys');
const { getIstClock } = require('../utils/dateTime');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getIndexLtp,
} = require('./dhanLiveService');
const { normalizeRows, buildIndex, bbAt } = require('./oiFlowSignalEngine');
const { decideBbBounce } = require('./oiFlowBbBounceEngine');
const { pushNotification } = require('./notificationHub');

const STRATEGY_KEY = OI_FLOW_BB_BOUNCE_LIVE_KEY;
const NOTIF_STRATEGY = 'OI Flow BB Bounce';
const WALLET_KEY = 'paper_live_oi_flow_bb';
const LOOP_MS = 5000;
/** Open-position LTP/spot mark only — does not change entry rules. */
const OPEN_MARK_MS = 1000;
const TICK_KEEP_MS = 5 * 60 * 1000;
const MIN_HOLD_MS = 15000;
const EXIT_EPS = 0.15;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:30',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  targetPoints: 10,
  slRangeBars: 5,
  slRangeMult: 1.5,
  slMinSpot: 10,
  minOiAbs: 100000,
  maxHoldMinutes: 0,
  cooldownMinutes: 30,
  perTradeCost: 0,
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
  lastSignalMinutes: null,
  lastSignalKey: null,
  /** After entry/exit, stay false until decision returns to WAIT (fresh setup). */
  entryArmed: true,
  lastDecision: null,
  lastError: null,
  lastEntryDebug: null,
  lastTickSavedAt: 0,
  /** Per-trade tick throttle so fast SL/TP moves are not dropped. */
  lastTickByTradeId: {},
  /** Latest open mark in RAM so the book API is not stuck on a stale Mongo row. */
  liveOpenMark: null,
  closingTrade: false,
  enteringTrade: false,
  lotSize: null,
  expiry: null,
};

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

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // Engine always runs — ignore stored false from older wallets.
  s.enabled = true;
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.targetPoints = Math.max(1, Number(s.targetPoints) || 10);
  const holdRaw = Number(s.maxHoldMinutes);
  s.maxHoldMinutes = Number.isFinite(holdRaw)
    ? Math.max(0, Math.min(240, Math.floor(holdRaw)))
    : 0;
  s.slRangeBars = Math.max(2, Math.min(30, Math.floor(Number(s.slRangeBars) || 5)));
  s.slRangeMult = Math.max(0.5, Math.min(4, Number(s.slRangeMult) || 1.5));
  s.slMinSpot = Math.max(4, Number(s.slMinSpot) || 10);
  s.minOiAbs = Math.max(10000, Number(s.minOiAbs) || 100000);
  s.cooldownMinutes = Math.max(5, Math.floor(Number(s.cooldownMinutes) || 30));
  s.perTradeCost = Math.max(0, Number(s.perTradeCost) || 0);
  s.tradeFromTime = String(s.tradeFromTime || '09:30');
  s.tradeToTime = String(s.tradeToTime || '14:30');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  return s;
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      oiFlowBbBounceEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  const raw =
    wallet.oiFlowBbBounceEngineSettings?.toObject?.() || wallet.oiFlowBbBounceEngineSettings || {};
  engineState.settings = normalizeSettings(raw);
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.oiFlowBbBounceEngineSettings?.toObject?.() || wallet.oiFlowBbBounceEngineSettings || {}),
    ...partial,
  });
  wallet.oiFlowBbBounceEngineSettings = next;
  await wallet.save();
  engineState.settings = next;
  return next;
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

function isIndexSpotSource(source) {
  return String(source || '').startsWith('index');
}

function indexSpotSlHit(optionType, liveSpot, slSpot) {
  const sl = Number(slSpot);
  const spot = Number(liveSpot);
  if (!Number.isFinite(sl) || !Number.isFinite(spot) || spot <= 0) return false;
  return String(optionType || '').toUpperCase() === 'PE' ? spot >= sl : spot <= sl;
}

/** Exits must use fresh quotes — not the UI hold buffer. */
function pickExitMark(liveMark, displayMark) {
  if (Number.isFinite(liveMark?.optionLtp) && liveMark.optionLtp > 0) return liveMark;
  return displayMark;
}

async function resolveIndexSpotForSl(trade, mark) {
  const fromMark = Number(mark?.spot);
  if (Number.isFinite(fromMark) && fromMark > 0) return fromMark;
  try {
    const idx = await getIndexLtp({ symbol: trade.symbol, maxWaitMs: 500, forceFresh: false });
    if (Number.isFinite(idx?.ltp) && idx.ltp > 0) return idx.ltp;
  } catch {
    /* optional */
  }
  return null;
}

async function resolveOptionLtp(trade, { forceFresh = false, maxWaitMs = 800 } = {}) {
  const optionType = String(trade.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
  let indexSpot = null;
  let securityId = null;

  const idxP = getIndexLtp({
    symbol: trade.symbol,
    maxWaitMs: Math.min(600, maxWaitMs),
    forceFresh: false,
  })
    .then((idx) => {
      if (Number.isFinite(idx?.ltp) && idx.ltp > 0) indexSpot = idx.ltp;
    })
    .catch(() => {});

  let optionLtp = null;
  const optP = (async () => {
    try {
      const inst = await resolveOptionInstrument({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
        optionType,
      });
      if (!inst) return;
      securityId = inst.securityId || inst.SecurityId || null;
      const ltp = await fetchInstrumentLtp(inst, { maxWaitMs, forceFresh });
      if (Number.isFinite(ltp) && ltp > 0) optionLtp = ltp;
    } catch {
      /* fall through to chain */
    }
  })();

  await Promise.all([idxP, optP]);
  if (Number.isFinite(optionLtp) && optionLtp > 0) {
    return {
      optionLtp,
      spot: indexSpot,
      source: Number.isFinite(indexSpot) ? 'index-feed' : 'marketfeed',
      securityId,
    };
  }
  try {
    const prem = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const ltp = optionType === 'PE' ? Number(prem.peLtp) : Number(prem.ceLtp);
    const chainSpot = Number(prem.spot) > 0 ? Number(prem.spot) : Number(prem.chainSpot);
    const spot = Number.isFinite(indexSpot) && indexSpot > 0 ? indexSpot : chainSpot;
    if (Number.isFinite(ltp) && ltp > 0) {
      return {
        optionLtp: ltp,
        spot: Number.isFinite(spot) && spot > 0 ? spot : null,
        source: Number.isFinite(indexSpot) ? 'index-feed' : 'index-chain',
        securityId,
      };
    }
  } catch {
    /* fall through */
  }
  return { optionLtp: null, spot: indexSpot, source: 'none', securityId };
}

function isLiveQuoteSource(source) {
  const s = String(source || '');
  return s !== 'none' && !s.endsWith('_hold') && s !== 'marketfeed_buffer';
}

async function saveOptionTick(trade, mark) {
  if (!trade?._id || !Number.isFinite(mark?.optionLtp) || mark.optionLtp <= 0) return;
  const now = Date.now();
  const tradeKey = String(trade._id);
  const lastAt = engineState.lastTickByTradeId[tradeKey] || 0;
  if (now - lastAt < 1000) return;
  engineState.lastTickByTradeId[tradeKey] = now;
  const clock = getIstClock(new Date());
  const at = new Date();
  await OiFlowOptionTick.create({
    tradeId: trade._id,
    strategyKey: STRATEGY_KEY,
    symbol: trade.symbol,
    optionType: trade.optionType,
    strike: trade.strike,
    expiryDate: trade.expiryDate,
    securityId: mark.securityId || null,
    ltp: Number(mark.optionLtp.toFixed(2)),
    spot: Number.isFinite(mark.spot) ? mark.spot : null,
    source: mark.source || null,
    at,
    dateKey: clock.dateKey,
  });
  const cutoff = new Date(Date.now() - TICK_KEEP_MS);
  await OiFlowOptionTick.deleteMany({ tradeId: trade._id, at: { $lt: cutoff } });
}

async function loadRecentTicks(tradeId) {
  const cutoff = new Date(Date.now() - TICK_KEEP_MS);
  return OiFlowOptionTick.find({ tradeId, at: { $gte: cutoff } })
    .sort({ at: 1 })
    .lean();
}

/** If buffer already crossed SL/TP, return fair fill from first breach. */
function findBufferedExit(ticks, trade) {
  const sl = Number(trade.stopLossPremium);
  const tp = Number(trade.targetPremium);
  const slSpot = Number(trade.combinedStopSpot);
  const entryMs = new Date(trade.entryTime).getTime();
  for (const t of ticks) {
    const atMs = new Date(t.at).getTime();
    if (Number.isFinite(entryMs) && atMs <= entryMs + 400) continue;
    const ltp = Number(t.ltp);
    const spot = Number(t.spot);
    if (
      Number.isFinite(slSpot) &&
      Number.isFinite(spot) &&
      spot > 0 &&
      indexSpotSlHit(trade.optionType, spot, slSpot)
    ) {
      if (Number.isFinite(ltp) && ltp > 0) {
        return {
          reason: 'STOP_LOSS',
          exitPremium: ltp,
          at: t.at,
          spot,
          source: 'buffer',
        };
      }
    }
    if (!Number.isFinite(ltp) || ltp <= 0) continue;
    if (Number.isFinite(sl) && sl > 0 && ltp <= sl - EXIT_EPS) {
      return {
        reason: 'STOP_LOSS',
        exitPremium: Math.min(ltp, sl),
        at: t.at,
        spot: t.spot,
        source: 'buffer',
      };
    }
    if (Number.isFinite(tp) && ltp >= tp + EXIT_EPS) {
      return {
        reason: 'TARGET',
        exitPremium: Math.max(ltp, tp),
        at: t.at,
        spot: t.spot,
        source: 'buffer',
      };
    }
  }
  return null;
}

function pickExitSpot(mark, trade, futFallback = null) {
  for (const raw of [mark?.spot, futFallback, trade?.entrySpot, trade?.openPositionMark?.spot]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Number(n.toFixed(2));
  }
  return null;
}

function tradeQty(trade) {
  const q = Number(trade?.qty);
  if (Number.isFinite(q) && q > 0) return q;
  const lots = Number(trade?.lots) || 0;
  const lotSize = Number(trade?.lotSize) || 0;
  const product = lots * lotSize;
  return product > 0 ? product : 0;
}

function computeOpenMtm(trade, optionLtp) {
  const entry = Number(trade?.entryPremium);
  const mark = Number(optionLtp);
  const qty = tradeQty(trade);
  if (!Number.isFinite(entry) || !Number.isFinite(mark) || mark <= 0 || qty <= 0) return null;
  return Number((mark - entry) * qty - (Number(trade.charges) || 0));
}

function shouldUpdateOpenMark(prevMark, prevAt, nextMark) {
  if (!Number.isFinite(nextMark?.optionLtp) || nextMark.optionLtp <= 0) return false;
  if (nextMark.source === 'marketfeed') {
    if (
      prevMark &&
      Number(prevMark.optionLtp) === Number(nextMark.optionLtp) &&
      Number(prevMark.spot || 0) === Number(nextMark.spot || 0)
    ) {
      return false;
    }
    return true;
  }
  if (!prevMark || !Number.isFinite(prevMark.optionLtp) || prevMark.optionLtp <= 0) return true;
  // Don't let a stale chain print overwrite a fresh marketfeed mark.
  if (String(prevMark.source || '').startsWith('marketfeed')) {
    const ageMs = prevAt ? Date.now() - new Date(prevAt).getTime() : Infinity;
    if (ageMs < 8000) return false;
  }
  return nextMark.source === 'chain';
}

async function resolveDisplayMark(trade, liveMark) {
  if (liveMark?.source === 'marketfeed' && Number.isFinite(liveMark.optionLtp) && liveMark.optionLtp > 0) {
    return liveMark;
  }
  const prev = trade.openPositionMark;
  if (
    prev &&
    String(prev.source || '').startsWith('marketfeed') &&
    Number.isFinite(prev.optionLtp) &&
    prev.optionLtp > 0
  ) {
    const ageMs = trade.openPositionMarkAt
      ? Date.now() - new Date(trade.openPositionMarkAt).getTime()
      : Infinity;
    if (ageMs < 8000) {
      return {
        optionLtp: Number(prev.optionLtp),
        spot: Number.isFinite(liveMark?.spot) ? liveMark.spot : prev.spot,
        source: 'marketfeed_hold',
        securityId: liveMark?.securityId || prev.securityId,
      };
    }
  }
  // Prefer last marketfeed tick in the 5m buffer over a fresh chain print.
  try {
    const ticks = await loadRecentTicks(trade._id);
    for (let i = ticks.length - 1; i >= 0; i -= 1) {
      const t = ticks[i];
      if (String(t.source || '').startsWith('marketfeed') && Number(t.ltp) > 0) {
        return {
          optionLtp: Number(t.ltp),
          spot: t.spot,
          source: 'marketfeed_buffer',
          securityId: t.securityId || liveMark?.securityId,
        };
      }
    }
  } catch {
    /* optional */
  }
  return liveMark;
}

async function finalizeTrade(trade, { exitPremium, mark, reason, futFallback = null, exitAt = null }) {
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
    const qty = tradeQty(trade) || Number(trade.qty) || 0;
    const invested = (Number(trade.entryPremium) || 0) * qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const finalValue = safeExit * qty;
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());

    const exitSpot = pickExitSpot(resolved, trade, futFallback);
    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExit.toFixed(2));
    trade.exitSpot = exitSpot != null ? exitSpot : Number(trade.entrySpot) || undefined;
    if (!(Number(trade.exitSpot) > 0)) trade.exitSpot = undefined;
    trade.exitTime = exitAt ? new Date(exitAt) : new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct =
      investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.notes = [
      trade.notes,
      `exitMark=${resolved?.source || 'n/a'}; fair=${mark?.source || 'live'}; pnl=${trade.pnl}`,
    ]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    await trade.save();
    await saveOptionTick(trade, {
      optionLtp: safeExit,
      spot: exitSpot,
      source: resolved?.source || 'exit',
      securityId: resolved?.securityId,
    });
    try {
      /* BB bounce has its own book — do not write Tracker live signals */
    } catch {
      /* signal history must not block exit */
    }

    await recalcWalletFromTrades();
    engineState.openTradeId = null;
    delete engineState.lastTickByTradeId[String(trade._id)];
    engineState.lastExitAtMs = Date.now();
    // Do not re-enter on the same ongoing signal — wait until decision goes WAIT.
    engineState.entryArmed = false;

    pushNotification({
      type: 'EXIT',
      strategy: NOTIF_STRATEGY,
      title: `Closed ${trade.optionType || ''} ${trade.strike || ''}`.trim(),
      body: `${reason} · P/L ₹${Number(pnl.toFixed(2))} · exit ₹${Number(safeExit.toFixed(2))}`,
      meta: { tradeId: String(trade._id), reason, pnl },
      dedupeKey: `oi-flow-bb-exit:${trade._id}`,
    });

    return trade;
  } finally {
    engineState.closingTrade = false;
  }
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
  engineState.lastExitAtMs = new Date(last.exitTime).getTime();
  return (Date.now() - engineState.lastExitAtMs) / 1000;
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
  const liveMark = await resolveOptionLtp(open);
  const displayMark = await resolveDisplayMark(open, liveMark);

  // Screen overlay may hold stale marks; SL/TP use fresh live quotes (same as OI Wall Scalp).
  const uiMark =
    Number.isFinite(liveMark?.optionLtp) && liveMark.optionLtp > 0 ? liveMark : displayMark;
  const exitMark = pickExitMark(liveMark, displayMark);
  if (Number.isFinite(uiMark?.optionLtp) && uiMark.optionLtp > 0) {
    const mtm = computeOpenMtm(open, uiMark.optionLtp);
    engineState.liveOpenMark = {
      tradeId: String(open._id),
      mark: {
        optionLtp: Number(Number(uiMark.optionLtp).toFixed(2)),
        spot: Number.isFinite(uiMark.spot) && uiMark.spot > 0 ? Number(Number(uiMark.spot).toFixed(2)) : null,
        source: uiMark.source,
        at: new Date().toISOString(),
        mtm: mtm != null ? Number(mtm.toFixed(2)) : null,
        qty: tradeQty(open),
        pts: Number.isFinite(Number(open.entryPremium))
          ? Number((Number(uiMark.optionLtp) - Number(open.entryPremium)).toFixed(2))
          : null,
        slSpot: Number.isFinite(Number(open.combinedStopSpot))
          ? Number(open.combinedStopSpot)
          : Number(open.signalSnapshot?.slSpot) || null,
        targetPremium: Number.isFinite(Number(open.targetPremium)) ? Number(open.targetPremium) : null,
      },
    };
  }

  if (shouldUpdateOpenMark(open.openPositionMark, open.openPositionMarkAt, displayMark)) {
    const mtm = computeOpenMtm(open, displayMark.optionLtp);
    open.openPositionMark = {
      optionLtp: Number(Number(displayMark.optionLtp).toFixed(2)),
      spot:
        Number.isFinite(displayMark.spot) && displayMark.spot > 0
          ? Number(Number(displayMark.spot).toFixed(2))
          : null,
      source: displayMark.source,
      at: new Date().toISOString(),
      mtm: mtm != null ? Number(mtm.toFixed(2)) : null,
      qty: tradeQty(open),
      pts: Number.isFinite(Number(open.entryPremium))
        ? Number((Number(displayMark.optionLtp) - Number(open.entryPremium)).toFixed(2))
        : null,
      slSpot: Number.isFinite(Number(open.combinedStopSpot))
        ? Number(open.combinedStopSpot)
        : Number(open.signalSnapshot?.slSpot) || null,
      targetPremium: Number.isFinite(Number(open.targetPremium)) ? Number(open.targetPremium) : null,
    };
    open.openPositionMarkAt = new Date();
    await open.save();
  }
  if (Number.isFinite(liveMark.optionLtp) && liveMark.optionLtp > 0 && isLiveQuoteSource(liveMark.source)) {
    await saveOptionTick(open, liveMark);
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const ticks = await loadRecentTicks(open._id);
  const buffered = findBufferedExit(ticks, open);
  if (buffered) {
    await finalizeTrade(open, {
      exitPremium: buffered.exitPremium,
      mark: { optionLtp: buffered.exitPremium, spot: buffered.spot, source: 'buffer' },
      reason: buffered.reason,
      exitAt: buffered.at,
      futFallback: buffered.spot,
    });
    return;
  }

  if (isEod(clock.minutes, engineState.settings.eodExitTime)) {
    await finalizeTrade(open, {
      exitPremium: exitMark.optionLtp,
      mark: exitMark,
      reason: 'DAY_CLOSE',
    });
    return;
  }

  const optionLtp = Number(exitMark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;
  // Only defer when we truly lack a live feed and must rely on chain.
  if (
    exitMark === displayMark &&
    (displayMark.source === 'chain' || displayMark.source === 'index-chain') &&
    heldMs < MIN_HOLD_MS * 2
  ) {
    return;
  }

  if (open.stopLossPremium != null && optionLtp <= Number(open.stopLossPremium) - EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: Math.min(optionLtp, Number(open.stopLossPremium)),
      mark: exitMark,
      reason: 'STOP_LOSS',
    });
    return;
  }
  const slSpot = Number(open.combinedStopSpot);
  const liveSpot = await resolveIndexSpotForSl(open, exitMark);
  if (
    Number.isFinite(slSpot) &&
    Number.isFinite(liveSpot) &&
    liveSpot > 0 &&
    indexSpotSlHit(open.optionType, liveSpot, slSpot)
  ) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark: { ...exitMark, spot: liveSpot },
      reason: 'STOP_LOSS',
    });
    return;
  }
  if (open.targetPremium != null && optionLtp >= Number(open.targetPremium) + EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: Math.max(optionLtp, Number(open.targetPremium)),
      mark: exitMark,
      reason: 'TARGET',
    });
    return;
  }
  const targetPts = Number(engineState.settings.targetPoints) || 10;
  const entry = Number(open.entryPremium);
  if (Number.isFinite(entry) && optionLtp >= entry + targetPts - EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark: exitMark,
      reason: 'TARGET',
    });
    return;
  }

  const maxHoldMin = Number(engineState.settings.maxHoldMinutes) || 0;
  if (maxHoldMin > 0 && heldMs >= maxHoldMin * 60 * 1000) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark: exitMark,
      reason: 'TIME_EXIT',
    });
  }
}

function slRangePts(rows, entryIdx) {
  const n = Math.max(2, Number(engineState.settings.slRangeBars) || 5);
  const mult = Number(engineState.settings.slRangeMult) || 1.5;
  const minPts = Number(engineState.settings.slMinSpot) || 10;
  let hi = -Infinity;
  let lo = Infinity;
  const end = Math.max(0, entryIdx - 1);
  const from = Math.max(0, end - n + 1);
  for (let k = from; k <= end; k += 1) {
    const s = Number(rows[k]?.spot);
    if (!Number.isFinite(s)) continue;
    if (s > hi) hi = s;
    if (s < lo) lo = s;
  }
  const range = Number.isFinite(hi) && Number.isFinite(lo) ? hi - lo : minPts;
  return Math.max(minPts, range * mult);
}

function liveSlSpot(rows, entryIdx, entrySpot, side) {
  const r = slRangePts(rows, entryIdx);
  return side === 'PE' ? entrySpot + r : entrySpot - r;
}

async function readLatestSignal() {
  const clock = getIstClock(new Date());
  const raw = await OiFlowMinuteRow.find({
    symbol: engineState.settings.symbol || 'NIFTY',
    dateKey: clock.dateKey,
  })
    .sort({ minutes: 1 })
    .lean();
  const rows = normalizeRows(raw);
  if (rows.length < 3) return null;
  const ctx = buildIndex(rows);
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const ctxPrev = buildIndex(rows.slice(0, rows.length - 1));
  const prevBb = prev ? bbAt(ctxPrev, prev.minutes) : null;
  const decision = decideBbBounce(ctx, last.minutes, prevBb, {
    minOiAbs: engineState.settings.minOiAbs,
  });
  engineState.lastDecision = decision;
  if (!decision || decision.decision === 'WAIT') {
    engineState.entryArmed = true;
    return null;
  }
  if (decision.decision !== 'CALL BUY' && decision.decision !== 'PUT BUY') {
    return null;
  }
  const optionType = decision.decision === 'PUT BUY' ? 'PE' : 'CE';
  decision.slRangePts = slRangePts(rows, rows.length - 1);
  decision.slSpot = liveSlSpot(rows, rows.length - 1, Number(last.spot), optionType);
  decision.prevTime = prev?.time || null;
  return decision;
}

async function tryEnter(signal) {
  // Always-on engine — enabled is forced true in normalizeSettings.
  if (!signal || engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) {
    return;
  }
  if (!engineState.entryArmed) {
    engineState.lastEntryDebug = {
      skip: 'waiting_rearm',
      hint: 'need WAIT then new signal after prior entry/exit',
      lastSignalMinutes: engineState.lastSignalMinutes,
    };
    return;
  }

  const clock = getIstClock(new Date());
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) {
    return;
  }
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) return;

  const signalKey = `${clock.dateKey}:${signal.minutes}:${signal.decision}`;
  if (engineState.lastSignalKey === signalKey) {
    engineState.lastEntryDebug = { skip: 'same_signal', signalKey };
    return;
  }
  if (
    engineState.lastSignalMinutes != null &&
    Number(signal.minutes) <= Number(engineState.lastSignalMinutes)
  ) {
    engineState.lastEntryDebug = {
      skip: 'stale_signal_bar',
      signalMinutes: signal.minutes,
      last: engineState.lastSignalMinutes,
    };
    return;
  }

  const cooldownSec = Math.max(60, (Number(engineState.settings.cooldownMinutes) || 30) * 60);
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
    const optionType = signal.decision === 'PUT BUY' ? 'PE' : 'CE';
    const expiry = String(
      engineState.expiry || (await getNearestWeeklyExpiry(symbol)) || '',
    ).slice(0, 10);

    let strike = null;
    let entrySpot = Number(signal.spot);
    let liveIndex = null;
    try {
      const idx = await getIndexLtp({ symbol, maxWaitMs: 800, forceFresh: true });
      if (Number.isFinite(idx?.ltp) && idx.ltp > 0) {
        liveIndex = idx.ltp;
        entrySpot = liveIndex;
      }
    } catch {
      /* chain / 1-min bar fallback — still index, never futures */
    }
    try {
      const prem = await getAtmPremiums({ symbol, expiry });
      if (Number.isFinite(prem?.atm)) strike = prem.atm;
      if (liveIndex == null && Number.isFinite(prem?.spot) && prem.spot > 0) {
        entrySpot = prem.spot;
      }
    } catch {
      /* optional */
    }
    if (!Number.isFinite(strike) && Number.isFinite(entrySpot)) {
      strike = Math.round(entrySpot / 50) * 50;
    }
    if (!Number.isFinite(strike) || !expiry) {
      engineState.lastEntryDebug = { skip: 'missing_strike_or_expiry' };
      return;
    }

    let entryPremium = null;
    let entrySource = 'none';
    let securityId = null;
    try {
      const inst = await resolveOptionInstrument({ symbol, strike, expiry, optionType });
      if (inst) {
        securityId = inst.securityId || inst.SecurityId || null;
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
      };
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    engineState.expiry = expiry;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 10);
    const qty = lotSize * lots;
    const charges = Math.max(0, Number(engineState.settings.perTradeCost) || 0);
    const targetPoints = Number(engineState.settings.targetPoints) || 10;
    const maxHoldMinutes = Number(engineState.settings.maxHoldMinutes) || 0;
    const minOiAbs = Number(engineState.settings.minOiAbs) || 100000;
    const targetPremium = entryPremium + targetPoints;
    const rangePts = Number.isFinite(Number(signal.slRangePts)) && Number(signal.slRangePts) > 0
      ? Number(signal.slRangePts)
      : Math.abs(Number(signal.slSpot) - Number(signal.spot));
    if (indexSpotSlHit(optionType, entrySpot, signal.slSpot)) {
      engineState.lastEntryDebug = {
        skip: 'already_through_index_sl',
        entrySpot,
        signalSl: signal.slSpot,
        liveIndex,
        rangePts,
      };
      return;
    }
    const slSpot = Number.isFinite(rangePts) && rangePts > 0
      ? optionType === 'PE'
        ? entrySpot + rangePts
        : entrySpot - rangePts
      : Number(signal.slSpot);
    const stopLossPremium = null;

    const signalSnapshot = {
      decision: signal.decision,
      matchedRule: signal.matchedRule || signal.reason,
      rules: [
        'Prev 1-min at BB, this 1-min closes back inside + strong OI ≥ 1L',
        'CALL: green + long build/writing or long build/long unwind → ATM CE',
        'PUT: red + writing/buying or long unwind/buying → ATM PE',
        `SL = NIFTY INDEX (not futures) ${engineState.settings.slRangeMult}× last ${engineState.settings.slRangeBars}m range (min ${engineState.settings.slMinSpot} pts)`,
        `TP +${targetPoints} option pts · cooldown ${engineState.settings.cooldownMinutes}m · no 15m time cut`,
      ],
      reason: signal.reason || null,
      time: signal.time,
      minutes: signal.minutes,
      prevTime: signal.prevTime || null,
      spot: signal.spot,
      candle: signal.candle,
      bbZone: signal.bb?.zone,
      bbLower: signal.bb?.lower,
      bbMid: signal.bb?.mid,
      bbUpper: signal.bb?.upper,
      putAct: signal.putAct,
      callAct: signal.callAct,
      putChg: signal.putChg,
      putChgL: signal.putChgL,
      callChg: signal.callChg,
      callChgL: signal.callChgL,
      minOiAbs,
      targetPoints,
      slSpot,
      slOn: `NIFTY index ${engineState.settings.slRangeMult}× ${engineState.settings.slRangeBars}m range`,
      maxHoldMinutes,
      lots,
      lotSize,
      qty,
      optionType,
      strike,
      expiry,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySource,
      tradeWindow: `${engineState.settings.tradeFromTime}–${engineState.settings.tradeToTime}`,
    };

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
      entrySpot: Number.isFinite(entrySpot) ? Number(entrySpot.toFixed(2)) : Number(entryPremium.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      stopLossPremium: null,
      targetPremium: Number(targetPremium.toFixed(2)),
      combinedStopSpot: Number.isFinite(slSpot) ? Number(slSpot.toFixed(2)) : null,
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      status: 'OPEN',
      entryReason: `${signal.decision} · ${signal.pair || ''} · ${signal.time}`,
      investedAmount: Number((entryPremium * qty + charges).toFixed(2)),
      capitalLocked: Number((entryPremium * qty + charges).toFixed(2)),
      charges,
      notes: `entryMark=${entrySource}; signal=${signal.time}; slSpot=${slSpot}; slOn=NIFTY-index; liveIndex=${liveIndex ?? 'n/a'}`,
      signalSnapshot,
      openPositionMark: {
        optionLtp: Number(entryPremium.toFixed(2)),
        spot: Number.isFinite(entrySpot) ? Number(entrySpot.toFixed(2)) : null,
        source: liveIndex != null ? 'index-feed' : 'index-chain',
        at: new Date().toISOString(),
        mtm: 0,
        qty,
        pts: 0,
      },
      openPositionMarkAt: new Date(),
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.lastSignalKey = signalKey;
    engineState.lastSignalMinutes = signal.minutes;
    engineState.entryArmed = false;
    engineState.lastEntryDebug = {
      ok: true,
      tradeId: engineState.openTradeId,
      optionType,
      strike,
      entryPremium,
      entrySource,
    };

    try {
      /* keep BB fills off the Tracker live-signal table */
    } catch {
      /* signal history must not block the fill */
    }

    pushNotification({
      type: 'ENTRY',
      strategy: NOTIF_STRATEGY,
      title: `Entered ${optionType} ${strike}`,
      body: `${signal.decision || ''} · ${signal.pair || ''} · ₹${Number(entryPremium.toFixed(2))} · ${signal.time || ''}`.trim(),
      meta: { tradeId: String(tradeDoc._id), optionType, strike, symbol },
      dedupeKey: `oi-flow-bb-entry:${tradeDoc._id}`,
    });

    await saveOptionTick(tradeDoc, {
      optionLtp: entryPremium,
      spot: entrySpot,
      source: liveIndex != null ? 'index-feed' : 'index-chain',
      securityId,
    });
  } finally {
    engineState.enteringTrade = false;
  }
}

async function tickOnce() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    await loadSettingsFromDb();
    if (engineState.settings.enabled !== true) {
      await saveSettingsToDb({ enabled: true });
    }
    await checkOpenTrade();
    if (engineState.openTradeId) return;
    const signal = await readLatestSignal();
    if (signal) await tryEnter(signal);
  } catch (err) {
    engineState.lastError = err?.message || String(err);
  } finally {
    engineState.tickInFlight = false;
  }
}

/** Fast open-mark refresh. Same SL/TP checks as the 5s loop; no new entries. */
async function markOnce() {
  if (!engineState.openTradeId || engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    await checkOpenTrade();
  } catch (err) {
    engineState.lastError = err?.message || String(err);
  } finally {
    engineState.tickInFlight = false;
  }
}

async function hydrateEntryGateFromDb() {
  const clock = getIstClock(new Date());
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  if (open) {
    engineState.openTradeId = String(open._id);
    engineState.entryArmed = false;
    const snapMin = Number(open.signalSnapshot?.minutes);
    if (Number.isFinite(snapMin)) engineState.lastSignalMinutes = snapMin;
    return;
  }
  const last = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  })
    .sort({ entryTime: -1 })
    .lean();
  if (last) {
    engineState.entryArmed = false; // require WAIT before next entry today
    const snapMin = Number(last.signalSnapshot?.minutes);
    if (Number.isFinite(snapMin)) engineState.lastSignalMinutes = snapMin;
    if (last.exitTime) engineState.lastExitAtMs = new Date(last.exitTime).getTime();
  } else {
    engineState.entryArmed = true;
  }
}

async function ensureEngineRunning() {
  if (engineState.running) return { ok: true, already: true };
  await loadSettingsFromDb();
  await hydrateEntryGateFromDb();
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

async function setEnabled(_enabled) {
  await ensureEngineRunning();
  // Always-on — ignore disable requests from older clients.
  const next = await saveSettingsToDb({ enabled: true });
  return { ok: true, settings: next, enabled: true };
}

async function updateSettings(body = {}) {
  await ensureEngineRunning();
  const allowed = [
    'enabled',
    'symbol',
    'lotCount',
    'tradeFromTime',
    'tradeToTime',
    'eodExitTime',
    'targetPoints',
    'slRangeBars',
    'slRangeMult',
    'slMinSpot',
    'minOiAbs',
    'maxHoldMinutes',
    'cooldownMinutes',
    'perTradeCost',
  ];
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
    strategyLabel: 'BB Bounce · reclaim · OI≥1L · index SL 1.5×5m · TP+10',
    openTrade: open || null,
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
  const skip = (p - 1) * lim;
  const sort = statusKey === 'CLOSED' ? { exitTime: -1, entryTime: -1 } : { entryTime: -1 };
  const [rows, total] = await Promise.all([
    LivePaperTrade.find(filter).sort(sort).skip(skip).limit(lim).lean(),
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
  const wallet = await ensureWallet();
  const clock = getIstClock(new Date());
  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  const closedToday = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitDateKey: clock.dateKey }, { entryDateKey: clock.dateKey, status: 'CLOSED' }],
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .limit(100)
    .lean();

  const live = engineState.liveOpenMark;
  for (const t of open) {
    if (live && String(t._id) === String(live.tradeId) && live.mark) {
      t.openPositionMark = live.mark;
      t.openPositionMarkAt = live.mark.at;
    }
  }

  let openMtm = 0;
  for (const t of open) {
    const markLtp = Number(t.openPositionMark?.optionLtp);
    const mtmStored = Number(t.openPositionMark?.mtm);
    if (Number.isFinite(mtmStored)) {
      openMtm += mtmStored;
    } else if (Number.isFinite(markLtp) && Number.isFinite(t.entryPremium)) {
      const m = computeOpenMtm(t, markLtp);
      if (m != null) openMtm += m;
    }
  }

  return {
    settings: engineState.settings,
    enabled: Boolean(engineState.settings.enabled),
    strategyLabel: 'BB Bounce · reclaim · OI≥1L · index SL 1.5×5m · TP+10',
    decision: engineState.lastDecision,
    entryArmed: Boolean(engineState.entryArmed),
    wallet: {
      walletKey: WALLET_KEY,
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    openTrades: open,
    closedTrades: closedToday,
    openCount: open.length,
    closedCount: closedToday.length,
    openMtm: Number(openMtm.toFixed(2)),
    dateKey: clock.dateKey,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
  };
}

async function closeOpenTradeManual(_reason = 'MANUAL_CLOSE') {
  throw new Error('Manual close disabled — BB Bounce exits only on Target / NIFTY index SL / Day close');
}

module.exports = {
  ensureEngineRunning,
  setEnabled,
  updateSettings,
  getStatus,
  listTrades,
  getBookSummary,
  closeOpenTradeManual,
  DEFAULT_SETTINGS,
  STRATEGY_KEY,
  WALLET_KEY,
};

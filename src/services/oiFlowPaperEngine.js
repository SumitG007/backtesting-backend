/**
 * OI Flow Tracker paper engine — ROBUST B (always on).
 * Put buying ≥2.5L + spot↓ → LONG PE · Put writing ≥2.5L + spot↑ → LONG CE
 * Skip Put ΔOI > 30L · TP+10 / SL−8 · max hold 15m · cooldown 30m · 10 lots
 * Auto entry/exit only — no manual start/stop/close required.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const OiFlowOptionTick = require('../models/oiFlowOptionTick');
const { OI_FLOW_TRACKER_LIVE_KEY } = require('../strategies/keys');
const { getIstClock } = require('../utils/dateTime');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getFutureLtp,
} = require('./dhanLiveService');
const {
  decideRaw,
  normalizeRows,
  buildIndex,
} = require('./oiFlowSignalEngine');

const STRATEGY_KEY = OI_FLOW_TRACKER_LIVE_KEY;
const WALLET_KEY = 'paper_live_oi_flow';
const LOOP_MS = 5000;
const TICK_KEEP_MS = 5 * 60 * 1000;
const MIN_HOLD_MS = 15000;
const EXIT_EPS = 0.15;

const DEFAULT_SETTINGS = {
  enabled: true, // always-on paper engine
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:30',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  targetPoints: 10,
  stopLossPoints: 8,
  maxHoldMinutes: 15,
  minPutOi: 250000, // 2.5L ROBUST B
  maxPutOi: 3000000, // 30L spike cap
  requireSpotAlign: true,
  cooldownMinutes: 30,
  perTradeCost: 0,
};

const engineState = {
  running: false,
  startedAt: null,
  settings: { ...DEFAULT_SETTINGS },
  loopTimer: null,
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
  s.stopLossPoints = Math.max(1, Number(s.stopLossPoints) || 8);
  // 0 = disabled; otherwise 1–240 minutes (default 15)
  const holdRaw = Number(s.maxHoldMinutes);
  s.maxHoldMinutes = Number.isFinite(holdRaw)
    ? Math.max(0, Math.min(240, Math.floor(holdRaw)))
    : 15;
  s.minPutOi = Math.max(10000, Number(s.minPutOi) || 250000);
  const maxRaw = Number(s.maxPutOi);
  s.maxPutOi = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.max(s.minPutOi, maxRaw) : 3000000;
  s.requireSpotAlign = s.requireSpotAlign == null ? true : Boolean(s.requireSpotAlign);
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
      oiFlowEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  const raw = wallet.oiFlowEngineSettings?.toObject?.() || wallet.oiFlowEngineSettings || {};
  // One-time migrate older wallets onto ROBUST B always-on defaults.
  const needsMigrate =
    raw.enabled === false ||
    raw.requireSpotAlign == null ||
    raw.maxPutOi == null ||
    Number(raw.minPutOi) === 80000 ||
    !Number(raw.minPutOi);
  if (needsMigrate) {
    engineState.settings = await saveSettingsToDb({
      enabled: true,
      minPutOi: 250000,
      maxPutOi: 3000000,
      requireSpotAlign: true,
      maxHoldMinutes: Number(raw.maxHoldMinutes) > 0 ? Number(raw.maxHoldMinutes) : 15,
      cooldownMinutes: Number(raw.cooldownMinutes) || 30,
      targetPoints: Number(raw.targetPoints) || 10,
      stopLossPoints: Number(raw.stopLossPoints) || 8,
      lotCount: Number(raw.lotCount) || 10,
    });
    return engineState.settings;
  }
  engineState.settings = normalizeSettings(raw);
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.oiFlowEngineSettings?.toObject?.() || wallet.oiFlowEngineSettings || {}),
    ...partial,
  });
  wallet.oiFlowEngineSettings = next;
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

async function resolveOptionLtp(trade) {
  const optionType = String(trade.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
  let futSpot = null;
  let securityId = null;
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
      securityId = inst.securityId || inst.SecurityId || null;
      const ltp = await fetchInstrumentLtp(inst, { maxWaitMs: 2000, forceFresh: true });
      if (Number.isFinite(ltp) && ltp > 0) {
        return { optionLtp: ltp, spot: futSpot, source: 'marketfeed', securityId };
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
        securityId,
      };
    }
  } catch {
    /* fall through */
  }
  return { optionLtp: null, spot: futSpot, source: 'none', securityId };
}

async function saveOptionTick(trade, mark) {
  if (!trade?._id || !Number.isFinite(mark?.optionLtp) || mark.optionLtp <= 0) return;
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
  for (const t of ticks) {
    const ltp = Number(t.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) continue;
    if (Number.isFinite(sl) && ltp <= sl - EXIT_EPS) {
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
  if (nextMark.source === 'marketfeed') return true;
  if (!prevMark || !Number.isFinite(prevMark.optionLtp) || prevMark.optionLtp <= 0) return true;
  // Never overwrite a recent marketfeed mark with chain/none (causes MTM flicker).
  if (String(prevMark.source || '').startsWith('marketfeed')) {
    const ageMs = prevAt ? Date.now() - new Date(prevAt).getTime() : Infinity;
    if (ageMs < 45000) return false;
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
    if (ageMs < 45000) {
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

    await recalcWalletFromTrades();
    engineState.openTradeId = null;
    engineState.lastExitAtMs = Date.now();
    // Do not re-enter on the same ongoing signal — wait until decision goes WAIT.
    engineState.entryArmed = false;
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
    return;
  }
  engineState.openTradeId = String(open._id);

  const clock = getIstClock(new Date());
  const liveMark = await resolveOptionLtp(open);
  const mark = await resolveDisplayMark(open, liveMark);

  if (shouldUpdateOpenMark(open.openPositionMark, open.openPositionMarkAt, mark)) {
    const mtm = computeOpenMtm(open, mark.optionLtp);
    open.openPositionMark = {
      optionLtp: Number(Number(mark.optionLtp).toFixed(2)),
      spot: Number.isFinite(mark.spot) && mark.spot > 0 ? Number(Number(mark.spot).toFixed(2)) : null,
      source: mark.source,
      at: new Date().toISOString(),
      mtm: mtm != null ? Number(mtm.toFixed(2)) : null,
      qty: tradeQty(open),
      pts: Number.isFinite(Number(open.entryPremium))
        ? Number((Number(mark.optionLtp) - Number(open.entryPremium)).toFixed(2))
        : null,
    };
    open.openPositionMarkAt = new Date();
    await open.save();
  }
  // Only persist ticks from live resolve (not held stale display) when fresh feed/chain.
  if (
    Number.isFinite(liveMark.optionLtp) &&
    liveMark.optionLtp > 0 &&
    (liveMark.source === 'marketfeed' || liveMark.source === 'chain')
  ) {
    await saveOptionTick(open, liveMark);
  }

  // Missed SL/TP from 5m buffer (fast candles between polls)
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
      exitPremium: mark.optionLtp,
      mark,
      reason: 'DAY_CLOSE',
    });
    return;
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;
  // Avoid acting on chain prints early; prefer marketfeed / held feed.
  if (mark.source === 'chain' && heldMs < MIN_HOLD_MS * 2) return;

  if (open.stopLossPremium != null && optionLtp <= Number(open.stopLossPremium) - EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: Math.min(optionLtp, Number(open.stopLossPremium)),
      mark,
      reason: 'STOP_LOSS',
    });
    return;
  }
  if (open.targetPremium != null && optionLtp >= Number(open.targetPremium) + EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: Math.max(optionLtp, Number(open.targetPremium)),
      mark,
      reason: 'TARGET',
    });
    return;
  }

  const maxHoldMin = Number(engineState.settings.maxHoldMinutes) || 0;
  if (maxHoldMin > 0 && heldMs >= maxHoldMin * 60 * 1000) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark,
      reason: 'TIME_EXIT',
    });
  }
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
  if (rows.length < 2) return null;
  const ctx = buildIndex(rows);
  const last = rows[rows.length - 1];
  const decision = decideRaw(ctx, last.minutes, {
    minPutOi: engineState.settings.minPutOi,
    maxPutOi: engineState.settings.maxPutOi,
    requireSpotAlign: engineState.settings.requireSpotAlign,
  });
  engineState.lastDecision = decision;
  // Re-arm only after signal clears (WAIT) — next BUY is a fresh setup.
  if (!decision || decision.decision === 'WAIT') {
    engineState.entryArmed = true;
    return null;
  }
  if (decision.decision !== 'CALL BUY' && decision.decision !== 'PUT BUY') {
    return null;
  }
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
    try {
      const prem = await getAtmPremiums({ symbol, expiry });
      if (Number.isFinite(prem?.atm)) strike = prem.atm;
      if (Number.isFinite(prem?.spot) && prem.spot > 0) entrySpot = prem.spot;
      else if (Number.isFinite(prem?.fut) && prem.fut > 0) entrySpot = prem.fut;
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
    const stopLossPoints = Number(engineState.settings.stopLossPoints) || 8;
    const maxHoldMinutes = Number(engineState.settings.maxHoldMinutes) || 15;
    const minPutOi = Number(engineState.settings.minPutOi) || 250000;
    const maxPutOi = Number(engineState.settings.maxPutOi) || 3000000;
    const requireSpotAlign = engineState.settings.requireSpotAlign !== false;
    const targetPremium = entryPremium + targetPoints;
    const stopLossPremium = Math.max(0.05, entryPremium - stopLossPoints);

    const signalSnapshot = {
      decision: signal.decision,
      matchedRule:
        signal.matchedRule ||
        (signal.decision === 'PUT BUY'
          ? `Put buying + Put ΔOI ≥ ${minPutOi} + spot ↓ → PUT BUY (LONG PE)`
          : `Put writing + Put ΔOI ≥ ${minPutOi} + spot ↑ → CALL BUY (LONG CE)`),
      rules: [
        `Put buying + Put ΔOI ≥ ${minPutOi} + spot ↓ → PUT BUY (LONG PE)`,
        `Put writing + Put ΔOI ≥ ${minPutOi} + spot ↑ → CALL BUY (LONG CE)`,
        `Skip mega spike Put ΔOI > ${maxPutOi}`,
        `Spot align ${requireSpotAlign ? 'ON' : 'OFF'} · max hold ${maxHoldMinutes}m · cooldown ${engineState.settings.cooldownMinutes}m`,
      ],
      reason: signal.reason || null,
      time: signal.time,
      minutes: signal.minutes,
      spot: signal.spot,
      priceDir: signal.priceDir,
      spotChg1: signal.spotChg1,
      spotChg5: signal.spotChg5,
      putAct: signal.putAct,
      callAct: signal.callAct,
      putChg: signal.putChg,
      putChgL: signal.putChgL,
      callChg: signal.callChg,
      callChgL: signal.callChgL,
      minPutOi,
      maxPutOi,
      requireSpotAlign,
      targetPoints,
      stopLossPoints,
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
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      status: 'OPEN',
      entryReason: `${signal.decision} · ${signal.putAct} · ${signal.putChgL || ''} · ${signal.time}`,
      investedAmount: Number((entryPremium * qty + charges).toFixed(2)),
      capitalLocked: Number((entryPremium * qty + charges).toFixed(2)),
      charges,
      notes: `entryMark=${entrySource}; signal=${signal.time}`,
      signalSnapshot,
      openPositionMark: {
        optionLtp: Number(entryPremium.toFixed(2)),
        spot: Number.isFinite(entrySpot) ? Number(entrySpot.toFixed(2)) : null,
        source: entrySource,
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

    await saveOptionTick(tradeDoc, {
      optionLtp: entryPremium,
      spot: entrySpot,
      source: entrySource,
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
    // Persist always-on if wallet still has stale enabled:false
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
    'stopLossPoints',
    'maxHoldMinutes',
    'minPutOi',
    'maxPutOi',
    'requireSpotAlign',
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
    strategyLabel: 'ROBUST B · Put≥2.5L + spot align · cap 30L',
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
  if (status === 'OPEN') {
    filter.status = 'OPEN';
    filter.exitTime = null;
  } else if (status === 'CLOSED') {
    filter.$or = [{ status: 'CLOSED' }, { exitTime: { $ne: null } }];
  } else {
    // TODAY / default — today's entries + still-open
    filter.$or = [
      { entryDateKey: clock.dateKey },
      { exitDateKey: clock.dateKey },
      { status: 'OPEN', exitTime: null },
    ];
  }
  const lim = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const skip = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * lim);
  const [rows, total] = await Promise.all([
    LivePaperTrade.find(filter).sort({ entryTime: -1 }).skip(skip).limit(lim).lean(),
    LivePaperTrade.countDocuments(filter),
  ]);
  return { trades: rows, total, page: Number(page) || 1, pageSize: lim, dateKey: clock.dateKey };
}

async function getBookSummary() {
  const wallet = await recalcWalletFromTrades();
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
    strategyLabel: 'ROBUST B · Put≥2.5L + spot align · cap 30L',
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
  throw new Error('Manual close disabled — OI Flow ROBUST B exits only on Target / SL / Time / Day close');
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

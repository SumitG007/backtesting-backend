/**
 * Manual Console — Live Signal auto scalp.
 * Separate strategyKey + wallet from manual console entries.
 * Rules: 1 open trade at a time · TAKE_ENTRY signal · +5 / −15 · OI flip exit.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { MANUAL_OI_AUTO_LIVE_KEY } = require('../strategies/keys');
const { getIstClock } = require('../utils/dateTime');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getFutureLtp,
} = require('./dhanLiveService');

const STRATEGY_KEY = MANUAL_OI_AUTO_LIVE_KEY;
const WALLET_KEY = 'paper_live_manual_oi_auto';
const STRATEGY_ID = 'manual-oi-auto';

const LOOP_MS = 5000;
const MIN_HOLD_MS = 20000;
/** OI side-flip exits need a longer hold + confirmed opposite signal. */
const OI_EXIT_MIN_HOLD_MS = 60000;
const OI_FLIP_CONFIRM_TICKS = 3;
const NEAR_BAND_DIV = 2;
/** Ignore tiny LTP noise vs entry before counting as real target/SL. */
const EXIT_EPS = 0.15;

const DEFAULT_SETTINGS = {
  enabled: false,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:30',
  tradeToTime: '13:00',
  eodExitTime: '15:15',
  targetPoints: 5,
  stopLossPoints: 15,
  proximityPoints: 20,
  minOiRatio: 1.2,
  cooldownSeconds: 90,
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
  /** After an exit, require signal to leave TAKE_ENTRY before next arm. */
  entryArmed: true,
  lastEntryKey: null,
  lastSignal: null,
  lastBoardAt: null,
  lastError: null,
  lastEntryDebug: null,
  closingTrade: false,
  enteringTrade: false,
  /** Consecutive opposite TAKE_ENTRY ticks while in a trade (OI flip confirm). */
  oiFlipTicks: 0,
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

function roundToStrike(price, step) {
  const s = Math.max(1, Number(step) || 50);
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return Math.round(p / s) * s;
}

function findStrikeRow(strikes, strike) {
  if (!Number.isFinite(strike)) return null;
  const rows = Array.isArray(strikes) ? strikes : [];
  let exact = null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const row of rows) {
    const s = Number(row?.strike);
    if (!Number.isFinite(s)) continue;
    const d = Math.abs(s - strike);
    if (d === 0) {
      exact = row;
      break;
    }
    if (d < nearestDist) {
      nearestDist = d;
      nearest = row;
    }
  }
  return exact || nearest;
}

function biasFromRow(row, minOiRatio) {
  if (!row || !Number.isFinite(Number(row.strike))) return null;
  const putOi = Number(row.putOi);
  const callOi = Number(row.callOi);
  if (!Number.isFinite(putOi) || !Number.isFinite(callOi)) return null;
  if (putOi <= 0 && callOi <= 0) return null;

  const putDom = putOi >= callOi;
  const ratio = putDom
    ? putOi / Math.max(callOi, 1)
    : callOi / Math.max(putOi, 1);
  const putChg = Number(row.putChgOi);
  const callChg = Number(row.callChgOi);
  const clear = ratio >= minOiRatio;

  let deltaOk = true;
  if (Number.isFinite(putChg) && Number.isFinite(callChg)) {
    if (putDom && callChg > putChg * 1.25 && callChg > 0) deltaOk = false;
    if (!putDom && putChg > callChg * 1.25 && putChg > 0) deltaOk = false;
  }

  return {
    strike: Number(row.strike),
    dominantSide: putDom ? 'PUT' : 'CALL',
    optionType: putDom ? 'CE' : 'PE',
    putOi,
    callOi,
    putChgOi: Number.isFinite(putChg) ? putChg : null,
    callChgOi: Number.isFinite(callChg) ? callChg : null,
    ratio: Number(ratio.toFixed(2)),
    clear,
    deltaOk,
  };
}

/** Prev / center / next strike biases around a price. */
function clusterAround(board, price, step, minOiRatio) {
  const center = roundToStrike(price, step);
  if (!Number.isFinite(center)) return { center: null, strikes: [], biases: [] };
  const strikes = [center - step, center, center + step];
  const biases = strikes.map((s) => biasFromRow(findStrikeRow(board.strikes, s), minOiRatio));
  return { center, strikes, biases };
}

/**
 * Strong entry needs FUT cluster + Spot cluster agreement.
 * - FUT center clear on side
 * - ≥2 of 3 FUT strikes (prev/center/next) lean same CE/PE
 * - Spot center must not clearly fight that side
 * - ≥1 of 3 Spot strikes lean same side (or Spot all weak)
 */
function evaluateStrongSetup(board, settings) {
  const minOiRatio = Math.max(1.05, Number(settings.minOiRatio) || 1.2);
  /** Slightly stricter for live auto entry. */
  const strongRatio = Math.max(minOiRatio, 1.25);
  const step = Math.max(1, Number(board.strikeStep) || 50);
  const fut = Number(board.fut ?? board.spot);
  const spotCash = Number(board.chainSpot);
  const spotPrice = Number.isFinite(spotCash) && spotCash > 0 ? spotCash : fut;

  const futCluster = clusterAround(board, fut, step, minOiRatio);
  const spotCluster = clusterAround(board, spotPrice, step, minOiRatio);
  const futCenter = futCluster.biases[1] || null;
  const spotCenter = spotCluster.biases[1] || null;

  if (!futCenter?.clear || !futCenter.deltaOk) {
    return {
      ok: false,
      reason: !futCenter?.clear ? 'FUT center wall weak' : 'FUT center ΔOI fighting',
      optionType: futCenter?.optionType || null,
      futCenter,
      spotCenter,
      futCluster,
      spotCluster,
      fut,
      spotCash: Number.isFinite(spotCash) ? spotCash : null,
      strongRatio,
    };
  }

  const side = futCenter.optionType;
  const futAgree = futCluster.biases.filter((b) => b && b.optionType === side && b.clear).length;
  const futSoftAgree = futCluster.biases.filter((b) => b && b.optionType === side).length;
  const spotFight = Boolean(
    spotCenter?.clear && spotCenter.optionType && spotCenter.optionType !== side,
  );
  const spotAgree = spotCluster.biases.filter((b) => b && b.optionType === side && b.clear).length;
  const spotSoftAgree = spotCluster.biases.filter((b) => b && b.optionType === side).length;
  const spotAllWeak = spotCluster.biases.every((b) => !b || !b.clear);

  const futStrong = futCenter.ratio >= strongRatio && futAgree >= 2 && futSoftAgree >= 2;
  const spotOk = !spotFight && (spotAgree >= 1 || (spotAllWeak && spotSoftAgree >= 1) || spotAgree + spotSoftAgree >= 2);

  if (spotFight) {
    return {
      ok: false,
      reason: `Spot ${spotCenter.strike} fights (${spotCenter.optionType} vs FUT ${side})`,
      optionType: side,
      futCenter,
      spotCenter,
      futCluster,
      spotCluster,
      futAgree,
      spotAgree,
      fut,
      spotCash: Number.isFinite(spotCash) ? spotCash : null,
      strongRatio,
      conflict: true,
    };
  }
  if (!futStrong) {
    return {
      ok: false,
      reason: `FUT cluster weak (${futAgree}/3 clear ${side}, need ≥2 · ratio ≥${strongRatio}×)`,
      optionType: side,
      futCenter,
      spotCenter,
      futCluster,
      spotCluster,
      futAgree,
      spotAgree,
      fut,
      spotCash: Number.isFinite(spotCash) ? spotCash : null,
      strongRatio,
    };
  }
  if (!spotOk) {
    return {
      ok: false,
      reason: `Spot cluster not supporting ${side} (prev/spot/next)`,
      optionType: side,
      futCenter,
      spotCenter,
      futCluster,
      spotCluster,
      futAgree,
      spotAgree,
      fut,
      spotCash: Number.isFinite(spotCash) ? spotCash : null,
      strongRatio,
    };
  }

  return {
    ok: true,
    reason: `Strong ${side}: FUT ${futAgree}/3 · Spot ${spotAgree}/3 support`,
    optionType: side,
    dominantSide: futCenter.dominantSide,
    futCenter,
    spotCenter,
    futCluster,
    spotCluster,
    futAgree,
    spotAgree,
    fut,
    spotCash: Number.isFinite(spotCash) ? spotCash : null,
    strongRatio,
  };
}

function buildSignalFromBoard(board, settings) {
  const minOiRatio = Math.max(1.05, Number(settings.minOiRatio) || 1.2);
  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 20);
  const nearBand = Math.max(8, Math.floor(proximityPoints / NEAR_BAND_DIV));

  if (!board?.strikes?.length) {
    return { status: 'WAIT', optionType: null, buyLive: false, detail: 'No board' };
  }

  const step = Math.max(1, Number(board.strikeStep) || 50);
  const setup = evaluateStrongSetup(board, settings);
  const fut = setup.fut;
  const futStrike = setup.futCenter?.strike || roundToStrike(fut, step);
  const primary = setup.futCenter;
  const atm = Number(board.atm) || futStrike;
  const futDist = primary && Number.isFinite(fut)
    ? Math.round(Math.abs(fut - primary.strike))
    : null;

  const base = {
    levelStrike: primary?.strike ?? futStrike,
    entryStrike: atm,
    fut,
    spotCash: setup.spotCash,
    ratio: primary?.ratio,
    spotDist: futDist,
    futAgree: setup.futAgree,
    spotAgree: setup.spotAgree,
    strongRatio: setup.strongRatio,
    clusterDetail: setup.reason,
  };

  if (setup.conflict) {
    return {
      ...base,
      status: 'CONFLICT',
      optionType: null,
      buyLive: false,
      conflict: true,
      detail: setup.reason,
    };
  }
  if (!primary?.clear) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: primary?.optionType || null,
      buyLive: false,
      detail: setup.reason || 'Weak OI wall',
    };
  }
  if (!primary.deltaOk) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: primary.optionType,
      buyLive: false,
      detail: 'ΔOI fighting on FUT strike',
    };
  }
  if (!setup.ok) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: setup.optionType,
      buyLive: false,
      detail: setup.reason,
    };
  }
  if (futDist == null || futDist > proximityPoints) {
    return {
      ...base,
      status: 'WATCHING',
      optionType: setup.optionType,
      buyLive: false,
      dominantSide: setup.dominantSide,
      detail: `Strong cluster ready · FUT ${futDist ?? '—'} pts from wall (need ≤${proximityPoints})`,
    };
  }
  if (futDist > nearBand) {
    return {
      ...base,
      status: 'NEAR',
      optionType: setup.optionType,
      buyLive: false,
      dominantSide: setup.dominantSide,
      detail: `Near wall · cluster OK (${setup.reason})`,
    };
  }
  return {
    ...base,
    status: 'TAKE_ENTRY',
    optionType: setup.optionType,
    buyLive: true,
    dominantSide: setup.dominantSide,
    putOi: primary.putOi,
    callOi: primary.callOi,
    putChgOi: primary.putChgOi,
    callChgOi: primary.callChgOi,
    detail: `Strong entry ${setup.optionType} · ${setup.reason}`,
  };
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
      manualOiAutoEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.enabled = Boolean(s.enabled);
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.targetPoints = Math.max(1, Number(s.targetPoints) || 5);
  s.stopLossPoints = Math.max(1, Number(s.stopLossPoints) || 15);
  s.proximityPoints = Math.max(5, Number(s.proximityPoints) || 20);
  s.minOiRatio = Math.max(1.05, Math.min(3, Number(s.minOiRatio) || 1.2));
  s.cooldownSeconds = Math.max(30, Math.floor(Number(s.cooldownSeconds) || 90));
  s.perTradeCost = Math.max(0, Number(s.perTradeCost) || 0);
  s.tradeFromTime = String(s.tradeFromTime || '09:30');
  s.tradeToTime = String(s.tradeToTime || '13:00');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  return s;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.manualOiAutoEngineSettings || {});
  // Persist new default lots when wallet still has stale/missing lotCount.
  const rawLots = wallet.manualOiAutoEngineSettings?.lotCount;
  if (rawLots == null || rawLots === '' || Number(rawLots) === 1) {
    engineState.settings = await saveSettingsToDb({ lotCount: 10 });
  }
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.manualOiAutoEngineSettings?.toObject?.() || wallet.manualOiAutoEngineSettings || {}),
    ...partial,
  });
  wallet.manualOiAutoEngineSettings = next;
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
    engineState.oiFlipTicks = 0;
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
    engineState.oiFlipTicks = 0;
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
  const targetPts = Number(engineState.settings.targetPoints) || 5;
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
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) {
    return;
  }
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) return;

  const cooldownSec = Math.max(30, Number(engineState.settings.cooldownSeconds) || 90);
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
    const strike = Number(signal.entryStrike || board?.atm || signal.levelStrike);
    const expiry = String(board?.expiry || engineState.expiry || (await getNearestWeeklyExpiry(symbol)) || '').slice(0, 10);
    if (!Number.isFinite(strike) || !expiry) {
      engineState.lastEntryDebug = { skip: 'missing_strike_or_expiry' };
      return;
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
    const targetPoints = Number(engineState.settings.targetPoints) || 5;
    const stopLossPoints = Number(engineState.settings.stopLossPoints) || 15;
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
      entryReason: `Auto ${optionType} · wall ${signal.levelStrike} · ${signal.dominantSide || ''} · ratio ${signal.ratio}×`,
      notes: `manual_oi_auto; wall=${signal.levelStrike}; side=${signal.dominantSide}; ratio=${signal.ratio}; tg=${targetPoints}; sl=${stopLossPoints}; entrySrc=${entrySource}`,
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
    const board = await fetchBoard();
    engineState.lastBoardAt = board?.at || new Date().toISOString();
    const signal = buildSignalFromBoard(board, engineState.settings);

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
    await syncOpenTradeId();
    await recalcWalletFromTrades();
    await secondsSinceLastExit(); // hydrate lastExitAtMs from DB
    engineState.running = true;
    engineState.startedAt = new Date();
    engineState.entryArmed = true;
    startLoop();
    tickOnce().catch(() => {});
    console.log('Manual OI auto-signal engine started');
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
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ status: 'CLOSED' }, { exitTime: { $ne: null } }],
  })
    .sort({ exitTime: -1 })
    .limit(100)
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
    closedTrades: closed,
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

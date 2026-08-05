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
} = require('./dhanLiveService');

const STRATEGY_KEY = MANUAL_OI_AUTO_LIVE_KEY;
const WALLET_KEY = 'paper_live_manual_oi_auto';
const STRATEGY_ID = 'manual-oi-auto';

const LOOP_MS = 4000;
const MIN_HOLD_MS = 12000;
const NEAR_BAND_DIV = 2;

const DEFAULT_SETTINGS = {
  enabled: false,
  symbol: 'NIFTY',
  lotCount: 1,
  tradeFromTime: '09:30',
  tradeToTime: '13:00',
  eodExitTime: '15:15',
  targetPoints: 5,
  stopLossPoints: 15,
  proximityPoints: 20,
  minOiRatio: 1.2,
  cooldownSeconds: 60,
  perTradeCost: 0,
};

const engineState = {
  running: false,
  startedAt: null,
  settings: { ...DEFAULT_SETTINGS },
  loopTimer: null,
  openTradeId: null,
  lastExitAtMs: 0,
  lastSignal: null,
  lastBoardAt: null,
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

function buildSignalFromBoard(board, settings) {
  const minOiRatio = Math.max(1.05, Number(settings.minOiRatio) || 1.2);
  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 20);
  const nearBand = Math.max(8, Math.floor(proximityPoints / NEAR_BAND_DIV));

  if (!board?.strikes?.length) {
    return { status: 'WAIT', optionType: null, buyLive: false, detail: 'No board' };
  }

  const step = Math.max(1, Number(board.strikeStep) || 50);
  const fut = Number(board.fut ?? board.spot);
  const spotCash = Number(board.chainSpot);
  const futStrike = roundToStrike(fut, step);
  const spotStrike = roundToStrike(Number.isFinite(spotCash) ? spotCash : fut, step);
  const futBias = biasFromRow(findStrikeRow(board.strikes, futStrike), minOiRatio);
  const spotBias = biasFromRow(findStrikeRow(board.strikes, spotStrike), minOiRatio);
  const futDist = futBias && Number.isFinite(fut)
    ? Math.round(Math.abs(fut - futBias.strike))
    : null;

  const sameStrike = futBias && spotBias && futBias.strike === spotBias.strike;
  const bothClear = Boolean(futBias?.clear && spotBias?.clear);
  const conflict =
    bothClear && !sameStrike && futBias.optionType !== spotBias.optionType;

  const primary = futBias;
  const atm = Number(board.atm) || futStrike;

  if (conflict) {
    return {
      status: 'CONFLICT',
      optionType: null,
      buyLive: false,
      levelStrike: primary?.strike ?? futStrike,
      entryStrike: atm,
      fut,
      ratio: primary?.ratio,
      spotDist: futDist,
      conflict: true,
      detail: 'Spot/FUT walls disagree',
    };
  }
  if (!primary?.clear) {
    return {
      status: 'CAUTION',
      optionType: primary?.optionType || null,
      buyLive: false,
      levelStrike: primary?.strike ?? futStrike,
      entryStrike: atm,
      fut,
      ratio: primary?.ratio,
      spotDist: futDist,
      detail: 'Weak OI wall',
    };
  }
  if (!primary.deltaOk) {
    return {
      status: 'CAUTION',
      optionType: primary.optionType,
      buyLive: false,
      levelStrike: primary.strike,
      entryStrike: atm,
      fut,
      ratio: primary.ratio,
      spotDist: futDist,
      detail: 'ΔOI fighting',
    };
  }
  if (futDist == null || futDist > proximityPoints) {
    return {
      status: 'WATCHING',
      optionType: primary.optionType,
      buyLive: false,
      levelStrike: primary.strike,
      entryStrike: atm,
      fut,
      ratio: primary.ratio,
      spotDist: futDist,
      detail: 'FUT far from wall',
    };
  }
  if (futDist > nearBand) {
    return {
      status: 'NEAR',
      optionType: primary.optionType,
      buyLive: false,
      levelStrike: primary.strike,
      entryStrike: atm,
      fut,
      ratio: primary.ratio,
      spotDist: futDist,
      detail: 'Near wall — prepare',
    };
  }
  return {
    status: 'TAKE_ENTRY',
    optionType: primary.optionType,
    buyLive: true,
    levelStrike: primary.strike,
    entryStrike: atm,
    fut,
    ratio: primary.ratio,
    spotDist: futDist,
    dominantSide: primary.dominantSide,
    putOi: primary.putOi,
    callOi: primary.callOi,
    putChgOi: primary.putChgOi,
    callChgOi: primary.callChgOi,
    detail: `Take ${primary.optionType} @ wall ${primary.strike}`,
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
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 1)));
  s.targetPoints = Math.max(1, Number(s.targetPoints) || 5);
  s.stopLossPoints = Math.max(1, Number(s.stopLossPoints) || 15);
  s.proximityPoints = Math.max(5, Number(s.proximityPoints) || 20);
  s.minOiRatio = Math.max(1.05, Math.min(3, Number(s.minOiRatio) || 1.2));
  s.cooldownSeconds = Math.max(0, Math.floor(Number(s.cooldownSeconds) || 60));
  s.perTradeCost = Math.max(0, Number(s.perTradeCost) || 0);
  s.tradeFromTime = String(s.tradeFromTime || '09:30');
  s.tradeToTime = String(s.tradeToTime || '13:00');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  return s;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.manualOiAutoEngineSettings || {});
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
  try {
    const inst = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType,
    });
    if (inst) {
      const ltp = await fetchInstrumentLtp(inst, { maxWaitMs: 1500 });
      if (Number.isFinite(ltp) && ltp > 0) {
        return { optionLtp: ltp, spot: null, source: 'marketfeed' };
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
    if (Number.isFinite(ltp) && ltp > 0) {
      return { optionLtp: ltp, spot: prem.spot ?? prem.chainSpot, source: 'chain' };
    }
  } catch {
    /* fall through */
  }
  return { optionLtp: null, spot: null, source: 'none' };
}

async function finalizeTrade(trade, { exitPremium, mark, reason }) {
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

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExit.toFixed(2));
    trade.exitSpot = Number.isFinite(Number(resolved?.spot))
      ? Number(Number(resolved.spot).toFixed(2))
      : trade.entrySpot;
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
    return trade;
  } finally {
    engineState.closingTrade = false;
  }
}

async function checkOpenTrade(signal) {
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
  if (Number.isFinite(mark.optionLtp) && mark.optionLtp > 0) {
    open.openPositionMark = {
      optionLtp: Number(mark.optionLtp.toFixed(2)),
      spot: mark.spot,
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
    });
    return;
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;

  if (open.stopLossPremium != null && optionLtp <= Number(open.stopLossPremium)) {
    await finalizeTrade(open, {
      exitPremium: Number(open.stopLossPremium),
      mark,
      reason: 'STOP_LOSS',
    });
    return;
  }
  if (open.targetPremium != null && optionLtp >= Number(open.targetPremium)) {
    await finalizeTrade(open, {
      exitPremium: Number(open.targetPremium),
      mark,
      reason: 'TARGET',
    });
    return;
  }

  // Sudden OI flip / opposite clear wall while in trade → auto close
  const openSide = String(open.optionType).toUpperCase();
  if (signal?.status === 'CONFLICT') {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark,
      reason: 'OI_CONFLICT_EXIT',
    });
    return;
  }
  if (
    signal?.optionType
    && signal.optionType !== openSide
    && (signal.status === 'TAKE_ENTRY' || signal.status === 'NEAR' || signal.status === 'WATCHING')
    && signal.ratio >= engineState.settings.minOiRatio
  ) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark,
      reason: 'OI_SIDE_FLIP',
    });
  }
}

async function tryEnter(signal, board) {
  if (!engineState.settings.enabled) return;
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (signal?.status !== 'TAKE_ENTRY' || !signal.buyLive || !signal.optionType) return;

  const clock = getIstClock(new Date());
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) {
    return;
  }
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) return;

  const cooldownMs = (Number(engineState.settings.cooldownSeconds) || 0) * 1000;
  if (cooldownMs > 0 && Date.now() - engineState.lastExitAtMs < cooldownMs) return;

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

    const prem = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = optionType === 'PE' ? Number(prem.peLtp) : Number(prem.ceLtp);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastEntryDebug = { skip: 'no_premium', strike, optionType, expiry };
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    engineState.expiry = expiry;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 1);
    const qty = lotSize * lots;
    const charges = Math.max(0, Number(engineState.settings.perTradeCost) || 0);
    const targetPoints = Number(engineState.settings.targetPoints) || 5;
    const stopLossPoints = Number(engineState.settings.stopLossPoints) || 15;
    const targetPremium = entryPremium + targetPoints;
    const stopLossPremium = Math.max(0.05, entryPremium - stopLossPoints);
    const fut = Number(signal.fut || board?.fut || prem.spot) || entryPremium;

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
      entrySpot: Number(Number(fut).toFixed(2)),
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
      notes: `manual_oi_auto; wall=${signal.levelStrike}; side=${signal.dominantSide}; ratio=${signal.ratio}; tg=${targetPoints}; sl=${stopLossPoints}`,
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.lastEntryDebug = {
      at: new Date().toISOString(),
      tradeId: engineState.openTradeId,
      optionType,
      strike,
      entryPremium,
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
  try {
    await loadSettingsFromDb();
    const board = await fetchBoard();
    engineState.lastBoardAt = board?.at || new Date().toISOString();
    const signal = buildSignalFromBoard(board, engineState.settings);
    engineState.lastSignal = {
      ...signal,
      at: engineState.lastBoardAt,
      enabled: engineState.settings.enabled,
    };

    await checkOpenTrade(signal);

    if (!engineState.openTradeId) {
      await tryEnter(signal, board);
    }
    engineState.lastError = null;
  } catch (err) {
    engineState.lastError = err.message;
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
    engineState.running = true;
    engineState.startedAt = new Date();
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
  return finalizeTrade(open, { exitPremium: mark.optionLtp, mark, reason });
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
};

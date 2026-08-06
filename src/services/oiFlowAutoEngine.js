/**
 * OI Flow Tracker — Multi-TF ΔOI Flow Scalp (separate strategy).
 * 15m bias → 5m confirm → 1m trigger + Live OI Board (FUT/Spot/strikes).
 * 1 open · +8 / −10 · 10 lots · 09:30–13:00 · ATM-shift guard.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { OI_FLOW_AUTO_LIVE_KEY } = require('../strategies/keys');
const { getIstClock } = require('../utils/dateTime');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getFutureLtp,
} = require('./dhanLiveService');

const STRATEGY_KEY = OI_FLOW_AUTO_LIVE_KEY;
const WALLET_KEY = 'paper_live_oi_flow_auto';
const STRATEGY_ID = 'oi-flow-auto';

const LOOP_MS = 5000;
const MIN_HOLD_MS = 20000;
const EXIT_EPS = 0.15;
const SESSION_FROM_MIN = 9 * 60 + 15;
const NEAR_BAND_DIV = 2;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:30',
  tradeToTime: '13:00',
  eodExitTime: '15:15',
  targetPoints: 8,
  stopLossPoints: 10,
  proximityPoints: 20,
  minOiRatio: 1.2,
  minAbsChngInDir: 25000,
  cooldownSeconds: 90,
  atmShiftSkipMinutes: 2,
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
  const putChg = Number(row.putChgOi);
  const callChg = Number(row.callChgOi);
  if (!Number.isFinite(putChg) || !Number.isFinite(callChg)) return null;
  const oiMass = Math.max(0, putChg) + Math.max(0, callChg);
  if (!(oiMass > 0)) return null;
  const putDom = putChg >= callChg;
  const ratio = putDom
    ? Math.max(putChg, 0) / Math.max(Math.max(callChg, 0), 1)
    : Math.max(callChg, 0) / Math.max(Math.max(putChg, 0), 1);
  return {
    strike: Number(row.strike),
    dominantSide: putDom ? 'PUT' : 'CALL',
    optionType: putDom ? 'CE' : 'PE',
    putOi: Number.isFinite(putOi) ? putOi : null,
    callOi: Number.isFinite(callOi) ? callOi : null,
    putChgOi: putChg,
    callChgOi: callChg,
    ratio: Number(ratio.toFixed(2)),
    clear: ratio >= minOiRatio,
    oiMass,
  };
}

function matchesInterval(minutes, intervalMin) {
  const step = Math.max(1, Number(intervalMin) || 1);
  if (!Number.isFinite(minutes)) return false;
  if (step === 1) return true;
  if (minutes < SESSION_FROM_MIN) return false;
  return (minutes - SESSION_FROM_MIN) % step === 0;
}

function enrichIntervalRows(allRows, intervalMin) {
  const step = Math.max(1, Number(intervalMin) || 1);
  const source = Array.isArray(allRows) ? allRows : [];
  const byMinutes = new Map();
  for (const row of source) {
    if (!row.fetchOk) continue;
    if (!matchesInterval(row.minutes, step)) continue;
    byMinutes.set(row.minutes, { ...row });
  }
  const chronological = Array.from(byMinutes.values()).sort(
    (a, b) => Number(a.minutes) - Number(b.minutes),
  );
  return chronological.map((row, idx) => {
    const prev = idx > 0 ? chronological[idx - 1] : null;
    let callsChgOi = row.callsChgOi;
    let putsChgOi = row.putsChgOi;
    if (Number.isFinite(row.callOiTotal) && prev && Number.isFinite(prev.callOiTotal)) {
      callsChgOi = row.callOiTotal - prev.callOiTotal;
    }
    if (Number.isFinite(row.putOiTotal) && prev && Number.isFinite(prev.putOiTotal)) {
      putsChgOi = row.putOiTotal - prev.putOiTotal;
    }
    const chngInDir =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
        ? putsChgOi - callsChgOi
        : null;
    const diffInOi =
      Number.isFinite(row.dayPutChgOi) && Number.isFinite(row.dayCallChgOi)
        ? row.dayPutChgOi - row.dayCallChgOi
        : null;
    const sentiment =
      !Number.isFinite(chngInDir) || chngInDir === 0
        ? 'Neutral'
        : chngInDir > 0
          ? 'Bull'
          : 'Bear';
    return {
      ...row,
      callsChgOi,
      putsChgOi,
      chngInDir,
      diffInOi,
      sentiment,
    };
  });
}

function latestTf(allRows, intervalMin) {
  const rows = enrichIntervalRows(allRows, intervalMin);
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  return {
    intervalMin,
    time: row.time,
    minutes: row.minutes,
    atm: row.atm,
    spotPrice: row.spotPrice,
    chngInDir: row.chngInDir,
    diffInOi: row.diffInOi,
    dayCallChgOi: row.dayCallChgOi,
    dayPutChgOi: row.dayPutChgOi,
    sentiment: row.sentiment,
  };
}

function detectAtmShift(allRows, skipMinutes) {
  const ones = enrichIntervalRows(allRows, 1);
  if (ones.length < 2) return { shifted: false, prevAtm: null, atm: null };
  const last = ones[ones.length - 1];
  const prev = ones[ones.length - 2];
  const shifted =
    Number.isFinite(last.atm)
    && Number.isFinite(prev.atm)
    && Number(last.atm) !== Number(prev.atm);
  const age = Number(last.minutes) - Number(prev.minutes);
  const withinSkip = shifted && age <= Math.max(1, Number(skipMinutes) || 2);
  return {
    shifted: Boolean(withinSkip),
    prevAtm: prev.atm,
    atm: last.atm,
    fromTime: prev.time,
    toTime: last.time,
  };
}

function buildFlowBoardSignal(flowRows, board, settings) {
  const minOiRatio = Math.max(1.05, Number(settings.minOiRatio) || 1.2);
  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 20);
  const nearBand = Math.max(8, Math.floor(proximityPoints / NEAR_BAND_DIV));
  const minAbs = Math.max(0, Number(settings.minAbsChngInDir) || 25000);

  const tf15 = latestTf(flowRows, 15);
  const tf5 = latestTf(flowRows, 5);
  const tf1 = latestTf(flowRows, 1);
  const atmShift = detectAtmShift(flowRows, settings.atmShiftSkipMinutes);

  const step = Math.max(1, Number(board?.strikeStep) || 50);
  const fut = Number(board?.fut ?? board?.spot);
  const spotCash = Number(board?.chainSpot);
  const futStrike = roundToStrike(fut, step);
  const wall = biasFromRow(findStrikeRow(board?.strikes, futStrike), minOiRatio);
  const atm = Number(board?.atm) || futStrike;
  const futDist =
    wall && Number.isFinite(fut) ? Math.round(Math.abs(fut - wall.strike)) : null;

  const base = {
    tf15,
    tf5,
    tf1,
    atmShift,
    levelStrike: wall?.strike ?? futStrike,
    entryStrike: atm,
    fut: Number.isFinite(fut) ? fut : null,
    spotCash: Number.isFinite(spotCash) && spotCash > 0 ? spotCash : null,
    futDist,
    ratio: wall?.ratio ?? null,
    wallSide: wall?.dominantSide ?? null,
    wallOptionType: wall?.optionType ?? null,
    wallClear: Boolean(wall?.clear),
    dayDiff: tf1?.diffInOi ?? null,
    putChgOi: wall?.putChgOi ?? null,
    callChgOi: wall?.callChgOi ?? null,
  };

  if (!board?.strikes?.length) {
    return { ...base, status: 'WATCHING', optionType: null, buyLive: false, detail: 'Waiting for OI board' };
  }
  if (!tf15?.sentiment || tf15.sentiment === 'Neutral') {
    return { ...base, status: 'WATCHING', optionType: null, buyLive: false, detail: 'Waiting for 15m ΔOI bias' };
  }

  const biasSide = tf15.sentiment === 'Bull' ? 'CE' : 'PE';
  const biasDom = biasSide === 'CE' ? 'PUT' : 'CALL';

  if (!tf5?.sentiment || tf5.sentiment !== tf15.sentiment) {
    return {
      ...base,
      status: 'BIAS',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `15m ${tf15.sentiment} · waiting 5m confirm`,
    };
  }

  if (atmShift.shifted) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `ATM shifted ${atmShift.prevAtm}→${atmShift.atm} · skip ${settings.atmShiftSkipMinutes || 2}m`,
    };
  }

  if (!tf1?.sentiment || tf1.sentiment !== tf15.sentiment) {
    return {
      ...base,
      status: 'BIAS',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `15m+5m ${tf15.sentiment} · waiting 1m trigger`,
    };
  }

  if (!Number.isFinite(tf1.chngInDir) || Math.abs(tf1.chngInDir) < minAbs) {
    return {
      ...base,
      status: 'BIAS',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `1m Chng too small (|${Math.round(tf1.chngInDir || 0)}| < ${minAbs})`,
    };
  }

  if (!wall?.clear || wall.optionType !== biasSide) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: !wall
        ? 'No FUT-center ΔOI wall'
        : !wall.clear
          ? `Wall weak (${wall.ratio}× < ${minOiRatio}×)`
          : `Board wall ${wall.optionType} fights flow ${biasSide}`,
    };
  }

  // Spot fight: clear opposite wall at spot center
  const spotPrice = Number.isFinite(spotCash) && spotCash > 0 ? spotCash : fut;
  const spotStrike = roundToStrike(spotPrice, step);
  const spotWall = biasFromRow(findStrikeRow(board.strikes, spotStrike), minOiRatio);
  if (spotWall?.clear && spotWall.optionType && spotWall.optionType !== biasSide) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `Spot ${spotWall.strike} fights (${spotWall.optionType} vs flow ${biasSide})`,
    };
  }

  if (futDist == null || futDist > proximityPoints) {
    return {
      ...base,
      status: 'READY',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `Flow+board aligned ${biasSide} · FUT ${futDist ?? '—'} pts (need ≤${proximityPoints})`,
    };
  }
  if (futDist > nearBand) {
    return {
      ...base,
      status: 'READY',
      optionType: biasSide,
      dominantSide: biasDom,
      buyLive: false,
      detail: `Near wall · ${biasSide} · FUT ${futDist} pts (enter ≤${nearBand})`,
    };
  }

  return {
    ...base,
    status: 'TAKE_ENTRY',
    optionType: biasSide,
    dominantSide: biasDom,
    buyLive: true,
    detail: `TAKE ${biasSide} · 15m/5m/1m ${tf15.sentiment} · wall ${wall.strike} · FUT ${futDist} pts`,
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
      oiFlowAutoEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // Always-on strategy — never leave disabled.
  s.enabled = true;
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.targetPoints = Math.max(1, Number(s.targetPoints) || 8);
  s.stopLossPoints = Math.max(1, Number(s.stopLossPoints) || 10);
  s.proximityPoints = Math.max(5, Number(s.proximityPoints) || 20);
  s.minOiRatio = Math.max(1.05, Math.min(3, Number(s.minOiRatio) || 1.2));
  s.minAbsChngInDir = Math.max(0, Math.floor(Number(s.minAbsChngInDir) || 25000));
  s.cooldownSeconds = Math.max(30, Math.floor(Number(s.cooldownSeconds) || 90));
  s.atmShiftSkipMinutes = Math.max(1, Math.min(5, Math.floor(Number(s.atmShiftSkipMinutes) || 2)));
  s.perTradeCost = Math.max(0, Number(s.perTradeCost) || 0);
  s.tradeFromTime = String(s.tradeFromTime || '09:30');
  s.tradeToTime = String(s.tradeToTime || '13:00');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  return s;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.oiFlowAutoEngineSettings || {});
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.oiFlowAutoEngineSettings?.toObject?.() || wallet.oiFlowAutoEngineSettings || {}),
    ...partial,
  });
  wallet.oiFlowAutoEngineSettings = next;
  wallet.markModified('oiFlowAutoEngineSettings');
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

async function loadFlowRows() {
  const clock = getIstClock(new Date());
  return OiFlowMinuteRow.find({
    symbol: engineState.settings.symbol || 'NIFTY',
    dateKey: clock.dateKey,
  })
    .sort({ minutes: 1 })
    .lean();
}

async function fetchBoard() {
  const manualEngine = require('./manualTradeEngine');
  return manualEngine.getLiveOiBoard({
    symbol: engineState.settings.symbol || 'NIFTY',
    lookaroundStrikes: 10,
  });
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
    trade.exitSpot = exitSpot != null ? exitSpot : Number(trade.entrySpot) || undefined;
    if (!(Number(trade.exitSpot) > 0)) trade.exitSpot = undefined;
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct =
      investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
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
      spot:
        Number.isFinite(mark.spot) && mark.spot > 0
          ? mark.spot
          : Number.isFinite(futFallback) && futFallback > 0
            ? futFallback
            : null,
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
  if (mark.source === 'chain' && heldMs < MIN_HOLD_MS * 2) return;

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
  const targetPts = Number(engineState.settings.targetPoints) || 8;
  const entry = Number(open.entryPremium);
  if (Number.isFinite(entry) && optionLtp >= entry + targetPts - EXIT_EPS) {
    await finalizeTrade(open, {
      exitPremium: optionLtp,
      mark,
      reason: 'TARGET',
      futFallback,
    });
  }
}

async function tryEnter(signal, board) {
  if (!engineState.settings.enabled) return;
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (signal?.status !== 'TAKE_ENTRY' || !signal.buyLive || !signal.optionType) {
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
    const expiry = String(
      board?.expiry || engineState.expiry || (await getNearestWeeklyExpiry(symbol)) || '',
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
    const targetPoints = Number(engineState.settings.targetPoints) || 8;
    const stopLossPoints = Number(engineState.settings.stopLossPoints) || 10;
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
      entryReason: `Flow ${optionType} · 15/5/1 ${signal.tf15?.sentiment} · wall ${signal.levelStrike}`,
      notes: `oi_flow_auto; wall=${signal.levelStrike}; side=${signal.dominantSide}; tg=${targetPoints}; sl=${stopLossPoints}; entrySrc=${entrySource}`,
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.lastEntryKey = entryKey;
    engineState.entryArmed = false;
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

async function tickOnce() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    await loadSettingsFromDb();
    const [flowRows, board] = await Promise.all([loadFlowRows(), fetchBoard()]);
    engineState.lastBoardAt = board?.at || new Date().toISOString();
    let signal = buildFlowBoardSignal(flowRows, board, engineState.settings);

    if (engineState.openTradeId) {
      signal = {
        ...signal,
        status: 'IN_TRADE',
        buyLive: false,
        detail: signal.detail ? `IN TRADE · ${signal.detail}` : 'IN TRADE',
      };
    } else {
      const cooldownSec = Math.max(30, Number(engineState.settings.cooldownSeconds) || 90);
      const sinceExit = await secondsSinceLastExit();
      if (sinceExit < cooldownSec && signal.status === 'TAKE_ENTRY') {
        signal = {
          ...signal,
          status: 'COOLDOWN',
          buyLive: false,
          detail: `Cooldown ${Math.ceil(cooldownSec - sinceExit)}s · ${signal.detail || ''}`,
        };
      }
    }

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
    // Force always-on.
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }
    await syncOpenTradeId();
    await recalcWalletFromTrades();
    await secondsSinceLastExit();
    engineState.running = true;
    engineState.startedAt = new Date();
    engineState.entryArmed = true;
    startLoop();
    tickOnce().catch(() => {});
    console.log('OI Flow auto scalp engine started (always on)');
    return { ok: true, started: true };
  }
  await syncOpenTradeId();
  if (!engineState.settings.enabled) {
    await saveSettingsToDb({ enabled: true });
  }
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

async function setEnabled(_enabled) {
  // Always-on — ignore disable requests.
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
  if (!open) throw new Error('No open OI Flow auto trade');
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
};

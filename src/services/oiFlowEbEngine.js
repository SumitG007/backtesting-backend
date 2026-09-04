/**
 * OI Flow E/B — paper live.
 * Closed 15m Strong Bull/Bear + Spot Δ + Match → ATM CE/PE.
 * Option premium SL/TP on that strike (default −12 / +15) · day +15/−16 new entries · 1 open.
 * Spot is for entry signal only. Open trades exit only on strike option SL or TP.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { OI_FLOW_EB_LIVE_KEY } = require('../strategies/keys');
const { buildSignalFromOiFlow } = require('../strategies/oiFlowEb/signals');
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

const STRATEGY_KEY = OI_FLOW_EB_LIVE_KEY;
const WALLET_KEY = 'paper_live_oi_flow_eb';
const STRATEGY_ID = 'oi-flow-eb';

const LOOP_MS = 5000;
const MIN_HOLD_MS = 15000;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:45',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  stepMin: 15,
  callMinSpotDelta: 5,
  /** Fixed option-premium stop / target (pts from entry LTP). */
  optionSlPts: 12,
  optionTpPts: 15,
  dailyTarget: 15,
  dailyLoss: 16,
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
  lastEntryBarMinutes: null,
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
  dayLocked: false,
  dayStopReason: null,
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
      oiFlowEbEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.enabled = Boolean(s.enabled);
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.stepMin = Math.max(5, Math.min(60, Math.floor(Number(s.stepMin) || 15)));
  s.callMinSpotDelta = Math.max(0, Number(s.callMinSpotDelta) || 5);
  // Migrate legacy spot candle risk fields → fixed option pts if needed
  const legacySl = Number(s.riskMax);
  const legacyTp = Number(s.tpCap);
  s.optionSlPts = Math.max(
    1,
    Number(s.optionSlPts) || (Number.isFinite(legacySl) ? legacySl : 12) || 12,
  );
  s.optionTpPts = Math.max(
    1,
    Number(s.optionTpPts) || (Number.isFinite(legacyTp) ? legacyTp : 15) || 15,
  );
  s.dailyTarget = Math.max(1, Number(s.dailyTarget) || 15);
  s.dailyLoss = Math.max(1, Number(s.dailyLoss) || 16);
  s.perTradeCost = Math.max(0, Number(s.perTradeCost) || 0);
  s.tradeFromTime = String(s.tradeFromTime || '09:45');
  s.tradeToTime = String(s.tradeToTime || '14:30');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  // Drop legacy spot-risk / max-hold keys from runtime settings
  delete s.riskMin;
  delete s.riskMax;
  delete s.slBufferPts;
  delete s.rMult;
  delete s.tpCap;
  delete s.maxHoldMin;
  return s;
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.oiFlowEbEngineSettings || {});
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.oiFlowEbEngineSettings?.toObject?.() || wallet.oiFlowEbEngineSettings || {}),
    ...partial,
  });
  wallet.oiFlowEbEngineSettings = next;
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
    engineState.dayLocked = false;
    engineState.dayStopReason = null;
    engineState.lastEntryBarMinutes = null;
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
  let dayStopReason = null;
  let lastBar = null;
  const dailyTarget = Number(engineState.settings.dailyTarget) || 15;
  const dailyLoss = Number(engineState.settings.dailyLoss) || 16;

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
    if (!dayStopReason && dayPts >= dailyTarget) {
      dayStopReason = `Daily target +${dailyTarget}`;
    } else if (!dayStopReason && dayPts <= -Math.abs(dailyLoss)) {
      dayStopReason = `Daily loss −${dailyLoss}`;
    }
  }

  engineState.dayPts = dayPts;
  engineState.dayLocked = Boolean(dayStopReason);
  engineState.dayStopReason = dayStopReason;
  engineState.lastEntryBarMinutes = lastBar;
  return {
    dayPts,
    dayLocked: engineState.dayLocked,
    dayStopReason,
    lastEntryBarMinutes: lastBar,
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
    engineState.entryArmed = false;
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

  // Exits only on this strike's option LTP vs fixed premium SL / TP.
  // No max-hold TIME exit. No spot SL/TP. No EOD force-close on open trades.
  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const snap = open.signalSnapshot || {};
  const entryPrem = Number(open.entryPremium);
  const ltp = Number(mark.optionLtp);
  const slPts = Math.max(
    1,
    Number(snap.riskPts) || Number(engineState.settings.optionSlPts) || 12,
  );
  const tpPts = Math.max(
    1,
    Number(snap.rewardPts) || Number(engineState.settings.optionTpPts) || 15,
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
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (signal?.status !== 'TAKE_ENTRY' || !signal.buyLive || !signal.optionType) {
    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }
    return;
  }
  if (!engineState.entryArmed) return;
  if (engineState.dayLocked) {
    engineState.lastEntryDebug = { skip: 'day_locked', reason: engineState.dayStopReason };
    return;
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
    const entrySpot = Number(signal.entrySpot || signal.spot || tape?.displayRow?.spotPrice);
    const slPts = Math.max(1, Number(signal.riskPts) || Number(engineState.settings.optionSlPts) || 12);
    const tpPts = Math.max(1, Number(signal.rewardPts) || Number(engineState.settings.optionTpPts) || 15);
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
      entryReason: `OI Flow E/B ${signal.decision || optionType} · ${signal.barTime || ''} · ${signal.patternName || ''}`,
      notes: `oi_flow_eb; pattern=${signal.patternId}; optionSL=${slPts}; optionTP=${tpPts}; entrySrc=${entrySource}`,
      signalSnapshot: {
        patternId: signal.patternId,
        patternName: signal.patternName,
        decision: signal.decision,
        strength: signal.strength,
        spotDelta: signal.spotDelta,
        act: signal.act,
        barTime: signal.barTime,
        barMinutes: signal.barMinutes,
        entryMinutes: signal.barMinutes,
        riskPts: slPts,
        rewardPts: tpPts,
        optionSlPts: slPts,
        optionTpPts: tpPts,
        stopLossPremium,
        targetPremium,
      },
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.entryArmed = false;
    engineState.lastEntryKey = entryKey;
    engineState.lastEntryBarMinutes = Number(signal.barMinutes);
    engineState.lastEntryDebug = {
      at: new Date().toISOString(),
      tradeId: engineState.openTradeId,
      optionType,
      strike,
      entryPremium,
      entrySource,
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
    const signal = buildSignalFromOiFlow(tape, engineState.settings, {
      dayLocked: dayBook.dayLocked,
      dayPts: dayBook.dayPts,
      dayStopReason: dayBook.dayStopReason,
      lastEntryBarMinutes: dayBook.lastEntryBarMinutes,
    });

    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }

    engineState.lastSignal = {
      ...signal,
      at: engineState.lastTapeAt,
      enabled: engineState.settings.enabled,
      entryArmed: engineState.entryArmed,
      dayPts: dayBook.dayPts,
      dayLocked: dayBook.dayLocked,
      dayStopReason: dayBook.dayStopReason,
    };

    const hadOpen = Boolean(engineState.openTradeId);
    await checkOpenTrade(signal, tape);
    const closedThisTick = hadOpen && !engineState.openTradeId;

    if (!engineState.openTradeId && !closedThisTick && !dayBook.dayLocked) {
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

async function ensureEngineRunning() {
  if (!engineState.running) {
    await loadSettingsFromDb();
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }
    await syncOpenTradeId();
    await recalcWalletFromTrades();
    const bootClock = getIstClock(new Date());
    await refreshDayBook(bootClock.dateKey);
    engineState.running = true;
    engineState.startedAt = new Date();
    engineState.entryArmed = true;
    startLoop();
    tickOnce().catch(() => {});
    console.log('OI Flow E/B paper engine started');
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
    dayLocked: engineState.dayLocked,
    dayStopReason: engineState.dayStopReason,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    lastTapeAt: engineState.lastTapeAt,
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
    dayLocked: dayBook.dayLocked,
    dayStopReason: dayBook.dayStopReason,
    lastError: engineState.lastError,
  };
}

async function closeOpenTradeManual(reason = 'MANUAL_CLOSE') {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) throw new Error('No open OI Flow E/B trade');
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

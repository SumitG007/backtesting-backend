/**
 * Strategy 13 — OI Universe Scanner paper live.
 * Monitors NIFTY + BANKNIFTY + SENSEX + top liquid OPTSTK names on a priority OI schedule.
 * Stronger entry filters than OI Wall Entry.
 * Multi-position: one open per symbol; stocks carry overnight until SL / target / expiry
 * (indexes still EOD square-off).
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
} = require('./nseHolidayService');
const { PRESET_SYMBOLS } = require('../config/constants');
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
  listFutureExpiries,
  resolveFutureInstrument,
  getFutureLtp,
} = require('./dhanLiveService');
const { STRATEGY_THIRTEEN_OI_UNIVERSE_LIVE_KEY } = require('../strategies/keys');
const { pushNotification, pruneTradeNotifications } = require('./notificationHub');
const { broadcast } = require('./realtimeSocket');

const STRATEGY_KEY = STRATEGY_THIRTEEN_OI_UNIVERSE_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy13';
const optionSubKey = (tradeId) => `engine:strategy13:option:${String(tradeId)}`;

const DEFAULT_UNIVERSE = [
  // Weekly indexes first
  'NIFTY',
  'BANKNIFTY',
  'SENSEX',
  // Top liquid OPTSTK — daily intraday OI (monthly expiry, high premium turnover)
  'RELIANCE',
  'HDFCBANK',
  'ICICIBANK',
  'SBIN',
  'INFY',
  'TCS',
  'BHARTIARTL',
  'AXISBANK',
  'BAJFINANCE',
  'KOTAKBANK',
  'ITC',
  'LT',
  'NTPC',
  'M&M',
  'TATASTEEL',
  'TMPV',
  'HCLTECH',
  'SUNPHARMA',
  'MARUTI',
  'ADANIENT',
  'BEL',
  'TITAN',
  'POWERGRID',
  'ONGC',
  'JSWSTEEL',
  'HINDALCO',
  'WIPRO',
  'TECHM',
  'DLF',
  'HAL',
  'COALINDIA',
  'HINDUNILVR',
  'ASIANPAINT',
];

const POLL_INTERVAL_MS = 2500;
const POSITION_POLL_MS = 1000;
/** Near Dhan's ~4s option-chain floor — shared across paper engines. */
const SYMBOL_SCAN_GAP_MS = 4200;
const FUT_PRICE_REFRESH_MIN_GAP_MS = 1200;
/** Reuse last good FUT when Dhan REST/WS blips (scan / recompute). */
const FUT_STALE_MAX_AGE_MS = 90_000;
/** Slightly longer window at fill so STRONG entries are not dropped on a single miss. */
const FUT_STALE_ENTRY_MAX_AGE_MS = 120_000;
const FUT_BATCH_SIZE = 3;
/** Indexes stay fresher — their OI age is weighted higher when picking next scan. */
const INDEX_OI_AGE_WEIGHT = 2.8;
const STATUS_MARK_REFRESH_MIN_GAP_MS = 750;
const MARK_DB_PERSIST_MIN_GAP_MS = 2000;
const LIVE_MARK_EMIT_MIN_GAP_MS = 100;
const TICK_FRESH_MAX_AGE_MS = 20000;
const MIN_HOLD_MS = 2000;
const DEFAULT_TRADE_FROM = 560;
const DEFAULT_TRADE_TO = 910;
const DEFAULT_EOD = 920;
/** Index option premium exits (NIFTY / BANKNIFTY / SENSEX). */
const DEFAULT_TARGET_POINTS_INDEX = 8;
const DEFAULT_STOP_POINTS_INDEX = 10;
/** Stock option premium exits — tighter absolute pts (slower premium). */
const DEFAULT_TARGET_POINTS_STOCK = 3;
const DEFAULT_STOP_POINTS_STOCK = 5;
/** @deprecated aliases kept for older saved wallets / UI payloads */
const DEFAULT_TARGET_POINTS = DEFAULT_TARGET_POINTS_INDEX;
const DEFAULT_STOP_POINTS = DEFAULT_STOP_POINTS_INDEX;
const DEFAULT_MIN_OI_RATIO = 1.5;
const DEFAULT_PROXIMITY_POINTS_INDEX = 15;
const DEFAULT_PROXIMITY_PCT_STOCK = 0.35;
const OI_BOARD_LOOKAROUND = 10;

const engineState = {
  running: false,
  startedAt: null,
  settings: {
    lotCount: 1,
    tradeFromTime: '09:20',
    tradeToTime: '15:10',
    eodExitTime: '15:20',
    targetPointsIndex: DEFAULT_TARGET_POINTS_INDEX,
    stopLossPointsIndex: DEFAULT_STOP_POINTS_INDEX,
    hasStopLossIndex: true,
    targetPointsStock: DEFAULT_TARGET_POINTS_STOCK,
    stopLossPointsStock: DEFAULT_STOP_POINTS_STOCK,
    hasStopLossStock: true,
    // Legacy mirrors (index) for older clients
    targetPoints: DEFAULT_TARGET_POINTS_INDEX,
    stopLossPoints: DEFAULT_STOP_POINTS_INDEX,
    hasStopLoss: true,
    minOiRatio: DEFAULT_MIN_OI_RATIO,
    proximityPointsIndex: DEFAULT_PROXIMITY_POINTS_INDEX,
    proximityPctStock: DEFAULT_PROXIMITY_PCT_STOCK,
    maxTradesPerDay: 8,
    cooldownMinutes: 3,
    perTradeCost: 100,
    universe: [...DEFAULT_UNIVERSE],
  },
  symbols: {},
  scanOrder: [...DEFAULT_UNIVERSE],
  scanCursor: 0,
  futRefreshCursor: 0,
  lastScanAt: 0,
  /** @type {Set<string>} */
  openTradeIds: new Set(),
  /** symbol -> tradeId (at most one open per underlying) */
  openTradeIdBySymbol: {},
  /** tradeId -> lite */
  openTradeLites: {},
  /** tradeId -> mark */
  openPositionMarks: {},
  /** tradeId -> { ltp, ts } */
  lastOptionTicks: {},
  /** @deprecated single-slot aliases kept for older UI/status readers */
  openTradeId: null,
  openTradeLite: null,
  openPositionMark: null,
  lastOptionTick: null,
  tradesTodayCount: 0,
  tradesTodayDateKey: null,
  lastExitAtMs: 0,
  lastError: null,
  lastEntryDebug: null,
  pollTimer: null,
  positionPollTimer: null,
  /** tradeIds currently finalizing exit */
  closingTradeIds: new Set(),
  enteringTrade: false,
  evaluatingEntry: false,
  lastMarkPersistAt: 0,
  lastLiveMarkEmitAt: 0,
  liveMarkEmitTimer: null,
};

function logLine(line, payload = {}) {
  const entry = { at: new Date().toISOString(), line, ...payload };
  engineState.lastEntryDebug = entry;
  console.log(`[OiUniverseScanner] ${line}`, JSON.stringify(entry));
}

function ensureSymbolSlot(symbol) {
  const key = String(symbol || '').toUpperCase();
  if (!engineState.symbols[key]) {
    engineState.symbols[key] = {
      symbol: key,
      kind: PRESET_SYMBOLS[key]?.instrument === 'EQUITY' ? 'STOCK' : 'INDEX',
      lastFut: null,
      futExpiry: null,
      futInstrument: null,
      lastFutFetchAt: 0,
      expiry: null,
      board: null,
      signal: null,
      lastOiAt: 0,
      lastError: null,
      lotSize: null,
      lastSignalNotifKey: null,
    };
  }
  return engineState.symbols[key];
}

/** Only drop symbols that are gone / renamed in the master (not liquid names). */
const RETIRED_UNIVERSE = new Set([
  'TATAMOTORS', // renamed → TMPV
]);

function normalizeUniverse(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const out = [];
  for (const item of list) {
    let sym = String(item || '').trim().toUpperCase();
    if (sym === 'TATAMOTORS') sym = 'TMPV';
    if (!sym || !PRESET_SYMBOLS[sym]) continue;
    if (RETIRED_UNIVERSE.has(sym)) continue;
    if (!out.includes(sym)) out.push(sym);
  }
  return out.length ? out : [...DEFAULT_UNIVERSE];
}

/** Prefer indexes + merge any newly added default names into older saved settings. */
function migrateUniverseSettings(settings = {}) {
  const next = { ...settings };
  if (next.universe != null) {
    let normalized = normalizeUniverse(next.universe);
    // If saved list is only the old tiny index set, expand to full liquid default.
    const onlyIndexes =
      normalized.length > 0
      && normalized.length <= 3
      && normalized.every((s) => PRESET_SYMBOLS[s]?.instrument === 'INDEX');
    if (onlyIndexes) {
      normalized = [...DEFAULT_UNIVERSE];
    }
    next.universe = normalized;
  }
  return next;
}

function parseExitPointsField(raw, defaultPts) {
  if (raw === '' || raw === null || raw === undefined) {
    return { hasStopLoss: false, points: null };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { hasStopLoss: false, points: null };
  }
  return { hasStopLoss: true, points: Math.min(500, n) };
}

function parseTargetPointsField(raw, defaultPts) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(500, n);
  return defaultPts;
}

function normalizeSettings(settings = {}) {
  // Legacy single pair → index (stocks get dedicated defaults, not the old shared 8/10).
  const legacyTarget = parseTargetPointsField(
    settings.targetPoints ?? settings.targetPct,
    DEFAULT_TARGET_POINTS_INDEX,
  );
  const legacySl = Object.prototype.hasOwnProperty.call(settings, 'stopLossPoints')
    ? parseExitPointsField(settings.stopLossPoints, DEFAULT_STOP_POINTS_INDEX)
    : { hasStopLoss: true, points: DEFAULT_STOP_POINTS_INDEX };

  const targetPointsIndex = parseTargetPointsField(
    settings.targetPointsIndex ?? legacyTarget,
    DEFAULT_TARGET_POINTS_INDEX,
  );
  const slIndex = Object.prototype.hasOwnProperty.call(settings, 'stopLossPointsIndex')
    ? parseExitPointsField(settings.stopLossPointsIndex, DEFAULT_STOP_POINTS_INDEX)
    : Object.prototype.hasOwnProperty.call(settings, 'stopLossPoints')
      ? legacySl
      : { hasStopLoss: true, points: DEFAULT_STOP_POINTS_INDEX };

  const targetPointsStock = parseTargetPointsField(
    settings.targetPointsStock,
    DEFAULT_TARGET_POINTS_STOCK,
  );
  const slStock = Object.prototype.hasOwnProperty.call(settings, 'stopLossPointsStock')
    ? parseExitPointsField(settings.stopLossPointsStock, DEFAULT_STOP_POINTS_STOCK)
    : { hasStopLoss: true, points: DEFAULT_STOP_POINTS_STOCK };

  return {
    lotCount: Math.max(1, Number(settings.lotCount) || 1),
    tradeFromTime: String(settings.tradeFromTime || '09:20'),
    tradeToTime: String(settings.tradeToTime || '15:10'),
    eodExitTime: String(settings.eodExitTime || '15:20'),
    targetPointsIndex,
    stopLossPointsIndex: slIndex.points,
    hasStopLossIndex: slIndex.hasStopLoss,
    targetPointsStock,
    stopLossPointsStock: slStock.points,
    hasStopLossStock: slStock.hasStopLoss,
    // Legacy mirrors (index)
    targetPoints: targetPointsIndex,
    stopLossPoints: slIndex.points,
    hasStopLoss: slIndex.hasStopLoss,
    minOiRatio: Math.max(1.2, Math.min(3, Number(settings.minOiRatio) || DEFAULT_MIN_OI_RATIO)),
    proximityPointsIndex: Math.max(
      5,
      Number(settings.proximityPointsIndex ?? settings.proximityPoints) || DEFAULT_PROXIMITY_POINTS_INDEX,
    ),
    proximityPctStock: Math.max(
      0.1,
      Math.min(2, Number(settings.proximityPctStock) || DEFAULT_PROXIMITY_PCT_STOCK),
    ),
    maxTradesPerDay: Math.max(1, Math.min(50, Math.floor(Number(settings.maxTradesPerDay) || 8))),
    cooldownMinutes: Math.max(0, Math.min(60, Number(settings.cooldownMinutes) || 3)),
    perTradeCost:
      Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
        ? Number(settings.perTradeCost)
        : 100,
    universe: normalizeUniverse(settings.universe),
  };
}

function isIndexSymbol(symbol) {
  return PRESET_SYMBOLS[String(symbol || '').toUpperCase()]?.instrument === 'INDEX';
}

/** Resolve TG/SL points for a symbol from current settings. */
function resolveExitPointsForSymbol(symbol) {
  const s = engineState.settings;
  if (isIndexSymbol(symbol)) {
    return {
      profile: 'INDEX',
      targetPoints: s.targetPointsIndex,
      hasStopLoss: s.hasStopLossIndex,
      stopLossPoints: s.stopLossPointsIndex,
    };
  }
  return {
    profile: 'STOCK',
    targetPoints: s.targetPointsStock,
    hasStopLoss: s.hasStopLossStock,
    stopLossPoints: s.stopLossPointsStock,
  };
}

/** Hard-set target/SL premiums from entry using current profile settings. */
function applyExitPointsFromEntry(trade, exitPts) {
  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return false;
  const targetPoints = Number(exitPts.targetPoints);
  trade.targetPremium = Number((entry + targetPoints).toFixed(2));
  trade.targetMode = 'POINTS';
  if (exitPts.hasStopLoss && Number.isFinite(Number(exitPts.stopLossPoints)) && Number(exitPts.stopLossPoints) > 0) {
    trade.stopLossPremium = Number(Math.max(0.05, entry - Number(exitPts.stopLossPoints)).toFixed(2));
    trade.stopLossMode = 'POINTS';
  } else {
    trade.stopLossPremium = null;
    trade.stopLossMode = null;
  }
  return true;
}

/** Re-apply index/stock TG-SL to all open paper trades (from each entry). */
async function reapplyExitPointsToOpenTrade({ reason = 'SETTINGS' } = {}) {
  const ids = [...engineState.openTradeIds];
  if (!ids.length && engineState.openTradeId) ids.push(engineState.openTradeId);
  if (!ids.length) return { ok: true, updated: 0 };
  let updated = 0;
  for (const id of ids) {
    const trade = await LivePaperTrade.findById(id);
    if (!trade || trade.exitTime) continue;
    const exitPts = resolveExitPointsForSymbol(trade.symbol);
    const before = {
      targetPremium: trade.targetPremium,
      stopLossPremium: trade.stopLossPremium,
    };
    if (!applyExitPointsFromEntry(trade, exitPts)) continue;
    const sameTarget = Number(before.targetPremium) === Number(trade.targetPremium);
    const sameSl =
      (before.stopLossPremium == null && trade.stopLossPremium == null)
      || Number(before.stopLossPremium) === Number(trade.stopLossPremium);
    if (sameTarget && sameSl) {
      cacheOpenTradeLite(trade);
      continue;
    }
    const noteBit = `exits_reapplied=${reason}; ${exitPts.profile} tg=${exitPts.targetPoints} sl=${exitPts.hasStopLoss ? exitPts.stopLossPoints : 'off'}`;
    trade.notes = [trade.notes, noteBit].filter(Boolean).join(' | ').slice(0, 500);
    await trade.save();
    cacheOpenTradeLite(trade);
    updated += 1;
    logLine('EXITS_REAPPLIED', {
      tradeId: trade._id.toString(),
      symbol: trade.symbol,
      profile: exitPts.profile,
      entry: trade.entryPremium,
      before,
      targetPremium: trade.targetPremium,
      stopLossPremium: trade.stopLossPremium,
      reason,
    });
  }
  return { ok: true, updated };
}

function tradeFromMin() {
  return parseClockMinutes(engineState.settings.tradeFromTime, DEFAULT_TRADE_FROM);
}
function tradeToMin() {
  return parseClockMinutes(engineState.settings.tradeToTime, DEFAULT_TRADE_TO);
}
function eodMin() {
  return parseClockMinutes(engineState.settings.eodExitTime, DEFAULT_EOD);
}

function proximityLimit(slot, price) {
  if (slot.kind === 'INDEX') return engineState.settings.proximityPointsIndex;
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 20;
  return Math.max(5, Number((p * (engineState.settings.proximityPctStock / 100)).toFixed(1)));
}

function pickDominantStrike(snapshot, minRatio) {
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  if (!strikes.length) return null;
  let best = null;
  let bestScore = -1;
  for (const row of strikes) {
    const callOi = Number(row.callOi) || 0;
    const putOi = Number(row.putOi) || 0;
    const total = callOi + putOi;
    if (total <= 0) continue;
    const dist = Number(row.distanceFromAtm);
    const nearBoost = Number.isFinite(dist) ? Math.max(0.55, 1 - Math.min(dist, 800) / 1600) : 0.7;
    const score = total * nearBoost;
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  if (!best) return null;
  const callOi = Number(best.callOi) || 0;
  const putOi = Number(best.putOi) || 0;
  const putDom = putOi >= callOi;
  const ratio = putDom
    ? (callOi > 0 ? putOi / callOi : putOi > 0 ? 99 : 0)
    : (putOi > 0 ? callOi / putOi : callOi > 0 ? 99 : 0);
  return {
    levelStrike: Number(best.strike),
    dominantSide: putDom ? 'PUT' : 'CALL',
    optionType: putDom ? 'CE' : 'PE',
    putOi,
    callOi,
    putChgOi: best.putChgOi,
    callChgOi: best.callChgOi,
    ratio: Number(ratio.toFixed(2)),
    ratioOk: ratio >= minRatio,
  };
}

function isDeltaFighting(optionType, putChg, callChg) {
  const p = Number(putChg);
  const c = Number(callChg);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return false;
  if (optionType === 'CE') return c > 0 && c > p * 1.15;
  return p > 0 && p > c * 1.15;
}

async function ensureFutInstrument(slot) {
  const today = getIstClock(new Date()).dateKey;
  const cached = slot.futInstrument;
  if (cached?.securityId && slot.futExpiry && String(slot.futExpiry) >= today) {
    return cached;
  }
  const expiries = await listFutureExpiries(slot.symbol);
  if (!Array.isArray(expiries) || !expiries.length) {
    throw new Error(`No FUT for ${slot.symbol}`);
  }
  const inst = await resolveFutureInstrument({ symbol: slot.symbol, expiry: expiries[0].expiry });
  slot.futInstrument = inst;
  slot.futExpiry = inst.expiry;
  return inst;
}

function isFutLtpUnavailableError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('future ltp unavailable')
    || msg.includes('fut ltp unavailable')
    || msg.includes('no rest or ws')
  );
}

async function refreshFutPrice(slot, { force = false, allowStale = true, staleMaxAgeMs = FUT_STALE_MAX_AGE_MS } = {}) {
  const now = Date.now();
  if (!force && Number.isFinite(slot.lastFut) && now - slot.lastFutFetchAt < FUT_PRICE_REFRESH_MIN_GAP_MS) {
    return slot.lastFut;
  }
  try {
    const inst = await ensureFutInstrument(slot);
    const { ltp } = await getFutureLtp({ symbol: slot.symbol, expiry: inst.expiry });
    if (!Number.isFinite(ltp) || ltp <= 0) throw new Error(`FUT LTP unavailable for ${slot.symbol}`);
    slot.lastFut = Number(ltp);
    slot.lastFutFetchAt = now;
    return slot.lastFut;
  } catch (err) {
    const ageMs = now - (Number(slot.lastFutFetchAt) || 0);
    const canReuse =
      allowStale
      && Number.isFinite(slot.lastFut)
      && slot.lastFut > 0
      && ageMs <= staleMaxAgeMs;
    if (canReuse) {
      logLine('FUT_STALE_REUSE', {
        symbol: slot.symbol,
        lastFut: slot.lastFut,
        ageMs,
        err: err.message || String(err),
      });
      return slot.lastFut;
    }
    throw err;
  }
}

function buildBoard(snapshot, fut, expiry, futExpiry) {
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  let maxCall = null;
  let maxPut = null;
  let maxTotal = null;
  let callChgSum = 0;
  let putChgSum = 0;
  let sawCallChg = false;
  let sawPutChg = false;
  for (const row of strikes) {
    const c = Number(row.callOi) || 0;
    const p = Number(row.putOi) || 0;
    if (!maxCall || c > (Number(maxCall.callOi) || 0)) maxCall = row;
    if (!maxPut || p > (Number(maxPut.putOi) || 0)) maxPut = row;
    if (!maxTotal || c + p > ((Number(maxTotal.callOi) || 0) + (Number(maxTotal.putOi) || 0))) {
      maxTotal = row;
    }
    if (Number.isFinite(Number(row.callChgOi))) {
      callChgSum += Number(row.callChgOi);
      sawCallChg = true;
    }
    if (Number.isFinite(Number(row.putChgOi))) {
      putChgSum += Number(row.putChgOi);
      sawPutChg = true;
    }
  }
  const callOi = Number(snapshot?.totals?.callOi);
  const putOi = Number(snapshot?.totals?.putOi);
  const pcr = Number(snapshot?.totals?.pcr ?? snapshot?.pcr);
  const nearPcr = Number(snapshot?.totals?.nearPcr ?? snapshot?.nearPcr);
  let pcrBias = 'NEUTRAL';
  if (Number.isFinite(nearPcr)) {
    if (nearPcr >= 1.1) pcrBias = 'PUT_HEAVY';
    else if (nearPcr <= 0.9) pcrBias = 'CALL_HEAVY';
  }
  return {
    at: new Date().toISOString(),
    priceSource: 'FUT',
    spot: Number.isFinite(fut) ? fut : snapshot?.spot ?? null,
    fut: Number.isFinite(fut) ? fut : snapshot?.spot ?? null,
    futExpiry: futExpiry || null,
    chainSpot: snapshot?.chainSpot ?? snapshot?.spot ?? null,
    atm: snapshot?.atm ?? null,
    expiry: expiry || null,
    strikeStep: snapshot?.strikeStep ?? null,
    strikes,
    totals: {
      callOi: Number.isFinite(callOi) ? callOi : null,
      putOi: Number.isFinite(putOi) ? putOi : null,
      callChgOi: sawCallChg ? Math.round(callChgSum) : null,
      putChgOi: sawPutChg ? Math.round(putChgSum) : null,
      totalChgOi: (sawCallChg || sawPutChg)
        ? Math.round((sawCallChg ? callChgSum : 0) + (sawPutChg ? putChgSum : 0))
        : null,
      pcr: Number.isFinite(pcr) ? pcr : null,
      nearPcr: Number.isFinite(nearPcr) ? nearPcr : null,
      pcrBias,
    },
    highlight: {
      maxPutStrike: maxPut?.strike ?? null,
      maxCallStrike: maxCall?.strike ?? null,
      maxTotalStrike: maxTotal?.strike ?? null,
    },
  };
}

function isTransientOiError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return (
    msg.includes('429')
    || msg.includes('rate')
    || msg.includes('cooldown')
    || msg.includes('empty')
    || msg.includes('timeout')
    || msg.includes('econn')
    || msg.includes('temporarily')
    || msg.includes('stale')
    || isFutLtpUnavailableError(err)
  );
}

function scoreReady(signal) {
  if (!signal || signal.status !== 'STRONG_READY') return -1;
  const ratio = Number(signal.ratio) || 0;
  const dist = Number(signal.spotDist);
  const prox = Number(signal.proximityLimit) || 1;
  const distScore = Number.isFinite(dist) ? Math.max(0, 1 - dist / prox) : 0;
  return ratio * 10 + distScore * 5;
}

function publishUniverseSignalNotification(symbol, prev, next) {
  if (!next || !next.status) return;
  const slot = ensureSymbolSlot(symbol);
  const key = [
    symbol,
    next.status,
    next.optionType || '',
    next.levelStrike || '',
    next.reason || '',
  ].join(':');
  if (key === slot.lastSignalNotifKey) return;
  slot.lastSignalNotifKey = key;

  const status = String(next.status || '');
  if (status === 'ERROR' || status === 'CLEARED') {
    if (prev?.status === status) return;
    // Never alert on infra / cold-start clears (FUT miss, scan fail).
    const reason = String(next.reason || '');
    if (reason === 'FUT_UNAVAILABLE' || reason === 'SCAN_FAILED') return;
    // Only clear-notify when a real setup disappears.
    const prevWasLive = ['STRONG_READY', 'WATCHING', 'CAUTION'].includes(String(prev?.status || ''));
    if (!prevWasLive) return;
  }

  const notable =
    status === 'STRONG_READY'
    || status === 'CAUTION'
    || status === 'WATCHING'
    || status === 'CLEARED';

  if (!notable) return;

  const wallChanged =
    prev
    && (String(prev.optionType) !== String(next.optionType)
      || Number(prev.levelStrike) !== Number(next.levelStrike));
  if (status === 'WATCHING' && prev?.status === 'WATCHING' && !wallChanged) return;

  let type = 'OI_SIGNAL';
  let title = next.label || `${symbol} ${status}`;
  if (status === 'STRONG_READY') {
    type = 'SIGNAL_READY';
    title = next.label || `STRONG ${next.optionType} · ${symbol} ${next.levelStrike}`;
  } else if (status === 'CAUTION') {
    type = 'SIGNAL_CAUTION';
  } else if (status === 'CLEARED') {
    type = 'SIGNAL_CLEARED';
    title = next.label || `${symbol} signal cleared`;
  } else if (wallChanged) {
    type = 'SIGNAL_CHANGED';
    title = next.label || `${symbol} → ${next.optionType} · ${next.levelStrike}`;
  }

  pushNotification({
    type,
    strategy: 'OI Universe',
    title: String(title).slice(0, 160),
    body: String(next.detail || next.reason || '').slice(0, 400),
    meta: {
      symbol,
      status: next.status,
      optionType: next.optionType,
      levelStrike: next.levelStrike,
      ratio: next.ratio,
      spotDist: next.spotDist,
    },
    dedupeKey: `oi-universe-signal:${symbol}:${key}`,
  });
}

function applySignalUpdate(slot, prev, next) {
  slot.signal = next;
  publishUniverseSignalNotification(slot.symbol, prev, next);
}

function recomputeSignalFromFut(slot) {
  const prev = slot.signal ? { ...slot.signal } : null;
  const signal = slot.signal;
  const fut = slot.lastFut;
  if (!signal || !Number.isFinite(fut) || !Number.isFinite(Number(signal.levelStrike))) return;
  if (!signal.ratioOk || signal.deltaOk === false) return;

  const dist = Math.abs(fut - Number(signal.levelStrike));
  const prox = proximityLimit(slot, fut);
  const proximityOk = dist <= prox;
  const base = {
    ...signal,
    fut,
    spotDist: Number(dist.toFixed(1)),
    proximityLimit: prox,
    proximityOk,
    at: new Date().toISOString(),
  };

  if (!proximityOk) {
    applySignalUpdate(slot, prev, {
      ...base,
      status: 'WATCHING',
      label: `Watch ${signal.optionType} · wall ${signal.levelStrike}`,
      reason: 'WAIT_PROXIMITY',
      buyLive: false,
      detail: `FUT ${dist.toFixed(0)} > ${prox} · waiting proximity`,
    });
    return;
  }

  applySignalUpdate(slot, prev, {
    ...base,
    status: 'STRONG_READY',
    label: `STRONG ${signal.optionType} · ${signal.levelStrike}`,
    reason: 'STRONG_READY',
    buyLive: true,
    detail: `Ratio ${signal.ratio}× · FUT ${dist.toFixed(0)} ≤ ${prox}`,
  });
}

async function refreshFutBatch() {
  const order = engineState.scanOrder;
  if (!order.length) return;
  const batch = Math.min(FUT_BATCH_SIZE, order.length);
  const tasks = [];
  for (let i = 0; i < batch; i += 1) {
    const symbol = order[(engineState.futRefreshCursor + i) % order.length];
    tasks.push((async () => {
      const slot = ensureSymbolSlot(symbol);
      try {
        await refreshFutPrice(slot, { force: true });
        if (slot.board) {
          slot.board = {
            ...slot.board,
            fut: slot.lastFut,
            spot: slot.lastFut,
            at: new Date().toISOString(),
          };
        }
        if (slot.signal?.levelStrike && slot.signal.status !== 'CLEARED') {
          recomputeSignalFromFut(slot);
        }
      } catch (err) {
        slot.lastError = err.message || 'FUT refresh failed';
      }
    })());
  }
  engineState.futRefreshCursor = (engineState.futRefreshCursor + batch) % order.length;
  await Promise.allSettled(tasks);
}

async function scanOneSymbol(symbol) {
  const slot = ensureSymbolSlot(symbol);
  const prevSignal = slot.signal ? { ...slot.signal } : null;
  try {
    let fut = null;
    let priceSource = 'FUT';
    try {
      fut = await refreshFutPrice(slot, { force: true });
    } catch (futErr) {
      // Cold start / FUT blip with no cache — fall through to option-chain last_price.
      slot.lastError = futErr.message || 'FUT unavailable';
    }

    const expiry = await getNearestWeeklyExpiry(symbol);
    if (!expiry) throw new Error(`No option expiry for ${symbol}`);
    slot.expiry = expiry;
    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      spotOverride: Number.isFinite(fut) ? fut : null,
      lookaroundStrikes: OI_BOARD_LOOKAROUND,
    });
    if (!Array.isArray(snapshot?.strikes) || snapshot.strikes.length === 0) {
      throw new Error(`Empty OI chain for ${symbol}`);
    }

    if (!Number.isFinite(fut) || fut <= 0) {
      const chainSpot = Number(snapshot?.spot ?? snapshot?.chainSpot ?? snapshot?.atm);
      if (!Number.isFinite(chainSpot) || chainSpot <= 0) {
        throw new Error('Future LTP unavailable (no REST or WS data yet)');
      }
      fut = chainSpot;
      priceSource = 'CHAIN';
      // Seed FUT cache so later entry/proximity can reuse without another hard fail.
      slot.lastFut = chainSpot;
      slot.lastFutFetchAt = Date.now();
      logLine('FUT_CHAIN_SPOT_FALLBACK', { symbol, spot: chainSpot });
    }

    slot.board = buildBoard(snapshot, fut, expiry, slot.futExpiry);
    if (slot.board) slot.board.priceSource = priceSource;
    slot.lastOiAt = Date.now();
    slot.lastError = null;

    const wall = pickDominantStrike(snapshot, engineState.settings.minOiRatio);
    if (!wall) {
      // Only notify clear when a prior live signal actually goes away.
      const hadLive =
        prevSignal
        && ['STRONG_READY', 'WATCHING', 'CAUTION'].includes(String(prevSignal.status || ''));
      if (hadLive) {
        applySignalUpdate(slot, prevSignal, {
          status: 'CLEARED',
          label: 'No wall',
          reason: 'NO_WALL',
          buyLive: false,
          symbol,
        });
      } else {
        slot.signal = { status: 'CLEARED', label: 'No wall', buyLive: false, symbol };
      }
      return slot;
    }

    const dist = Math.abs(fut - wall.levelStrike);
    const prox = proximityLimit(slot, fut);
    const proximityOk = dist <= prox;
    const deltaOk = !isDeltaFighting(wall.optionType, wall.putChgOi, wall.callChgOi);
    const pxLabel = priceSource === 'CHAIN' ? 'SPOT' : 'FUT';
    const base = {
      symbol,
      kind: slot.kind,
      optionType: wall.optionType,
      levelStrike: wall.levelStrike,
      dominantSide: wall.dominantSide,
      putOi: wall.putOi,
      callOi: wall.callOi,
      putChgOi: wall.putChgOi,
      callChgOi: wall.callChgOi,
      ratio: wall.ratio,
      ratioOk: wall.ratioOk,
      minOiRatio: engineState.settings.minOiRatio,
      fut,
      priceSource,
      spotDist: Number(dist.toFixed(1)),
      proximityLimit: prox,
      proximityOk,
      deltaOk,
      buyLive: false,
      at: new Date().toISOString(),
    };

    if (!wall.ratioOk) {
      applySignalUpdate(slot, prevSignal, {
        ...base,
        status: 'CAUTION',
        label: `Weak wall · ${wall.optionType} ${wall.levelStrike}`,
        reason: 'WEAK_OI_RATIO',
        detail: `Ratio ${wall.ratio}× < ${engineState.settings.minOiRatio}×`,
      });
      return slot;
    }
    if (!deltaOk) {
      applySignalUpdate(slot, prevSignal, {
        ...base,
        status: 'CAUTION',
        label: `ΔOI fighting · ${wall.optionType} ${wall.levelStrike}`,
        reason: 'DELTA_OI_FIGHTING',
        detail: 'DELTA_OI_FIGHTING',
      });
      return slot;
    }
    if (!proximityOk) {
      applySignalUpdate(slot, prevSignal, {
        ...base,
        status: 'WATCHING',
        label: `Watch ${wall.optionType} · wall ${wall.levelStrike}`,
        reason: 'WAIT_PROXIMITY',
        detail: `${pxLabel} ${dist.toFixed(0)} > ${prox} · waiting proximity`,
      });
      return slot;
    }

    applySignalUpdate(slot, prevSignal, {
      ...base,
      status: 'STRONG_READY',
      label: `STRONG ${wall.optionType} · ${wall.levelStrike}`,
      reason: 'STRONG_READY',
      buyLive: true,
      detail: `Ratio ${wall.ratio}× ≥ ${engineState.settings.minOiRatio} · ${pxLabel} ${dist.toFixed(0)} ≤ ${prox}`,
    });
    return slot;
  } catch (err) {
    const msg = err.message || 'Scan failed';
    // Keep last good board/signal on Dhan rate-limit / FUT blips — never re-notify
    // as STRONG/WATCH with an error body (that was spamming "Future LTP unavailable").
    if (isTransientOiError(err) && (slot.board || Number.isFinite(slot.lastFut))) {
      slot.lastError = msg;
      return slot;
    }
    // Still try to keep FUT on the card even when chain fails hard.
    try {
      if (!Number.isFinite(slot.lastFut)) await refreshFutPrice(slot, { force: false });
    } catch {
      /* ignore */
    }
    slot.lastError = msg;
    // If we already have a board, keep the prior signal as-is (no fake STRONG+error alert).
    if (slot.board && slot.signal && slot.signal.status !== 'ERROR') {
      if (slot.signal.buyLive && !Number.isFinite(slot.lastFut)) {
        slot.signal = { ...slot.signal, buyLive: false };
      }
      return slot;
    }
    // Cold infra failures: quiet state only — do not spam SIGNAL_CLEARED with FUT errors.
    if (isFutLtpUnavailableError(err) || isTransientOiError(err)) {
      slot.signal = {
        status: 'CLEARED',
        label: 'Waiting for OI',
        reason: isFutLtpUnavailableError(err) ? 'FUT_UNAVAILABLE' : 'SCAN_FAILED',
        detail: msg,
        buyLive: false,
        symbol,
        fut: slot.lastFut,
      };
      return slot;
    }
    applySignalUpdate(slot, prevSignal, {
      status: 'CLEARED',
      label: 'Waiting for OI',
      reason: 'SCAN_FAILED',
      detail: msg,
      buyLive: false,
      symbol,
      fut: slot.lastFut,
    });
    return slot;
  }
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      strategy13EngineSettings: engineState.settings,
    });
  }
  return wallet;
}

async function syncTradesToday(clock) {
  if (engineState.tradesTodayDateKey !== clock.dateKey) {
    engineState.tradesTodayDateKey = clock.dateKey;
    engineState.tradesTodayCount = 0;
  }
  const count = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });
  engineState.tradesTodayCount = count;
  const opens = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).sort({ entryTime: 1 });

  const nextIds = new Set();
  const nextBySymbol = {};
  for (const trade of opens) {
    const id = trade._id.toString();
    const sym = String(trade.symbol || '').toUpperCase();
    // Keep earliest open per symbol if duplicates somehow exist.
    if (nextBySymbol[sym]) continue;
    nextBySymbol[sym] = id;
    nextIds.add(id);
    cacheOpenTradeLite(trade);
  }

  // Drop stale in-memory slots.
  for (const id of [...engineState.openTradeIds]) {
    if (!nextIds.has(id)) detachOpenTrade(id);
  }
  engineState.openTradeIds = nextIds;
  engineState.openTradeIdBySymbol = nextBySymbol;
  syncLegacyOpenAliases();
}

function syncLegacyOpenAliases() {
  const firstId = [...engineState.openTradeIds][0] || null;
  engineState.openTradeId = firstId;
  engineState.openTradeLite = firstId ? engineState.openTradeLites[firstId] || null : null;
  engineState.openPositionMark = firstId ? engineState.openPositionMarks[firstId] || null : null;
  engineState.lastOptionTick = firstId ? engineState.lastOptionTicks[firstId] || null : null;
}

function hasOpenOnSymbol(symbol) {
  const sym = String(symbol || '').toUpperCase();
  return Boolean(engineState.openTradeIdBySymbol[sym]);
}

function cacheOpenTradeLite(trade) {
  if (!trade) return;
  const id = trade._id?.toString?.() || String(trade._id);
  const sym = String(trade.symbol || '').toUpperCase();
  engineState.openTradeLites[id] = {
    _id: id,
    symbol: trade.symbol,
    optionType: trade.optionType,
    strike: trade.strike,
    expiryDate: trade.expiryDate,
    entryPremium: trade.entryPremium,
    qty: trade.qty,
    lots: trade.lots,
    targetPremium: trade.targetPremium,
    stopLossPremium: trade.stopLossPremium,
    entryTime: trade.entryTime,
    entryDateKey: trade.entryDateKey,
    kind: isIndexSymbol(sym) ? 'INDEX' : 'STOCK',
  };
  engineState.openTradeIds.add(id);
  if (!engineState.openTradeIdBySymbol[sym]) {
    engineState.openTradeIdBySymbol[sym] = id;
  }
  syncLegacyOpenAliases();
}

function detachOpenTrade(tradeId) {
  const id = String(tradeId);
  const lite = engineState.openTradeLites[id];
  const sym = String(lite?.symbol || '').toUpperCase();
  engineState.openTradeIds.delete(id);
  delete engineState.openTradeLites[id];
  delete engineState.openPositionMarks[id];
  delete engineState.lastOptionTicks[id];
  if (sym && engineState.openTradeIdBySymbol[sym] === id) {
    delete engineState.openTradeIdBySymbol[sym];
  }
  unsubscribeLiveSymbol(optionSubKey(id));
  syncLegacyOpenAliases();
  if (engineState.openTradeIds.size === 0 && engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function clearOpenTrade() {
  for (const id of [...engineState.openTradeIds]) detachOpenTrade(id);
  engineState.openTradeIds = new Set();
  engineState.openTradeIdBySymbol = {};
  engineState.openTradeLites = {};
  engineState.openPositionMarks = {};
  engineState.lastOptionTicks = {};
  syncLegacyOpenAliases();
}

async function subscribeOpenOption(trade) {
  const id = trade._id?.toString?.() || String(trade._id);
  try {
    const inst = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType: trade.optionType,
    });
    await subscribeLiveInstrument({
      key: optionSubKey(id),
      securityId: inst.securityId,
      exchangeSegment: inst.exchangeSegment,
      onTick: (tick) => onOptionTickForTrade(id, tick),
    });
  } catch (err) {
    engineState.lastError = `Option subscribe: ${err.message}`;
  }
}

function optionTickIsFresh(tradeId) {
  const tick = engineState.lastOptionTicks[String(tradeId)];
  const ts = tick?.ts;
  return Number.isFinite(ts) && Date.now() - ts < TICK_FRESH_MAX_AGE_MS;
}

function getLiveMarkSnapshot() {
  const marks = {};
  for (const [id, mark] of Object.entries(engineState.openPositionMarks)) {
    marks[id] = mark;
  }
  return {
    strategyId: 'strategy-11',
    open: engineState.openTradeIds.size > 0,
    openCount: engineState.openTradeIds.size,
    marks,
    mark: engineState.openPositionMark,
    openTradeLite: engineState.openTradeLite,
    openTradeLites: { ...engineState.openTradeLites },
    openTradeId: engineState.openTradeId,
    lastFut: null,
    at: new Date().toISOString(),
  };
}

function publishLiveMarkSnapshot(extra = {}) {
  const now = Date.now();
  if (now - engineState.lastLiveMarkEmitAt < LIVE_MARK_EMIT_MIN_GAP_MS) {
    if (!engineState.liveMarkEmitTimer) {
      engineState.liveMarkEmitTimer = setTimeout(() => {
        engineState.liveMarkEmitTimer = null;
        broadcast('paper-live:mark', { ...getLiveMarkSnapshot(), ...extra });
      }, LIVE_MARK_EMIT_MIN_GAP_MS);
    }
    return;
  }
  engineState.lastLiveMarkEmitAt = now;
  broadcast('paper-live:mark', { ...getLiveMarkSnapshot(), ...extra });
}

async function resolveMarkForOpenTrade(trade, { preferTicks = true, allowChain = true } = {}) {
  const id = trade._id?.toString?.() || String(trade._id);
  let optionLtp = null;
  let source = 'none';
  if (preferTicks && optionTickIsFresh(id)) {
    const tickLtp = Number(engineState.lastOptionTicks[id]?.ltp);
    if (Number.isFinite(tickLtp) && tickLtp > 0) {
      optionLtp = tickLtp;
      source = 'websocket';
    }
  }
  if ((!Number.isFinite(optionLtp) || optionLtp <= 0) && allowChain) {
    try {
      const premiums = await getAtmPremiums({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
      });
      const chainLtp = premiumFromChain(premiums, trade.optionType);
      if (Number.isFinite(chainLtp) && chainLtp > 0) {
        optionLtp = chainLtp;
        source = 'chain';
      }
    } catch {
      /* keep */
    }
  }
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) {
    const prev = Number(engineState.openPositionMarks[id]?.optionLtp);
    if (Number.isFinite(prev) && prev > 0) {
      optionLtp = prev;
      source = engineState.openPositionMarks[id]?.source || 'last';
    } else {
      const entry = Number(trade.entryPremium);
      if (Number.isFinite(entry) && entry > 0) {
        optionLtp = entry;
        source = 'entry';
      }
    }
  }
  const qty = Number(trade.qty) || 0;
  const entry = Number(trade.entryPremium) || 0;
  const unrealizedPnl =
    Number.isFinite(optionLtp) && optionLtp > 0
      ? Number(((optionLtp - entry) * qty - (Number(trade.charges) || 0)).toFixed(2))
      : null;
  return {
    optionLtp: Number.isFinite(optionLtp) && optionLtp > 0 ? optionLtp : null,
    source,
    isLiveMark: source === 'websocket',
    unrealizedPnl,
    at: new Date().toISOString(),
    tradeId: id,
  };
}

function publishOpenMark(trade, mark, { persist = false } = {}) {
  const id = trade._id?.toString?.() || String(trade._id);
  const nextLtp = Number(mark?.optionLtp);
  const prevLtp = Number(engineState.openPositionMarks[id]?.optionLtp);
  if (!(Number.isFinite(nextLtp) && nextLtp > 0) && Number.isFinite(prevLtp) && prevLtp > 0) {
    return engineState.openPositionMarks[id];
  }
  const nextMark = {
    ...mark,
    tradeId: id,
  };
  engineState.openPositionMarks[id] = nextMark;
  syncLegacyOpenAliases();
  publishLiveMarkSnapshot();
  if (persist) {
    const now = Date.now();
    if (now - engineState.lastMarkPersistAt >= MARK_DB_PERSIST_MIN_GAP_MS) {
      engineState.lastMarkPersistAt = now;
      LivePaperTrade.updateOne(
        { _id: trade._id },
        {
          $set: {
            openPositionMark: nextMark,
            openPositionMarkAt: new Date(),
          },
        },
      ).catch(() => {});
    }
  }
  return nextMark;
}

function publishTickMarkFast(tradeId, ltp) {
  const id = String(tradeId);
  const n = Number(ltp);
  if (!Number.isFinite(n) || n <= 0) return;
  const lite = engineState.openTradeLites[id];
  if (!lite) return;
  const qty = Number(lite.qty) || 0;
  const entry = Number(lite.entryPremium) || 0;
  const mark = {
    optionLtp: n,
    source: 'websocket',
    isLiveMark: true,
    unrealizedPnl: Number(((n - entry) * qty).toFixed(2)),
    at: new Date().toISOString(),
    tradeId: id,
  };
  engineState.openPositionMarks[id] = mark;
  syncLegacyOpenAliases();
  publishLiveMarkSnapshot();
}

function onOptionTickForTrade(tradeId, { ltp } = {}) {
  const id = String(tradeId);
  const n = Number(ltp);
  engineState.lastOptionTicks[id] = { ltp: n, ts: Date.now() };
  if (Number.isFinite(n) && n > 0) {
    publishTickMarkFast(id, n);
  }
  checkOpenTradeById(id, { preferTicks: true }).catch((err) => {
    engineState.lastError = `Universe tick check: ${err.message}`;
  });
}

function premiumFromChain(premiums, optionType) {
  // getAtmPremiums returns { ceLtp, peLtp } (same as Morning OI engines).
  const type = String(optionType || 'CE').toUpperCase();
  const n = type === 'PE'
    ? Number(premiums?.peLtp ?? premiums?.pe?.ltp ?? premiums?.pe)
    : Number(premiums?.ceLtp ?? premiums?.ce?.ltp ?? premiums?.ce);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function placeStrongEntry(slot, signal, clock) {
  if (engineState.enteringTrade) return;
  const symbol = slot.symbol;
  if (hasOpenOnSymbol(symbol)) {
    logLine('ENTRY_SKIP', { symbol, reason: 'ALREADY_OPEN_ON_SYMBOL' });
    return;
  }
  engineState.enteringTrade = true;
  try {
    const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    // Seed from signal if slot lost FUT (e.g. brief memory gap) but STRONG still carries fut.
    if (!Number.isFinite(slot.lastFut) && Number.isFinite(Number(signal.fut)) && Number(signal.fut) > 0) {
      slot.lastFut = Number(signal.fut);
      const signalAt = signal.at ? Date.parse(signal.at) : NaN;
      slot.lastFutFetchAt = Number.isFinite(signalAt) ? signalAt : Date.now();
    }
    let fut;
    try {
      fut = await refreshFutPrice(slot, {
        force: true,
        allowStale: true,
        staleMaxAgeMs: FUT_STALE_ENTRY_MAX_AGE_MS,
      });
    } catch (err) {
      logLine('ENTRY_SKIP', {
        symbol,
        reason: 'FUT_UNAVAILABLE',
        error: err.message || String(err),
      });
      return;
    }
    const prox = proximityLimit(slot, fut);
    const dist = Math.abs(fut - Number(signal.levelStrike));
    if (dist > prox) {
      logLine('ENTRY_SKIP', { symbol, reason: 'PROXIMITY_LOST', dist, prox });
      return;
    }

    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry: slot.expiry || (await getNearestWeeklyExpiry(symbol)),
      spotOverride: fut,
      lookaroundStrikes: OI_BOARD_LOOKAROUND,
    });
    const wall = pickDominantStrike(snapshot, engineState.settings.minOiRatio);
    if (!wall || wall.optionType !== optionType || !wall.ratioOk) {
      logLine('ENTRY_SKIP', { symbol, reason: 'WALL_LOST_AT_FILL' });
      return;
    }
    if (isDeltaFighting(optionType, wall.putChgOi, wall.callChgOi)) {
      logLine('ENTRY_SKIP', { symbol, reason: 'DELTA_AT_FILL' });
      return;
    }

    const expiry = slot.expiry || (await getNearestWeeklyExpiry(symbol));
    const strikeStep = Number(snapshot?.strikeStep) || getStrikeStep(symbol);
    const strike = pickStrike({
      entrySpot: fut,
      strikeStep,
      optionType,
      strikeMode: 'ATM',
    });
    let entryPremium = null;
    try {
      const premiums = await getAtmPremiums({ symbol, strike, expiry });
      entryPremium = premiumFromChain(premiums, optionType);
    } catch (premErr) {
      logLine('ENTRY_SKIP', {
        symbol,
        reason: 'PREMIUM_FETCH_FAILED',
        strike,
        error: premErr.message || String(premErr),
      });
    }
    // Fallback: LTP already on the OI snapshot row for this strike.
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      const row = (snapshot?.strikes || []).find((r) => Number(r.strike) === Number(strike));
      const fromSnap = optionType === 'PE' ? Number(row?.peLtp) : Number(row?.ceLtp);
      if (Number.isFinite(fromSnap) && fromSnap > 0) {
        entryPremium = fromSnap;
        logLine('ENTRY_PREMIUM_FROM_SNAPSHOT', { symbol, strike, optionType, entryPremium });
      }
    }
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `Missing ${symbol} ${optionType} premium @ ${strike}`;
      logLine('ENTRY_SKIP', {
        symbol,
        reason: 'MISSING_PREMIUM',
        strike,
        optionType,
        fut,
        expiry,
      });
      return;
    }

    const lotSize = slot.lotSize || (await getCurrentLotSize(symbol));
    slot.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 1);
    const qty = lotSize * lots;
    const charges = engineState.settings.perTradeCost;
    const exitPts = resolveExitPointsForSymbol(symbol);
    const targetPoints = exitPts.targetPoints;
    const hasSl = exitPts.hasStopLoss;
    const stopLossPoints = exitPts.stopLossPoints;
    const targetPremium = entryPremium + targetPoints;
    const stopLossPremium = hasSl ? Math.max(0.05, entryPremium - stopLossPoints) : null;

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
      entrySpot: Number(fut.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: hasSl ? 'POINTS' : null,
      targetMode: 'POINTS',
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Universe STRONG ${optionType} · ${symbol} wall ${wall.levelStrike} · ratio ${wall.ratio}×`,
      notes: `oi_universe; symbol=${symbol}; wall=${wall.levelStrike}; ratio=${wall.ratio}; profile=${exitPts.profile}; tg=${targetPoints}pts; sl=${hasSl ? `${stopLossPoints}pts` : 'off'}`,
    });

    engineState.openTradeIds.add(tradeDoc._id.toString());
    engineState.openTradeIdBySymbol[String(symbol).toUpperCase()] = tradeDoc._id.toString();
    engineState.tradesTodayCount += 1;
    engineState.tradesTodayDateKey = clock.dateKey;
    cacheOpenTradeLite(tradeDoc);
    logLine('ENTRY_SUCCESS', {
      tradeId: tradeDoc._id.toString(),
      symbol,
      optionType,
      strike,
      entryPremium,
      wall: wall.levelStrike,
      ratio: wall.ratio,
      profile: exitPts.profile,
      targetPoints,
      stopLossPoints: hasSl ? stopLossPoints : null,
      openCount: engineState.openTradeIds.size,
    });
    pushNotification({
      type: 'ENTRY',
      strategy: 'OI Universe',
      title: `Entered ${symbol} ${optionType} ${strike}`,
      body: `Strong wall ${wall.levelStrike} · ${wall.ratio}× · ${exitPts.profile} +${targetPoints}pts${hasSl ? ` / −${stopLossPoints}pts` : ''}${exitPts.profile === 'STOCK' ? ' · carry overnight' : ' · EOD'}`,
      meta: { tradeId: tradeDoc._id.toString(), symbol, optionType, strike, profile: exitPts.profile },
      dedupeKey: `oi-universe-entry:${tradeDoc._id.toString()}`,
    });
    await subscribeOpenOption(tradeDoc);
    // Seed mark immediately so UI does not show ₹0 while waiting for WS/chain.
    publishOpenMark(tradeDoc, {
      optionLtp: Number(entryPremium),
      source: 'entry',
      isLiveMark: false,
      unrealizedPnl: Number((0 - (Number(charges) || 0)).toFixed(2)),
      at: new Date().toISOString(),
    }, { persist: true });
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logLine('ENTRY_FAILED', { error: err.message });
  } finally {
    engineState.enteringTrade = false;
  }
}

async function evaluateEntry(clock) {
  if (engineState.evaluatingEntry || engineState.enteringTrade) return;
  engineState.evaluatingEntry = true;
  try {
    if (!isNseCashTradingDay(clock.dateKey)) return;
    if (clock.minutes < tradeFromMin() || clock.minutes > tradeToMin()) return;
    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) return;
    const cooldownMs = (Number(engineState.settings.cooldownMinutes) || 0) * 60 * 1000;
    if (cooldownMs > 0 && engineState.lastExitAtMs && Date.now() - engineState.lastExitAtMs < cooldownMs) {
      return;
    }

    const candidates = [];
    for (const symbol of engineState.scanOrder) {
      if (hasOpenOnSymbol(symbol)) continue; // one open per symbol
      const slot = engineState.symbols[symbol];
      const signal = slot?.signal;
      const score = scoreReady(signal);
      if (score > 0 && signal?.buyLive) candidates.push({ slot, signal, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates) {
      if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) break;
      if (hasOpenOnSymbol(c.slot.symbol)) continue;
      // eslint-disable-next-line no-await-in-loop
      await placeStrongEntry(c.slot, c.signal, clock);
    }
  } finally {
    engineState.evaluatingEntry = false;
  }
}

async function finalizeTrade(trade, { exitPremium, mark, reason }) {
  const id = trade._id.toString();
  if (engineState.closingTradeIds.has(id)) return;
  engineState.closingTradeIds.add(id);
  try {
    const safeExitPremium = Math.max(0.05, Number(exitPremium) || 0);
    const qty = Number(trade.qty) || 0;
    const entry = Number(trade.entryPremium) || 0;
    const charges = Number(trade.charges) || 0;
    const pnl = Number(((safeExitPremium - entry) * qty - charges).toFixed(2));
    const pnlPct = entry > 0 ? Number((((safeExitPremium - entry) / entry) * 100).toFixed(2)) : 0;
    const clock = getIstClock(new Date());
    trade.exitPremium = Number(safeExitPremium.toFixed(2));
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.status = 'CLOSED';
    trade.reason = reason;
    trade.pnl = pnl;
    trade.pnlPct = pnlPct;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.notes = [trade.notes, `exitMark=${mark?.source || 'n/a'}; pnl=${pnl}`]
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

    pushNotification({
      type: 'EXIT',
      strategy: 'OI Universe',
      title: `Closed ${trade.symbol} ${trade.optionType} ${trade.strike}`,
      body: `${reason} · P/L ₹${pnl} · exit ₹${safeExitPremium}`,
      meta: { tradeId: id, reason, pnl, symbol: trade.symbol },
      dedupeKey: `oi-universe-exit:${id}`,
    });
    engineState.lastExitAtMs = Date.now();
    detachOpenTrade(id);
    publishLiveMarkSnapshot({
      tradeId: id,
      closed: true,
      open: engineState.openTradeIds.size > 0,
    });
  } finally {
    engineState.closingTradeIds.delete(id);
  }
}

/** Indexes: EOD same day. Stocks: carry overnight until SL / target / expiry day EOD. */
function shouldForceTimeExit(trade, clock) {
  const expiry = String(trade.expiryDate || '').slice(0, 10);
  const isIndex = isIndexSymbol(trade.symbol);

  if (expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    if (clock.dateKey > expiry) return { exit: true, reason: 'EXPIRY' };
    if (clock.dateKey === expiry && clock.minutes >= eodMin()) {
      return { exit: true, reason: 'EXPIRY' };
    }
  }

  if (isIndex) {
    if (clock.dateKey !== trade.entryDateKey || clock.minutes >= eodMin()) {
      return { exit: true, reason: 'EOD_EXIT' };
    }
  }
  // Stocks: no EOD on entry day / carry days — only SL / TG / expiry above.
  return { exit: false };
}

async function checkOpenTradeById(tradeId, { preferTicks = false } = {}) {
  if (!engineState.running) return;
  const id = String(tradeId);
  if (engineState.closingTradeIds.has(id)) return;
  if (!engineState.openTradeIds.has(id)) return;
  const clock = getIstClock(new Date());
  const trade = await LivePaperTrade.findById(id);
  if (!trade || trade.exitTime) {
    detachOpenTrade(id);
    return;
  }
  cacheOpenTradeLite(trade);

  const force = shouldForceTimeExit(trade, clock);
  if (force.exit) {
    const mark = await resolveMarkForOpenTrade(trade, { allowChain: true });
    await finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason: force.reason });
    return;
  }

  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const mark = await resolveMarkForOpenTrade(trade, { preferTicks, allowChain: true });
  publishOpenMark(trade, mark, { persist: true });
  const ltp = Number(mark.optionLtp);
  if (!Number.isFinite(ltp) || ltp <= 0) return;

  if (Number.isFinite(Number(trade.targetPremium)) && ltp >= Number(trade.targetPremium)) {
    await finalizeTrade(trade, { exitPremium: ltp, mark, reason: 'TARGET' });
    return;
  }
  if (
    trade.stopLossPremium != null
    && Number.isFinite(Number(trade.stopLossPremium))
    && ltp <= Number(trade.stopLossPremium)
  ) {
    await finalizeTrade(trade, { exitPremium: ltp, mark, reason: 'STOP_LOSS' });
  }
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  const ids = [...engineState.openTradeIds];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await checkOpenTradeById(id, { preferTicks });
  }
}

function startPositionPoll() {
  if (engineState.positionPollTimer) clearInterval(engineState.positionPollTimer);
  const tick = () => {
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Universe exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

function pickNextScanSymbol() {
  const order = engineState.scanOrder;
  if (!order.length) return null;
  const now = Date.now();
  let best = order[0];
  let bestScore = -1;
  for (const symbol of order) {
    const slot = ensureSymbolSlot(symbol);
    const age = now - (Number(slot.lastOiAt) || 0);
    const weight = slot.kind === 'INDEX' ? INDEX_OI_AGE_WEIGHT : 1;
    const score = age * weight;
    if (score > bestScore) {
      bestScore = score;
      best = symbol;
    }
  }
  return best;
}

async function scanTick() {
  const clock = getIstClock(new Date());
  await ensureNseHolidaysLoaded();
  await syncTradesToday(clock);

  if (!engineState.scanOrder.length) {
    engineState.scanOrder = [...engineState.settings.universe];
  }

  await refreshFutBatch();

  const now = Date.now();
  if (now - engineState.lastScanAt >= SYMBOL_SCAN_GAP_MS) {
    engineState.lastScanAt = now;
    const symbol = pickNextScanSymbol();
    if (symbol) {
      engineState.scanCursor += 1;
      await scanOneSymbol(symbol);
    }
  }

  await evaluateEntry(clock);
  if (engineState.openTradeIds.size > 0) {
    await checkOpenTrade();
  }
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    scanTick().catch((err) => {
      engineState.lastError = `Universe scan: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function getEngineSnapshot() {
  const cards = engineState.scanOrder.map((symbol) => {
    const slot = engineState.symbols[symbol] || ensureSymbolSlot(symbol);
    return {
      symbol,
      kind: slot.kind,
      lastFut: slot.lastFut,
      futExpiry: slot.futExpiry,
      expiry: slot.expiry,
      board: slot.board,
      signal: slot.signal,
      lastOiAt: slot.lastOiAt,
      lastError: slot.lastError,
    };
  });
  const ready = cards
    .filter((c) => c.signal?.status === 'STRONG_READY')
    .sort((a, b) => scoreReady(b.signal) - scoreReady(a.signal));

  const openTrades = [...engineState.openTradeIds]
    .map((id) => engineState.openTradeLites[id])
    .filter(Boolean);

  return {
    running: engineState.running,
    startedAt: engineState.startedAt,
    settings: engineState.settings,
    universe: engineState.scanOrder,
    cards,
    readySymbols: ready.map((c) => c.symbol),
    topReady: ready[0] || null,
    tradesTodayCount: engineState.tradesTodayCount,
    maxTradesPerDay: engineState.settings.maxTradesPerDay,
    openCount: engineState.openTradeIds.size,
    openTradeIds: [...engineState.openTradeIds],
    openTrades,
    openPositionMarks: { ...engineState.openPositionMarks },
    openTradeId: engineState.openTradeId,
    openPositionMark: engineState.openPositionMark,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    scenarioLabel: 'OI Universe Scanner',
  };
}

async function startEngine({ settings = {} } = {}) {
  if (engineState.running) {
    if (settings && Object.keys(settings).length) {
      engineState.settings = normalizeSettings(migrateUniverseSettings({ ...engineState.settings, ...settings }));
      engineState.scanOrder = [...engineState.settings.universe];
      engineState.scanCursor = 0;
      engineState.futRefreshCursor = 0;
      await reapplyExitPointsToOpenTrade({ reason: 'SETTINGS_WHILE_RUNNING' });
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.settings = normalizeSettings(migrateUniverseSettings({ ...engineState.settings, ...settings }));
  engineState.scanOrder = [...engineState.settings.universe];
  engineState.scanCursor = 0;
  engineState.futRefreshCursor = 0;
  engineState.running = true;
  engineState.startedAt = new Date().toISOString();
  engineState.lastError = null;
  await ensureWallet();
  const clock = getIstClock(new Date());
  await syncTradesToday(clock);
  await reapplyExitPointsToOpenTrade({ reason: 'ENGINE_START' });
  for (const id of [...engineState.openTradeIds]) {
    const trade = await LivePaperTrade.findById(id);
    if (trade && !trade.exitTime) {
      // eslint-disable-next-line no-await-in-loop
      await subscribeOpenOption(trade);
    }
  }
  if (engineState.openTradeIds.size > 0) startPositionPoll();
  startPoll();
  logLine('ENGINE_START', {
    universe: engineState.scanOrder,
    openCount: engineState.openTradeIds.size,
  });
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  return { ok: true, ignored: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(settings = {}) {
  engineState.settings = normalizeSettings(migrateUniverseSettings({ ...engineState.settings, ...settings }));
  engineState.scanOrder = [...engineState.settings.universe];
  engineState.scanCursor = 0;
  engineState.futRefreshCursor = 0;
  // Drop slots for symbols no longer in universe.
  for (const key of Object.keys(engineState.symbols)) {
    if (!engineState.scanOrder.includes(key)) delete engineState.symbols[key];
  }
  const wallet = await ensureWallet();
  wallet.strategy13EngineSettings = engineState.settings;
  await wallet.save();
  await reapplyExitPointsToOpenTrade({ reason: 'SETTINGS_SAVE' });
  return { ok: true, state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (engineState.running) return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy13EngineSettings
      ? wallet.strategy13EngineSettings.toObject?.() || wallet.strategy13EngineSettings
      : {};
    return startEngine({ settings: migrateUniverseSettings(persisted) });
  } catch (err) {
    engineState.lastError = `OI Universe boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
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
  await syncTradesToday(clock);

  // Multi-open is allowed (one per symbol). Never auto-close valid opens.
  // Only log accidental same-symbol duplicates — entry path already blocks re-entry.
  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  })
    .sort({ entryTime: 1 })
    .lean();
  const seen = {};
  for (const trade of open) {
    const sym = String(trade.symbol || '').toUpperCase();
    if (seen[sym]) {
      logLine('DUPLICATE_OPEN_WARN', {
        symbol: sym,
        keepId: seen[sym],
        extraId: String(trade._id),
      });
      continue;
    }
    seen[sym] = String(trade._id);
  }

  if (engineState.openTradeIds.size > 0 && engineState.running && !engineState.positionPollTimer) {
    startPositionPoll();
  }
  await reapplyExitPointsToOpenTrade({ reason: 'RECONCILE' });
  const ids = (
    await LivePaperTrade.find({ strategyKey: STRATEGY_KEY }).select('_id').lean()
  ).map((r) => String(r._id));
  pruneTradeNotifications({ strategy: 'OI Universe', validTradeIds: ids });
  return { ok: true, openCount: open.length };
}

async function resumeOpenPositionFromDb() {
  const clock = getIstClock(new Date());
  await syncTradesToday(clock);
  if (!engineState.openTradeIds.size) {
    return { ok: true, resumed: false, state: getEngineSnapshot() };
  }
  for (const id of [...engineState.openTradeIds]) {
    const trade = await LivePaperTrade.findById(id);
    if (!trade || trade.exitTime) {
      detachOpenTrade(id);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await subscribeOpenOption(trade);
  }
  if (!engineState.positionPollTimer && engineState.openTradeIds.size > 0) startPositionPoll();
  return { ok: true, resumed: engineState.openTradeIds.size > 0, state: getEngineSnapshot() };
}

async function closeOpenPosition({ tradeId = null } = {}) {
  let trade = null;
  if (tradeId) {
    trade = await LivePaperTrade.findOne({
      _id: tradeId,
      strategyKey: STRATEGY_KEY,
      exitTime: null,
    });
  } else if (engineState.openTradeId) {
    trade = await LivePaperTrade.findById(engineState.openTradeId);
  }
  if (!trade || trade.exitTime) return { ok: false, error: 'No open trade' };
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true });
  await finalizeTrade(trade, {
    exitPremium: mark.optionLtp,
    mark,
    reason: 'MANUAL_CLOSE',
  });
  return { ok: true, trade, state: getEngineSnapshot() };
}

async function refreshOpenPositionMarkForStatus() {
  if (!engineState.openTradeIds.size) return null;
  let last = null;
  for (const id of [...engineState.openTradeIds]) {
    const current = engineState.openPositionMarks[id];
    if (current?.at) {
      const ageMs = Date.now() - new Date(current.at).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STATUS_MARK_REFRESH_MIN_GAP_MS) {
        last = current;
        continue;
      }
    }
    const trade = await LivePaperTrade.findById(id);
    if (!trade || trade.exitTime) {
      detachOpenTrade(id);
      continue;
    }
    cacheOpenTradeLite(trade);
    // eslint-disable-next-line no-await-in-loop
    const mark = await resolveMarkForOpenTrade(trade, { preferTicks: true, allowChain: true });
    last = publishOpenMark(trade, mark, { persist: true });
  }
  publishLiveMarkSnapshot();
  return last;
}

async function clearDailySkipState() {
  return { ok: true };
}

module.exports = {
  STRATEGY_KEY,
  DEFAULT_UNIVERSE,
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
  getLiveMarkSnapshot,
};

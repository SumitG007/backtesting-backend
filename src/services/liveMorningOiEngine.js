/**
 * Strategy 7 (UI) — NIFTY OI Wall Entry paper live.
 * Multi-trade: live OI wall · Put≥Call → CE / Call→PE · enter only on pure signal at fill time.
 * Default target +15% / SL −10% on option premium · EOD square-off. Skip if OI/ΔOI flips before entry.
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey, buildIstWallClockTimestamp } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
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
} = require('./dhanLiveService');
const { fetchTradingDayCandles } = require('./dhanDataService');
const { STRATEGY_TWELVE_MORNING_OI_LIVE_KEY } = require('../strategies/keys');
const { pushNotification, pruneTradeNotifications } = require('./notificationHub');

const STRATEGY_KEY = STRATEGY_TWELVE_MORNING_OI_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy12';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy12:option';
/** Fast live polls — keep under Dhan option-chain cache floor (~4s). */
const POLL_INTERVAL_MS = 2000;
const POSITION_POLL_MS = 1000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 4000;
const TICK_FRESH_MAX_AGE_MS = 20000;
const MIN_HOLD_MS = 2000;
const OI_REFRESH_MIN_GAP_MS = 5000;
const OI_BOARD_REFRESH_MIN_GAP_MS = 4000;
const CANDLE_REFRESH_MIN_GAP_MS = 8000;
const DEFAULT_CANDLE_INTERVAL = '1';
const DEFAULT_TRADE_FROM = 560; // 09:20
const DEFAULT_TRADE_TO = 910; // 15:10
const DEFAULT_EOD = 920; // 15:20
const DEFAULT_TARGET_PCT = 15;
const DEFAULT_STOP_PCT = 10;
/** After OI side flip, wait before arming a new entry setup. */
const OI_FLIP_COOLDOWN_MS = 60_000;
/** Board shows enough strikes around spot to catch the real high-OI wall (e.g. 24000). */
const OI_BOARD_LOOKAROUND = 12;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  settings: {
    symbol: 'NIFTY',
    lotCount: 5,
    tradeFromTime: '09:20',
    tradeToTime: '15:10',
    eodExitTime: '15:20',
    targetPct: DEFAULT_TARGET_PCT,
    stopLossPct: DEFAULT_STOP_PCT,
    hasStopLoss: true,
    proximityPoints: 30,
    strikeLookaround: 10,
    strikeMode: 'ATM',
    maxTradesPerDay: 8,
    cooldownMinutes: 2,
    candleInterval: DEFAULT_CANDLE_INTERVAL,
    perTradeCost: 100,
  },
  lotSize: 65,
  expiry: null,
  expiryDateKey: null,
  lastSpot: null,
  lastOptionTick: null,
  morningSignal: null,
  /** Live truth for UI — never sticky Buy CE when invalid. */
  liveSignal: null,
  lastSignalNotifKey: null,
  liveOiBoard: null,
  armedBias: null,
  oiFlipUntilMs: 0,
  lastOiBoardFetchAt: 0,
  lastOiFetchAt: 0,
  lastOiError: null,
  todayBars1m: [],
  lastCandleFetchAt: 0,
  lastCandleError: null,
  tradesTodayCount: 0,
  tradesTodayDateKey: null,
  lastExitAtMs: 0,
  openTradeId: null,
  closingTrade: false,
  enteringTrade: false,
  evaluatingEntry: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
};

function istClockLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logEntry(line, payload = {}) {
  const entry = { at: new Date().toISOString(), line, ...payload };
  engineState.lastEntryDebug = entry;
  console.log(`[MorningOiPaperLive] ${line}`, JSON.stringify(entry));
}

function getEngineSymbol() {
  return String(engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

function normalizeSettings(settings = {}) {
  const lotCount = Math.max(1, Number(settings.lotCount) || 5);
  const targetRaw = Number(settings.targetPct ?? settings.targetPoints);
  const targetPct =
    Number.isFinite(targetRaw) && targetRaw > 0 ? Math.min(500, targetRaw) : DEFAULT_TARGET_PCT;

  let hasStopLoss = true;
  let stopLossPct = DEFAULT_STOP_PCT;
  if (Object.prototype.hasOwnProperty.call(settings, 'stopLossPct')) {
    const slRaw = settings.stopLossPct;
    if (slRaw === '' || slRaw === null || slRaw === undefined) {
      hasStopLoss = false;
      stopLossPct = null;
    } else {
      const n = Number(slRaw);
      if (!Number.isFinite(n) || n <= 0) {
        hasStopLoss = false;
        stopLossPct = null;
      } else {
        hasStopLoss = true;
        stopLossPct = Math.min(90, n);
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(settings, 'stopLossPoints')) {
    // Migrate old points setting → % default if they only had points stored.
    const n = Number(settings.stopLossPoints);
    hasStopLoss = Number.isFinite(n) && n > 0;
    stopLossPct = hasStopLoss ? DEFAULT_STOP_PCT : null;
  }

  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 30);
  const strikeLookaround = Math.max(1, Math.floor(Number(settings.strikeLookaround) || 10));
  const maxTradesPerDay = Math.max(1, Math.min(30, Math.floor(Number(settings.maxTradesPerDay) || 8)));
  const cooldownMinutes = Math.max(0, Math.min(60, Number(settings.cooldownMinutes) || 2));
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount,
    tradeFromTime: String(settings.tradeFromTime || settings.oiScanFromTime || '09:20'),
    tradeToTime: (() => {
      const raw = String(settings.tradeToTime || '').trim();
      if (raw && raw !== '10:30' && raw !== '11:30') return raw;
      const legacy = String(settings.lastEntryTime || '').trim();
      if (legacy && legacy !== '10:30' && legacy !== '11:30') return legacy;
      return '15:10';
    })(),
    eodExitTime: String(settings.eodExitTime || '15:20'),
    targetPct,
    stopLossPct,
    hasStopLoss,
    proximityPoints,
    strikeLookaround,
    strikeMode: String(settings.strikeMode || 'ATM').toUpperCase() === 'ITM' ? 'ITM' : 'ATM',
    maxTradesPerDay,
    cooldownMinutes,
    candleInterval: '1',
    perTradeCost,
  };
}

function tradeFromMin() {
  return parseClockMinutes(engineState.settings.tradeFromTime, DEFAULT_TRADE_FROM);
}

function tradeToMin() {
  return parseClockMinutes(engineState.settings.tradeToTime, DEFAULT_TRADE_TO);
}

function eodExitMin() {
  return parseClockMinutes(engineState.settings.eodExitTime, DEFAULT_EOD);
}

function isEodExitTime(minutes) {
  return minutes >= eodExitMin();
}

function tradeOptionType(trade) {
  return String(trade?.optionType || 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE';
}

function premiumFromChain(chain, optionType) {
  if (!chain) return null;
  const n = optionType === 'CE' ? Number(chain.ceLtp) : Number(chain.peLtp);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Level = highest total OI near spot (the real wall, e.g. 24000).
 * Bias on that strike only: Put OI ≥ Call OI → Buy CE, else Buy PE.
 * No 1.5× / ΔOI filters for picking the level — those caused far junk strikes (e.g. 23650).
 */
function pickDominantStrike(snapshot) {
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  const atm = Number(snapshot?.atm);
  const step = Math.max(1, Number(snapshot?.strikeStep) || 50);
  let best = null;

  for (const row of strikes) {
    const putOi = Number(row.putOi);
    const callOi = Number(row.callOi);
    if (!Number.isFinite(putOi) || !Number.isFinite(callOi)) continue;
    if (putOi < 0 || callOi < 0) continue;
    if (putOi <= 0 && callOi <= 0) continue;

    const oiMass = putOi + callOi;
    if (!(oiMass > 0)) continue;

    const distSteps =
      Number.isFinite(atm) && Number.isFinite(row.strike)
        ? Math.abs(row.strike - atm) / step
        : 0;
    // Soft near-spot preference only — never enough to beat a real Cr wall far from a tiny ATM print.
    const nearBoost = 1 / (1 + distSteps * 0.12);
    const score = oiMass * nearBoost;

    if (!best || score > best.score) {
      const putDom = putOi >= callOi;
      const putChg = Number(row.putChgOi);
      const callChg = Number(row.callChgOi);
      const hasChg = Number.isFinite(putChg) && Number.isFinite(callChg);
      const ratio = putDom
        ? putOi / Math.max(callOi, 1)
        : callOi / Math.max(putOi, 1);

      best = {
        strike: row.strike,
        dominantSide: putDom ? 'PUT' : 'CALL',
        optionType: putDom ? 'CE' : 'PE',
        putOi,
        callOi,
        putChgOi: Number.isFinite(putChg) ? putChg : null,
        callChgOi: Number.isFinite(callChg) ? callChg : null,
        hasChangeOi: hasChg,
        ratio: Number(ratio.toFixed(2)),
        oiMass,
        score,
        ceLtp: row.ceLtp,
        peLtp: row.peLtp,
      };
    }
  }
  return best;
}

/** ΔOI fights CE if calls are building faster; fights PE if puts build faster. */
function isDeltaOiFighting(optionType, putChg, callChg) {
  if (!Number.isFinite(putChg) || !Number.isFinite(callChg)) return false;
  if (optionType === 'CE') return callChg > putChg;
  return putChg > callChg;
}

/**
 * Track armed CE/PE while waiting for spot. Side flip → disarm + cooldown (skip stale entry).
 */
function trackArmedBias(signal) {
  if (!signal || signal.skip || !signal.optionType) return 'NONE';
  const side = signal.optionType === 'PE' ? 'PE' : 'CE';
  const prev = engineState.armedBias;
  if (prev?.optionType && prev.optionType !== side) {
    logEntry('OI_BIAS_FLIP', {
      from: prev.optionType,
      to: side,
      prevLevel: prev.levelStrike,
      newLevel: signal.levelStrike,
    });
    engineState.armedBias = null;
    engineState.oiFlipUntilMs = Date.now() + OI_FLIP_COOLDOWN_MS;
    return 'FLIPPED';
  }
  if (Date.now() < engineState.oiFlipUntilMs) return 'STABILIZING';
  engineState.armedBias = {
    optionType: side,
    dominantSide: signal.dominantSide,
    levelStrike: signal.levelStrike,
    at: Date.now(),
  };
  return 'OK';
}

/**
 * Fresh OI re-check right before fill — wall side + ΔOI must still agree.
 */
async function revalidateWallEntry(clock, intended) {
  engineState.lastOiFetchAt = 0;
  const live = await captureMorningOiSignal(clock);
  if (!live || live.skip) {
    return { ok: false, reason: 'NO_DOMINANT_NOW', live: live || null };
  }
  const intendedType = intended.optionType === 'PE' ? 'PE' : 'CE';
  if (live.optionType !== intendedType) {
    trackArmedBias(live);
    return {
      ok: false,
      reason: 'OI_SIDE_FLIPPED',
      intended: intendedType,
      now: live.optionType,
      live,
    };
  }
  if (intendedType === 'CE' && Number(live.putOi) < Number(live.callOi)) {
    return { ok: false, reason: 'WALL_SIDE_BROKEN', live };
  }
  if (intendedType === 'PE' && Number(live.callOi) < Number(live.putOi)) {
    return { ok: false, reason: 'WALL_SIDE_BROKEN', live };
  }
  if (isDeltaOiFighting(live.optionType, live.putChgOi, live.callChgOi)) {
    return {
      ok: false,
      reason: 'DELTA_OI_FIGHTING',
      putChg: live.putChgOi,
      callChg: live.callChgOi,
      live,
    };
  }
  if (Date.now() < engineState.oiFlipUntilMs) {
    return { ok: false, reason: 'OI_FLIP_COOLDOWN', live };
  }
  const arm = trackArmedBias(live);
  if (arm === 'FLIPPED' || arm === 'STABILIZING') {
    return { ok: false, reason: arm === 'FLIPPED' ? 'OI_SIDE_FLIPPED' : 'OI_FLIP_COOLDOWN', live };
  }
  return { ok: true, signal: live };
}

function readLastCandleSnapshot(rows) {
  if (!Array.isArray(rows) || rows.length < 1) return null;
  const bar = rows.length >= 2 ? rows[rows.length - 2] : rows[rows.length - 1];
  const prev = rows.length >= 2 ? rows[rows.length - 3] : null;
  const open = Number(bar[1]);
  const high = Number(bar[2]);
  const low = Number(bar[3]);
  const close = Number(bar[4]);
  const prevClose = prev != null ? Number(prev[4]) : null;
  if (![open, high, low, close].every(Number.isFinite)) return null;
  return {
    open,
    high,
    low,
    close,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    green: close > open,
    red: close < open,
  };
}

function candleConfirms(signal, candle) {
  if (!signal || !candle) return false;
  const level = Number(signal.levelStrike);
  const prox = engineState.settings.proximityPoints;
  if (!Number.isFinite(level)) return false;
  if (signal.optionType === 'CE') {
    const nearSupport = candle.low <= level + prox;
    const bounce = Number.isFinite(candle.prevClose) ? candle.close >= candle.prevClose : true;
    return nearSupport && candle.green && bounce;
  }
  const nearResist = candle.high >= level - prox;
  const reject = Number.isFinite(candle.prevClose) ? candle.close <= candle.prevClose : true;
  return nearResist && candle.red && reject;
}

/**
 * Publish live signal status for UI + day notifications.
 * Status is never a sticky "Buy CE" when criteria are off.
 */
function publishLiveSignal(next) {
  const prev = engineState.liveSignal;
  engineState.liveSignal = {
    ...next,
    at: new Date().toISOString(),
    ageMs: 0,
  };

  const key = [
    next.status,
    next.optionType || '',
    next.levelStrike || '',
    next.reason || '',
  ].join(':');

  if (key === engineState.lastSignalNotifKey) return;
  const prevKey = engineState.lastSignalNotifKey;
  engineState.lastSignalNotifKey = key;

  const status = String(next.status || '');
  const notable =
    status === 'READY'
    || status === 'CAUTION'
    || status === 'CLEARED'
    || status === 'WATCHING'
    || (status === 'NEAR' && (!prev || prev.status !== 'NEAR' || prev.optionType !== next.optionType));

  // Notify on arm / change / clear / ready — skip noisy same-phase WATCHING repeats via key above.
  if (!notable && status !== 'READY' && status !== 'CAUTION' && status !== 'CLEARED') {
    // Still notify first WATCHING of a new wall/side.
    const wallChanged =
      prev
      && (String(prev.optionType) !== String(next.optionType)
        || Number(prev.levelStrike) !== Number(next.levelStrike));
    if (!(status === 'WATCHING' && (!prevKey || wallChanged))) return;
  }

  if (status === 'OUTSIDE_WINDOW' || status === 'IN_TRADE' || status === 'MAX_TRADES' || status === 'COOLDOWN') {
    return;
  }

  let type = 'OI_SIGNAL';
  let title = next.label || status;
  let body = next.detail || '';

  if (status === 'CLEARED') {
    type = 'SIGNAL_CLEARED';
    title = next.label || 'Signal cleared';
  } else if (status === 'READY') {
    type = 'SIGNAL_READY';
    title = next.label || `Ready ${next.optionType} · ${next.levelStrike}`;
  } else if (status === 'CAUTION') {
    type = 'SIGNAL_CAUTION';
    title = next.label || `Caution ${next.optionType} · ${next.levelStrike}`;
  } else if (
    prev
    && (String(prev.optionType) !== String(next.optionType)
      || Number(prev.levelStrike) !== Number(next.levelStrike))
  ) {
    type = 'SIGNAL_CHANGED';
    title = next.label || `Signal → ${next.optionType} · ${next.levelStrike}`;
  }

  pushNotification({
    type,
    strategy: 'OI Wall',
    title: String(title).slice(0, 160),
    body: String(body).slice(0, 400),
    meta: {
      status: next.status,
      optionType: next.optionType,
      levelStrike: next.levelStrike,
      reason: next.reason,
      spotDist: next.spotDist,
    },
    dedupeKey: `oi-wall-live:${key}:${Math.floor(Date.now() / 30000)}`,
  });
}

async function refreshLiveSignalStatus(clock) {
  const prox = Number(engineState.settings.proximityPoints) || 30;

  if (clock.minutes < tradeFromMin() || clock.minutes > tradeToMin()) {
    publishLiveSignal({
      status: 'OUTSIDE_WINDOW',
      label: 'Outside trade window',
      detail: `Active ${engineState.settings.tradeFromTime}–${engineState.settings.tradeToTime}`,
      reason: 'OUTSIDE_WINDOW',
      optionType: null,
      levelStrike: null,
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (engineState.openTradeId) {
    publishLiveSignal({
      status: 'IN_TRADE',
      label: 'In trade',
      detail: 'One position open — no new entry until exit + cooldown',
      reason: 'POSITION_OPEN',
      optionType: engineState.morningSignal?.optionType || null,
      levelStrike: engineState.morningSignal?.levelStrike || null,
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
    publishLiveSignal({
      status: 'MAX_TRADES',
      label: 'Max trades hit',
      detail: `${engineState.tradesTodayCount}/${engineState.settings.maxTradesPerDay} today`,
      reason: 'MAX_TRADES',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  const cooldownMs = (Number(engineState.settings.cooldownMinutes) || 0) * 60 * 1000;
  if (cooldownMs > 0 && engineState.lastExitAtMs && Date.now() - engineState.lastExitAtMs < cooldownMs) {
    publishLiveSignal({
      status: 'COOLDOWN',
      label: 'Cooldown',
      detail: 'Waiting after last exit before next signal entry',
      reason: 'COOLDOWN',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  let signal;
  try {
    signal = await captureMorningOiSignal(clock);
  } catch (err) {
    publishLiveSignal({
      status: 'CLEARED',
      label: 'OI unavailable',
      detail: err.message || 'OI fetch failed',
      reason: 'OI_ERROR',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!signal || signal.skip) {
    publishLiveSignal({
      status: 'CLEARED',
      label: 'No wall signal',
      detail: signal?.skipReason || 'Waiting for dominant OI wall',
      reason: signal?.skipReason || 'NO_WALL',
      optionType: null,
      levelStrike: null,
      buyLive: false,
      putOi: signal?.putOi,
      callOi: signal?.callOi,
    });
    return engineState.liveSignal;
  }

  const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
  const level = Number(signal.levelStrike);
  const spot = Number(engineState.lastSpot ?? signal.spotAtScan);
  const spotDist = Number.isFinite(spot) && Number.isFinite(level) ? Math.abs(spot - level) : null;
  const proximityOk = Number.isFinite(spotDist) && spotDist <= prox;
  const deltaFighting = isDeltaOiFighting(optionType, signal.putChgOi, signal.callChgOi);
  const flipCooling = Date.now() < engineState.oiFlipUntilMs;

  let candle = null;
  let candleOk = false;
  try {
    const rows = await refreshOneMinuteCandles(clock);
    candle = readLastCandleSnapshot(rows);
    candleOk = candleConfirms(signal, candle);
  } catch {
    candleOk = false;
  }

  const base = {
    optionType,
    levelStrike: level,
    dominantSide: signal.dominantSide,
    putOi: signal.putOi,
    callOi: signal.callOi,
    putChgOi: signal.putChgOi,
    callChgOi: signal.callChgOi,
    ratio: signal.ratio,
    spot: Number.isFinite(spot) ? spot : null,
    spotDist: Number.isFinite(spotDist) ? Number(spotDist.toFixed(1)) : null,
    proximityPoints: prox,
    proximityOk,
    deltaOk: !deltaFighting,
    candleOk,
    candle,
    buyLive: false,
  };

  if (flipCooling) {
    publishLiveSignal({
      ...base,
      status: 'CAUTION',
      label: `Stabilizing after flip · was ${optionType}`,
      detail: 'OI side flipped recently — wait ~1m before trusting a new bias',
      reason: 'OI_FLIP_COOLDOWN',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (deltaFighting) {
    publishLiveSignal({
      ...base,
      status: 'CAUTION',
      label: `Watch ${optionType} · wall ${level} · ΔOI fighting`,
      detail:
        optionType === 'CE'
          ? 'Wall still Put-biased, but Call ΔOI rising faster — not a live buy'
          : 'Wall still Call-biased, but Put ΔOI rising faster — not a live buy',
      reason: 'DELTA_OI_FIGHTING',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!proximityOk) {
    publishLiveSignal({
      ...base,
      status: 'WATCHING',
      label: `Watch ${optionType} · wall ${level}`,
      detail: Number.isFinite(spotDist)
        ? `Spot ${spotDist.toFixed(0)} pts from wall — need ≤ ${prox} pts`
        : 'Waiting for spot near wall',
      reason: 'WAIT_PROXIMITY',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!candleOk) {
    publishLiveSignal({
      ...base,
      status: 'NEAR',
      label: `Near wall · ${optionType} ${level}`,
      detail:
        optionType === 'CE'
          ? 'In proximity — waiting for 1m green bounce confirm'
          : 'In proximity — waiting for 1m red reject confirm',
      reason: 'WAIT_CANDLE',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  publishLiveSignal({
    ...base,
    status: 'READY',
    label: `LIVE BUY ${optionType} · wall ${level}`,
    detail: 'Wall + proximity + ΔOI + 1m candle all aligned — entry eligible',
    reason: 'READY',
    buyLive: true,
  });
  return engineState.liveSignal;
}

/**
 * Live OI board for UI — memory only, refreshed often so we can see the real high-OI strike near spot.
 */
async function refreshLiveOiBoard(clock, { force = false } = {}) {
  const now = Date.now();
  if (
    !force
    && engineState.liveOiBoard
    && now - engineState.lastOiBoardFetchAt < OI_BOARD_REFRESH_MIN_GAP_MS
  ) {
    return engineState.liveOiBoard;
  }
  try {
    const symbol = getEngineSymbol();
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    if (!expiry) {
      engineState.lastOiError = 'No weekly expiry from Dhan';
      return engineState.liveOiBoard;
    }
    const lookaround = Math.max(
      OI_BOARD_LOOKAROUND,
      Number(engineState.settings.strikeLookaround) || 10,
    );
    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      lookaroundStrikes: lookaround,
    });
    engineState.lastOiBoardFetchAt = now;
    if (Number.isFinite(snapshot.spot)) engineState.lastSpot = snapshot.spot;

    const strikes = (snapshot.strikes || []).map((r) => ({
      strike: r.strike,
      putOi: r.putOi,
      callOi: r.callOi,
      putChgOi: r.putChgOi,
      callChgOi: r.callChgOi,
      totalOi: (Number(r.putOi) || 0) + (Number(r.callOi) || 0),
      ceLtp: r.ceLtp,
      peLtp: r.peLtp,
      distanceFromAtm: r.distanceFromAtm,
    }));

    let maxPut = null;
    let maxCall = null;
    let maxTotal = null;
    for (const row of strikes) {
      if (Number.isFinite(row.putOi) && (!maxPut || row.putOi > maxPut.putOi)) maxPut = row;
      if (Number.isFinite(row.callOi) && (!maxCall || row.callOi > maxCall.callOi)) maxCall = row;
      if (!maxTotal || row.totalOi > maxTotal.totalOi) maxTotal = row;
    }

    const totals = snapshot.totals || {};
    const pcr = Number(totals.pcr);
    const nearPcr = Number(totals.nearPcr);
    let pcrBias = 'NEUTRAL';
    const biasPcr = Number.isFinite(nearPcr) ? nearPcr : pcr;
    if (Number.isFinite(biasPcr)) {
      if (biasPcr >= 1.1) pcrBias = 'PUT_HEAVY';
      else if (biasPcr <= 0.9) pcrBias = 'CALL_HEAVY';
    }

    engineState.liveOiBoard = {
      at: new Date().toISOString(),
      dateKey: clock.dateKey,
      spot: snapshot.spot,
      atm: snapshot.atm,
      expiry,
      strikeStep: snapshot.strikeStep,
      strikes,
      totals: {
        callOi: totals.callOi ?? null,
        putOi: totals.putOi ?? null,
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
    engineState.lastOiError = null;
    if (String(engineState.lastError || '').startsWith('OI board:')) {
      engineState.lastError = null;
    }
    return engineState.liveOiBoard;
  } catch (err) {
    const msg = err.message || 'OI board fetch failed';
    engineState.lastOiError = msg;
    // Keep last good board; do not poison main lastError when UI still has data.
    if (!engineState.liveOiBoard) {
      engineState.lastError = `OI board: ${msg}`;
    } else if (String(engineState.lastError || '').startsWith('OI board:')) {
      engineState.lastError = null;
    }
    return engineState.liveOiBoard;
  }
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) wallet = await LiveWallet.create({ walletKey: WALLET_KEY });
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

async function getEntryExpiry(symbol, dateKey) {
  const cachedExpiry = String(engineState.expiry || '').slice(0, 10);
  const isStale = !cachedExpiry || cachedExpiry < dateKey || engineState.expiryDateKey !== dateKey;
  if (isStale) {
    engineState.expiry = await getNearestWeeklyExpiry(symbol);
    engineState.expiryDateKey = dateKey;
  }
  return engineState.expiry;
}

function optionTickIsFresh() {
  const tick = engineState.lastOptionTick;
  if (!Number.isFinite(tick?.ltp)) return false;
  return Date.now() - (tick.ts || 0) < TICK_FRESH_MAX_AGE_MS;
}

function getOptionMarkFromTrade(trade, chain = null) {
  const optionType = tradeOptionType(trade);
  const chainLtp = premiumFromChain(chain, optionType);
  if (Number.isFinite(chainLtp) && chainLtp > 0) {
    return { optionLtp: chainLtp, spot: Number(chain.chainSpot) || null, source: 'chain', optionType };
  }
  const tickLtp = Number(engineState.lastOptionTick?.ltp);
  if (Number.isFinite(tickLtp) && tickLtp > 0) {
    return { optionLtp: tickLtp, spot: engineState.lastSpot, source: 'websocket', optionType };
  }
  const entryPrem = Number(trade.entryPremium);
  return {
    optionLtp: Number.isFinite(entryPrem) ? entryPrem : 0.05,
    spot: engineState.lastSpot || trade.entrySpot,
    source: 'entry',
    optionType,
  };
}

async function resolveMarkForOpenTrade(trade, { preferTicks = false, allowChain = true, forceChain = false } = {}) {
  if (preferTicks || optionTickIsFresh()) {
    const tickMark = getOptionMarkFromTrade(trade, null);
    if (tickMark.source === 'websocket') return tickMark;
  }
  const now = Date.now();
  const chainGapOk = forceChain || now - engineState.lastChainFetchAt >= OPEN_MARK_CHAIN_MIN_GAP_MS;
  if (!allowChain || !chainGapOk) return getOptionMarkFromTrade(trade, null);
  try {
    engineState.lastChainFetchAt = now;
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const mark = getOptionMarkFromTrade(trade, chain);
    if (Number.isFinite(mark.spot)) engineState.lastSpot = mark.spot;
    return mark;
  } catch (err) {
    engineState.lastError = `Mark fetch: ${err.message}`;
    return getOptionMarkFromTrade(trade, null);
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entry = Number(trade.entryPremium) || 0;
  const ltp = Number(mark.optionLtp) || 0;
  const qty = Number(trade.qty) || 0;
  const unrealized = (ltp - entry) * qty - (Number(trade.charges) || 0);
  return {
    optionType: tradeOptionType(trade),
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    spot: mark.spot,
    source: mark.source,
    isLiveMark: mark.source === 'websocket' || mark.source === 'chain',
    unrealizedPnl: Number(unrealized.toFixed(2)),
    at: new Date().toISOString(),
    ist: istClockLabel(clock),
  };
}

async function persistOpenMarkToDb(trade, positionMark) {
  trade.openPositionMark = positionMark;
  trade.openPositionMarkAt = new Date();
  await trade.save();
}

async function subscribeOpenOption(trade) {
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.lastOptionTick = null;
  const optionType = tradeOptionType(trade);
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType,
    });
    subscribeLiveInstrument({
      key: OPTION_SUBSCRIPTION_KEY,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: (tick) => onOptionTick(tick),
    });
  } catch (err) {
    engineState.lastError = `OI Wall WS subscribe failed: ${err.message}`;
  }
}

function clearOpenTrade() {
  stopPositionPoll();
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.lastOptionTick = null;
  engineState.openPositionMark = null;
}

function stopPositionPoll() {
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function startPositionPoll() {
  stopPositionPoll();
  if (!engineState.openTradeId) return;
  const tick = () => {
    checkOpenTrade().catch((err) => {
      engineState.lastError = `OI Wall position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

async function dedupeOpenTradesInDb(clock) {
  const openRows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
    entryTime: -1,
  });
  if (openRows.length <= 1) return openRows[0] || null;
  const [keep, ...duplicates] = openRows;
  for (const dup of duplicates) {
    dup.status = 'CLOSED';
    dup.exitTime = new Date();
    dup.exitDateKey = clock.dateKey;
    dup.reason = 'DUPLICATE_ENTRY';
    dup.pnl = 0;
    dup.pnlPct = 0;
    await dup.save();
  }
  if (duplicates.length > 0) await recalcWalletFromTrades();
  return keep;
}

async function syncTradesToday(clock) {
  if (engineState.tradesTodayDateKey === clock.dateKey) return;
  const count = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });
  engineState.tradesTodayCount = count;
  engineState.tradesTodayDateKey = clock.dateKey;
  engineState.armedBias = null;
  engineState.oiFlipUntilMs = 0;
  const last = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .select({ exitTime: 1 })
    .lean();
  engineState.lastExitAtMs = last?.exitTime ? new Date(last.exitTime).getTime() : 0;
}

async function syncEngineTradeStateFromDb(clock) {
  await syncTradesToday(clock);
  const open = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
    entryTime: -1,
  });
  if (open) {
    engineState.openTradeId = open._id.toString();
    return;
  }
  if (engineState.openTradeId) clearOpenTrade();
  if (engineState.morningSignal?.dateKey && engineState.morningSignal.dateKey !== clock.dateKey) {
    engineState.morningSignal = null;
    engineState.armedBias = null;
    engineState.oiFlipUntilMs = 0;
  }
}

async function captureMorningOiSignal(clock) {
  const from = tradeFromMin();
  const to = tradeToMin();
  const existing = engineState.morningSignal;
  const sameDay = existing?.dateKey === clock.dateKey;

  // Outside monitor window: keep last signal for UI, do not refresh.
  if (clock.minutes < from) return sameDay ? existing : null;
  if (clock.minutes > to) return sameDay ? existing : null;

  // Throttle live OI wall refresh — wall + direction can update all day until one entry fills.
  if (sameDay && Date.now() - engineState.lastOiFetchAt < OI_REFRESH_MIN_GAP_MS) {
    return existing;
  }

  try {
    const symbol = getEngineSymbol();
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    if (!expiry) {
      engineState.lastOiError = 'No weekly expiry from Dhan';
      engineState.lastError = `OI Wall: ${engineState.lastOiError}`;
      logEntry('OI_SCAN_ERROR', { ist: istClockLabel(clock), error: engineState.lastOiError });
      return existing || null;
    }

    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      lookaroundStrikes: Math.max(
        OI_BOARD_LOOKAROUND,
        Number(engineState.settings.strikeLookaround) || 10,
      ),
    });
    engineState.lastOiFetchAt = Date.now();
    engineState.lastOiError = null;

    if (!Array.isArray(snapshot.strikes) || snapshot.strikes.length === 0) {
      engineState.lastOiError = 'Empty option chain / no nearby strikes';
      engineState.lastError = `OI Wall: ${engineState.lastOiError}`;
      logEntry('OI_SCAN_EMPTY', {
        ist: istClockLabel(clock),
        allStrikeCount: snapshot.allStrikeCount || 0,
        spot: snapshot.spot,
      });
      return existing || null;
    }

    if (Number.isFinite(snapshot.spot)) engineState.lastSpot = snapshot.spot;

    const withOi = snapshot.strikes.filter(
      (r) => Number.isFinite(r.putOi) && Number.isFinite(r.callOi) && r.putOi > 0 && r.callOi > 0,
    );
    const withChg = withOi.filter(
      (r) => Number.isFinite(r.putChgOi) && Number.isFinite(r.callChgOi),
    );

    const dominant = pickDominantStrike(snapshot);
    if (!dominant) {
      engineState.morningSignal = {
        dateKey: clock.dateKey,
        skip: true,
        skipReason: 'no_dominant_oi',
        spot: snapshot.spot,
        atm: snapshot.atm,
        scanned: snapshot.strikes.length,
        withOi: withOi.length,
        withChangeOi: withChg.length,
        candleInterval: '1',
        at: new Date().toISOString(),
      };
      logEntry('OI_SCAN_NO_SIGNAL', engineState.morningSignal);
      return engineState.morningSignal;
    }

    const prev = sameDay && !existing?.skip ? existing : null;
    const changed =
      !prev
      || Number(prev.levelStrike) !== Number(dominant.strike)
      || String(prev.optionType) !== String(dominant.optionType);

    engineState.morningSignal = {
      dateKey: clock.dateKey,
      skip: false,
      levelStrike: dominant.strike,
      optionType: dominant.optionType,
      dominantSide: dominant.dominantSide,
      putOi: dominant.putOi,
      callOi: dominant.callOi,
      putChgOi: dominant.putChgOi,
      callChgOi: dominant.callChgOi,
      hasChangeOi: Boolean(dominant.hasChangeOi),
      ratio: dominant.ratio,
      oiMass: dominant.oiMass,
      spotAtScan: snapshot.spot,
      atm: snapshot.atm,
      expiry,
      scanned: snapshot.strikes.length,
      withOi: withOi.length,
      withChangeOi: withChg.length,
      candleInterval: '1',
      at: new Date().toISOString(),
    };
    const armStatus = trackArmedBias(engineState.morningSignal);
    engineState.morningSignal.armStatus = armStatus;
    logEntry('OI_SCAN_SIGNAL', {
      ...engineState.morningSignal,
      wallChanged: changed,
    });
    return engineState.morningSignal;
  } catch (err) {
    engineState.lastOiError = err.message || 'OI fetch failed';
    engineState.lastError = `OI Wall chain: ${engineState.lastOiError}`;
    logEntry('OI_SCAN_ERROR', { ist: istClockLabel(clock), error: engineState.lastOiError });
    return existing || null;
  }
}

async function refreshOneMinuteCandles(clock, { force = false } = {}) {
  const now = Date.now();
  if (
    !force
    && engineState.todayBars1m.length > 0
    && now - engineState.lastCandleFetchAt < CANDLE_REFRESH_MIN_GAP_MS
  ) {
    return engineState.todayBars1m;
  }
  try {
    const { rows } = await fetchTradingDayCandles({
      symbol: getEngineSymbol(),
      interval: '1',
      dateKey: clock.dateKey,
    });
    engineState.todayBars1m = Array.isArray(rows) ? rows : [];
    engineState.lastCandleFetchAt = now;
    engineState.lastCandleError = null;
    return engineState.todayBars1m;
  } catch (err) {
    engineState.lastCandleError = err.message || '1m candle fetch failed';
    engineState.lastError = `1m candles: ${engineState.lastCandleError}`;
    return engineState.todayBars1m;
  }
}

async function hasReactionConfirmation(clock, signal) {
  const rows = await refreshOneMinuteCandles(clock);
  if (!Array.isArray(rows) || rows.length < 2) {
    logEntry('WAIT_REACTION', {
      ist: istClockLabel(clock),
      reason: 'NO_1M_CANDLES',
      bars: rows?.length || 0,
      candleError: engineState.lastCandleError,
    });
    return false;
  }
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const open = Number(last[1]);
  const high = Number(last[2]);
  const low = Number(last[3]);
  const close = Number(last[4]);
  const prevClose = Number(prev[4]);
  if (![open, high, low, close].every(Number.isFinite)) return false;

  const level = Number(signal.levelStrike);
  const prox = engineState.settings.proximityPoints;
  if (!Number.isFinite(level)) return false;

  if (signal.optionType === 'CE') {
    const nearSupport = low <= level + prox;
    const green = close > open;
    const bounce = Number.isFinite(prevClose) ? close >= prevClose : true;
    return nearSupport && green && bounce;
  }
  const nearResist = high >= level - prox;
  const red = close < open;
  const reject = Number.isFinite(prevClose) ? close <= prevClose : true;
  return nearResist && red && reject;
}

async function evaluateEntry() {
  if (engineState.evaluatingEntry) return;
  engineState.evaluatingEntry = true;
  try {
    const clock = getIstClock(new Date());
    await ensureNseHolidaysLoaded();
    if (!isNseCashTradingDay(clock.dateKey)) {
      if (clock.minutes >= tradeFromMin() && clock.minutes <= tradeToMin()) {
        logEntry('ENTRY_SKIP', {
          ist: istClockLabel(clock),
          reason: isWeekendDateKey(clock.dateKey) ? 'WEEKEND' : 'HOLIDAY',
          holiday: getNseHolidayDescription(clock.dateKey),
        });
      }
      return;
    }
    await syncEngineTradeStateFromDb(clock);

    // One open position at a time; multi entries/day on pure signals only.
    if (engineState.openTradeId) return;

    if (clock.minutes > tradeToMin() || clock.minutes < tradeFromMin()) return;

    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'MAX_TRADES',
        count: engineState.tradesTodayCount,
      });
      return;
    }

    const cooldownMs = (Number(engineState.settings.cooldownMinutes) || 0) * 60 * 1000;
    if (cooldownMs > 0 && engineState.lastExitAtMs && Date.now() - engineState.lastExitAtMs < cooldownMs) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'COOLDOWN' });
      return;
    }

    let signal;
    try {
      signal = await captureMorningOiSignal(clock);
    } catch (err) {
      engineState.lastError = `OI signal: ${err.message}`;
      return;
    }
    if (!signal || signal.skip) return;

    if (Date.now() < engineState.oiFlipUntilMs) {
      logEntry('ENTRY_SKIP_REVALIDATE', {
        ist: istClockLabel(clock),
        reason: 'OI_FLIP_COOLDOWN',
        optionType: signal.optionType,
        level: signal.levelStrike,
      });
      return;
    }
    if (isDeltaOiFighting(signal.optionType, signal.putChgOi, signal.callChgOi)) {
      logEntry('ENTRY_SKIP_REVALIDATE', {
        ist: istClockLabel(clock),
        reason: 'DELTA_OI_FIGHTING',
        optionType: signal.optionType,
        level: signal.levelStrike,
        putChg: signal.putChgOi,
        callChg: signal.callChgOi,
      });
      return;
    }

    let spot;
    try {
      const spotMark = await getAtmPremiums({
        symbol: getEngineSymbol(),
        strike: signal.levelStrike,
        expiry: signal.expiry || engineState.expiry,
      });
      spot = Number(spotMark.chainSpot || spotMark.spot);
    } catch (err) {
      engineState.lastError = `Live spot: ${err.message}`;
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'SPOT_FETCH_FAILED', error: err.message });
      return;
    }
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'Live spot unavailable from Dhan chain';
      return;
    }
    engineState.lastSpot = spot;

    const dist = Math.abs(spot - Number(signal.levelStrike));
    if (dist > engineState.settings.proximityPoints) {
      logEntry('WAIT_PROXIMITY', {
        ist: istClockLabel(clock),
        spot,
        level: signal.levelStrike,
        dist: Number(dist.toFixed(1)),
        need: engineState.settings.proximityPoints,
      });
      return;
    }

    let confirmed = false;
    try {
      confirmed = await hasReactionConfirmation(clock, signal);
    } catch (err) {
      engineState.lastError = `1m reaction: ${err.message}`;
      return;
    }
    if (!confirmed) {
      logEntry('WAIT_REACTION', {
        ist: istClockLabel(clock),
        optionType: signal.optionType,
        level: signal.levelStrike,
        spot,
        candleInterval: '1',
      });
      return;
    }

    // Final live re-check: OI may have flipped / ΔOI may fight while waiting for spot.
    let check;
    try {
      check = await revalidateWallEntry(clock, signal);
    } catch (err) {
      engineState.lastError = `OI revalidate: ${err.message}`;
      return;
    }
    if (!check.ok) {
      logEntry('ENTRY_SKIP_REVALIDATE', {
        ist: istClockLabel(clock),
        reason: check.reason,
        intended: signal.optionType,
        level: signal.levelStrike,
        nowType: check.live?.optionType,
        nowLevel: check.live?.levelStrike,
        putChg: check.putChg ?? check.live?.putChgOi,
        callChg: check.callChg ?? check.live?.callChgOi,
      });
      return;
    }

    const fresh = check.signal;
    const freshDist = Math.abs(spot - Number(fresh.levelStrike));
    if (freshDist > engineState.settings.proximityPoints) {
      logEntry('WAIT_PROXIMITY', {
        ist: istClockLabel(clock),
        spot,
        level: fresh.levelStrike,
        dist: Number(freshDist.toFixed(1)),
        need: engineState.settings.proximityPoints,
        afterRevalidate: true,
      });
      return;
    }

    let freshConfirmed = false;
    try {
      freshConfirmed = await hasReactionConfirmation(clock, fresh);
    } catch (err) {
      engineState.lastError = `1m reaction: ${err.message}`;
      return;
    }
    if (!freshConfirmed) {
      logEntry('WAIT_REACTION', {
        ist: istClockLabel(clock),
        optionType: fresh.optionType,
        level: fresh.levelStrike,
        spot,
        afterRevalidate: true,
      });
      return;
    }

    await placeLongOption(clock, fresh, spot);
  } catch (err) {
    engineState.lastError = `Entry loop: ${err.message}`;
    logEntry('ENTRY_LOOP_ERROR', { error: err.message });
  } finally {
    engineState.evaluatingEntry = false;
  }
}

async function placeLongOption(clock, signal, spot) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) return;
    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) return;

    const symbol = getEngineSymbol();
    const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    const expiry = signal.expiry || (await getEntryExpiry(symbol, clock.dateKey));
    const strikeStep = getStrikeStep(symbol);
    const strike = pickStrike({
      entrySpot: spot,
      strikeStep,
      optionType,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `OI Wall: missing ${optionType} premium for ${strike}`;
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 5);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;
    const charges = engineState.settings.perTradeCost;
    const tgPct = engineState.settings.targetPct;
    const hasSl = engineState.settings.hasStopLoss;
    const slPct = engineState.settings.stopLossPct;
    const targetPremium = entryPremium * (1 + tgPct / 100);
    const stopLossPremium = hasSl
      ? Math.max(0.05, entryPremium * (1 - slPct / 100))
      : null;

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
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number(invested.toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: hasSl ? 'PCT' : null,
      targetMode: 'PCT',
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Buy ${optionType} · wall ${signal.levelStrike} · ${signal.dominantSide} · ΔOI ok`,
      notes: `oi_wall; level=${signal.levelStrike}; side=${signal.dominantSide}; ratio=${signal.ratio}; tg=${tgPct}%; sl=${hasSl ? `${slPct}%` : 'off'}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradesTodayCount += 1;
    engineState.tradesTodayDateKey = clock.dateKey;
    engineState.armedBias = null;
    engineState.oiFlipUntilMs = 0;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      levelStrike: signal.levelStrike,
      entryPremium: Number(entryPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
    });
    pushNotification({
      type: 'ENTRY',
      strategy: 'OI Wall',
      title: `Entered ${optionType} ${strike}`,
      body: `Wall ${signal.levelStrike} · +${tgPct}%${hasSl ? ` / −${slPct}%` : ''} · ₹${Number(entryPremium.toFixed(2))}`,
      meta: { tradeId: tradeDoc._id.toString(), optionType, strike },
      dedupeKey: `morning-oi-entry:${tradeDoc._id.toString()}`,
    });
    await subscribeOpenOption(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), error: err.message });
  } finally {
    engineState.enteringTrade = false;
  }
}

async function onOptionTick({ ltp }) {
  engineState.lastOptionTick = { ltp: Number(ltp), ts: Date.now() };
  await checkOpenTrade({ preferTicks: true });
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  if (!engineState.running || engineState.closingTrade) return;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return;

  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    return;
  }

  if (clock.dateKey !== trade.entryDateKey) {
    const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    await finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason: 'DAY_CLOSE', forceChain: true });
    return;
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: true,
    forceChain: !preferTicks && !optionTickIsFresh(),
  });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);

  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;
  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) return;

  if (trade.stopLossPremium != null && optionLtp <= Number(trade.stopLossPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.stopLossPremium),
      mark,
      reason: 'STOP_LOSS',
    });
    return;
  }
  if (trade.targetPremium != null && optionLtp >= Number(trade.targetPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.targetPremium),
      mark,
      reason: 'TARGET',
    });
    return;
  }
  if (isEodExitTime(clock.minutes)) {
    await finalizeTrade(trade, {
      exitPremium: optionLtp,
      mark,
      reason: 'DAY_CLOSE',
      forceChain: true,
    });
  }
}

async function finalizeTrade(trade, { exitPremium, mark, reason, forceChain = false }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  try {
    let resolvedMark = mark;
    if (forceChain || !Number.isFinite(mark?.optionLtp) || mark?.source === 'entry') {
      resolvedMark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    }
    const markSource = resolvedMark?.source || 'unknown';
    const liveExitMark = markSource === 'websocket' || markSource === 'chain';
    if (!liveExitMark && !forceChain) {
      engineState.lastError = 'Exit blocked — waiting for live Dhan LTP';
      return;
    }
    const safeExitPremium = Math.max(
      0.05,
      Number(exitPremium) || Number(resolvedMark?.optionLtp) || 0.05,
    );
    const finalValue = safeExitPremium * trade.qty;
    const invested = (Number(trade.entryPremium) || 0) * trade.qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExitPremium.toFixed(2));
    trade.exitSpot = Number(Number(resolvedMark?.spot || engineState.lastSpot || trade.entrySpot).toFixed(2));
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct = investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.notes = [trade.notes, `exitMark=${markSource}; pnl=${Number(pnl.toFixed(2))}`]
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

    logEntry('EXIT_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: trade._id.toString(),
      reason,
      pnl,
      exitPremium: safeExitPremium,
    });
    pushNotification({
      type: 'EXIT',
      strategy: 'OI Wall',
      title: `Closed ${trade.optionType} ${trade.strike}`,
      body: `${reason} · P/L ₹${Number(pnl.toFixed(2))} · exit ₹${Number(safeExitPremium.toFixed(2))}`,
      meta: { tradeId: trade._id.toString(), reason, pnl },
      dedupeKey: `morning-oi-exit:${trade._id.toString()}`,
    });
    engineState.lastExitAtMs = Date.now();
    clearOpenTrade();
  } catch (err) {
    engineState.lastError = `Exit failed: ${err.message}`;
  } finally {
    engineState.closingTrade = false;
  }
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    const clock = getIstClock(new Date());
    refreshLiveOiBoard(clock).catch((err) => {
      engineState.lastOiError = err.message || 'OI board failed';
      if (!engineState.liveOiBoard) {
        engineState.lastError = `OI board: ${engineState.lastOiError}`;
      }
    });
    refreshLiveSignalStatus(clock).catch((err) => {
      engineState.lastError = `OI Wall signal: ${err.message}`;
    });
    evaluateEntry().catch((err) => {
      engineState.lastError = `OI Wall entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `OI Wall exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  if (engineState.running) {
    if (settings && Object.keys(settings).length > 0) {
      engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
      syncEngineSymbolFromSettings();
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({
    ...engineState.settings,
    ...settings,
    symbol: settings.symbol || symbol,
  });
  syncEngineSymbolFromSettings();
  engineState.lastError = null;
  logEntry('ENGINE_START', { symbol: getEngineSymbol(), settings: engineState.settings });
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    await dedupeOpenTradesInDb(clock);
    engineState.expiry = await getNearestWeeklyExpiry(getEngineSymbol());
    engineState.expiryDateKey = clock.dateKey;
    const orphan = await dedupeOpenTradesInDb(clock);
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      await subscribeOpenOption(orphan);
      startPositionPoll();
      await checkOpenTrade();
    }
  } catch (err) {
    engineState.lastError = `OI Wall setup: ${err.message}`;
  }
  engineState.running = true;
  engineState.startedAt = new Date();
  startPoll();
  await syncOiWallNotificationsWithDb();
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  if (engineState.pollTimer) {
    clearInterval(engineState.pollTimer);
    engineState.pollTimer = null;
  }
  clearOpenTrade();
  engineState.running = false;
  engineState.startedAt = null;
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  const prevSymbol = getEngineSymbol();
  const next = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.settings = next;
  syncEngineSymbolFromSettings();
  if (getEngineSymbol() !== prevSymbol) {
    try {
      engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
      engineState.expiry = null;
      engineState.expiryDateKey = null;
      engineState.morningSignal = null;
      engineState.armedBias = null;
    } catch (err) {
      engineState.lastError = `Symbol change: ${err.message}`;
    }
  }
  try {
    const wallet = await ensureWallet();
    wallet.strategy12EngineSettings = next;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Settings persist failed: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy12EngineSettings
      ? wallet.strategy12EngineSettings.toObject?.() || wallet.strategy12EngineSettings
      : {};
    // Migrate old morning-only / points exits → all-day multi-trade + % exits.
    const migrated = { ...persisted };
    if (!migrated.tradeFromTime) {
      migrated.tradeFromTime = migrated.oiScanFromTime === '09:15' ? '09:20' : (migrated.oiScanFromTime || '09:20');
    }
    if (!migrated.tradeToTime) {
      const oldLast = String(migrated.lastEntryTime || '');
      migrated.tradeToTime =
        oldLast === '10:30' || oldLast === '11:30' || !oldLast ? '15:10' : oldLast;
    } else if (migrated.tradeToTime === '10:30' || migrated.tradeToTime === '11:30') {
      migrated.tradeToTime = '15:10';
    }
    if (migrated.targetPct == null) {
      migrated.targetPct = DEFAULT_TARGET_PCT;
    }
    if (migrated.stopLossPct == null || migrated.stopLossPct === '') {
      migrated.stopLossPct = DEFAULT_STOP_PCT;
    }
    delete migrated.targetPoints;
    delete migrated.stopLossPoints;
    const normalized = normalizeSettings({ ...migrated, symbol: migrated.symbol || symbol });
    wallet.strategy12EngineSettings = normalized;
    await wallet.save();
    return startEngine({ symbol: normalized.symbol || symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `OI Wall boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

async function resumeOpenPositionFromDb() {
  if (!engineState.running) return { ok: false, reason: 'ENGINE_OFFLINE' };
  const clock = getIstClock(new Date());
  try {
    await syncEngineTradeStateFromDb(clock);
    if (!engineState.openTradeId) return { ok: true, resumed: false, state: getEngineSnapshot() };
    const trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (!trade || trade.exitTime) {
      clearOpenTrade();
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    await subscribeOpenOption(trade);
    if (!engineState.positionPollTimer) startPositionPoll();
    await checkOpenTrade();
  } catch (err) {
    engineState.lastError = `Resume: ${err.message}`;
  }
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function syncOiWallNotificationsWithDb() {
  try {
    const rows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY }).select({ _id: 1 }).lean();
    const ids = rows.map((r) => String(r._id));
    pruneTradeNotifications({ strategy: 'OI Wall', validTradeIds: ids });
  } catch (err) {
    console.warn('[OI Wall] notification sync:', err.message);
  }
}

async function ensureEngineRunning() {
  if (!engineState.running) return bootEngineFromDb();
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  await syncOiWallNotificationsWithDb();
  if (engineState.openTradeId && !engineState.positionPollTimer) {
    const trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (trade && !trade.exitTime) {
      await subscribeOpenOption(trade);
      startPositionPoll();
    }
  }
  return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    symbol: getEngineSymbol(),
    startedAt: engineState.startedAt,
    lotSize: engineState.lotSize,
    expiry: engineState.expiry,
    settings: engineState.settings,
    lastSpot: engineState.lastSpot,
    lastOptionTick: engineState.lastOptionTick,
    morningSignal: engineState.morningSignal,
    liveSignal: engineState.liveSignal,
    liveOiBoard: engineState.liveOiBoard,
    lastOiError: engineState.lastOiError,
    lastCandleError: engineState.lastCandleError,
    candleInterval: '1',
    oneMinuteBars: engineState.todayBars1m.length,
    tradesTodayCount: engineState.tradesTodayCount,
    maxTradesPerDay: engineState.settings.maxTradesPerDay,
    openTradeId: engineState.openTradeId,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    openPositionMark: engineState.openPositionMark,
    scenarioLabel: 'OI Wall Entry',
  };
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
  await dedupeOpenTradesInDb(clock);
  await syncEngineTradeStateFromDb(clock);
  await syncOiWallNotificationsWithDb();
  if (engineState.openTradeId && engineState.running && !engineState.positionPollTimer) {
    const openInDb = await LivePaperTrade.findById(engineState.openTradeId);
    if (openInDb && !openInDb.exitTime) {
      await subscribeOpenOption(openInDb);
      startPositionPoll();
    }
  }
  return { ok: true };
}

async function closeOpenPosition() {
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return { ok: false, error: 'No open trade' };
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return { ok: false, error: 'No open trade' };
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
  await finalizeTrade(trade, {
    exitPremium: mark.optionLtp,
    mark,
    reason: 'MANUAL_CLOSE',
    forceChain: true,
  });
  return { ok: true, state: getEngineSnapshot() };
}

async function refreshOpenPositionMarkForStatus() {
  if (!engineState.openTradeId) return null;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return null;
  const clock = getIstClock(new Date());
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);
  return positionMark;
}

async function clearDailySkipState() {
  engineState.armedBias = null;
  engineState.oiFlipUntilMs = 0;
  engineState.morningSignal = null;
  return { ok: true };
}

module.exports = {
  STRATEGY_KEY,
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
};

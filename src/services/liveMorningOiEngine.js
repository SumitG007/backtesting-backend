/**
 * Strategy 7 (UI) — NIFTY OI Wall Entry paper live.
 * Multi-trade: live OI wall · Put≥Call → CE / Call→PE · enter only on pure signal at fill time.
 * Default target +15% / SL −10% on option premium · EOD square-off. Skip if OI/ΔOI flips before entry.
 * Display-only overall buildup (Long/Short buildup, covering, unwinding) on UI + notifications.
 * After max trades: keep full signals + notifications, no new entries.
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey, buildIstWallClockTimestamp, istCashSessionBucketStart, wallClockIsoFromMinutes } = require('../utils/dateTime');
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
  listFutureExpiries,
  resolveFutureInstrument,
  getFutureLtp,
} = require('./dhanLiveService');
const { fetchTradingDayCandles, fetchIntradayCandlesBySecurity } = require('./dhanDataService');
const { STRATEGY_TWELVE_MORNING_OI_LIVE_KEY } = require('../strategies/keys');
const { pushNotification, pruneTradeNotifications } = require('./notificationHub');
const { broadcast } = require('./realtimeSocket');

const STRATEGY_KEY = STRATEGY_TWELVE_MORNING_OI_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy12';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy12:option';
/** Fast live polls — keep under Dhan option-chain cache floor (~4s). */
const POLL_INTERVAL_MS = 2000;
const POSITION_POLL_MS = 1000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 4000;
const TICK_FRESH_MAX_AGE_MS = 20000;
const STATUS_MARK_REFRESH_MIN_GAP_MS = 750;
const MARK_DB_PERSIST_MIN_GAP_MS = 2000;
const LIVE_MARK_EMIT_MIN_GAP_MS = 100;
const MIN_HOLD_MS = 2000;
const OI_REFRESH_MIN_GAP_MS = 5000;
const OI_BOARD_REFRESH_MIN_GAP_MS = 4000;
const CANDLE_REFRESH_MIN_GAP_MS = 8000;
const FUT_PRICE_REFRESH_MIN_GAP_MS = 2000;
const DEFAULT_CANDLE_INTERVAL = '1';
/** Favorable candle confirm only (FUT + option). Live proximity stays on 1m. */
const DEFAULT_CONFIRM_CANDLE_INTERVAL = '5';
const CONFIRM_CANDLE_REFRESH_MIN_GAP_MS = 15000;
const DEFAULT_TRADE_FROM = 560; // 09:20
const DEFAULT_TRADE_TO = 910; // 15:10
const DEFAULT_EOD = 920; // 15:20
const DEFAULT_TARGET_PCT = 15;
const DEFAULT_STOP_PCT = 10;
/** After OI side flip, wait before arming a new entry setup. */
const OI_FLIP_COOLDOWN_MS = 60_000;
/** Board shows enough strikes around FUT to catch the real high-OI wall (e.g. 24000). */
const OI_BOARD_LOOKAROUND = 12;
/** Clear Put/Call dominance required on the wall (e.g. Put ≥ 1.2× Call). */
const DEFAULT_MIN_OI_RATIO = 1.2;
/** Enter only within this many minutes after the confirm candle closes. */
const DEFAULT_CONFIRM_ENTRY_WINDOW_MIN = 2;

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
    proximityPoints: 20,
    strikeLookaround: 10,
    strikeMode: 'ATM',
    maxTradesPerDay: 2,
    cooldownMinutes: 2,
    candleInterval: DEFAULT_CANDLE_INTERVAL,
    confirmCandleInterval: DEFAULT_CONFIRM_CANDLE_INTERVAL,
    minOiRatio: DEFAULT_MIN_OI_RATIO,
    confirmEntryWindowMinutes: DEFAULT_CONFIRM_ENTRY_WINDOW_MIN,
    perTradeCost: 100,
  },
  lotSize: 65,
  expiry: null,
  expiryDateKey: null,
  /** Master price for ATM / proximity / candles = current month FUT LTP. */
  lastFut: null,
  lastFutFetchAt: 0,
  futExpiry: null,
  futInstrument: null,
  /** Option-chain cash/index print (secondary; not used for signals). */
  chainSpot: null,
  /** Alias of lastFut for older UI fields — signals always use FUT. */
  lastSpot: null,
  lastOptionTick: null,
  morningSignal: null,
  /** Live truth for UI — never sticky Buy CE when invalid. */
  liveSignal: null,
  lastSignalNotifKey: null,
  liveOiBoard: null,
  /** Display-only overall FUT price + option ΔOI regime (does not gate entries). */
  marketStructure: null,
  armedBias: null,
  oiFlipUntilMs: 0,
  lastOiBoardFetchAt: 0,
  lastOiFetchAt: 0,
  lastOiError: null,
  lastFutError: null,
  todayBars1m: [],
  /** 'FUT' | 'INDEX' | null — confirm must only use FUT. */
  todayBars1mSource: null,
  lastCandleFetchAt: 0,
  lastCandleError: null,
  /** Confirm-timeframe bars (5m/15m) — FUT + entry option. */
  todayConfirmBarsFut: [],
  todayConfirmBarsOption: [],
  lastConfirmFutFetchAt: 0,
  lastConfirmOptionFetchAt: 0,
  confirmOptionCacheKey: null,
  lastConfirmCandleError: null,
  tradesTodayCount: 0,
  tradesTodayDateKey: null,
  /** One CE (support) + one PE (resistance) max per day. */
  sidesTradedToday: { CE: false, PE: false },
  /** Prevent re-entry on the same closed confirm candle. */
  usedConfirmBarKeys: new Set(),
  lastExitAtMs: 0,
  openTradeId: null,
  /** Lite fields for instant tick → UI MTM without waiting on Mongo. */
  openTradeLite: null,
  closingTrade: false,
  enteringTrade: false,
  evaluatingEntry: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
  lastMarkPersistAt: 0,
  lastLiveMarkEmitAt: 0,
  liveMarkEmitTimer: null,
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

/** Nearest NSE FUT contract for the engine underlying (rollover when expiry passes). */
async function ensureFutInstrument(clock = null) {
  const symbol = getEngineSymbol();
  const today = (clock && clock.dateKey) || getIstClock(new Date()).dateKey;
  const cached = engineState.futInstrument;
  if (
    cached?.securityId
    && engineState.futExpiry
    && String(engineState.futExpiry) >= today
    && String(cached.symbol || '').toUpperCase() === symbol
  ) {
    return cached;
  }
  const expiries = await listFutureExpiries(symbol);
  if (!Array.isArray(expiries) || expiries.length === 0) {
    throw new Error(`No FUT contracts for ${symbol}`);
  }
  const nearest = expiries[0];
  const inst = await resolveFutureInstrument({ symbol, expiry: nearest.expiry });
  engineState.futInstrument = inst;
  engineState.futExpiry = inst.expiry;
  return inst;
}

/** Live FUT LTP — master price for ATM, proximity, and signal distance. */
async function refreshFutPrice({ force = false, clock = null } = {}) {
  const now = Date.now();
  if (
    !force
    && Number.isFinite(engineState.lastFut)
    && now - engineState.lastFutFetchAt < FUT_PRICE_REFRESH_MIN_GAP_MS
  ) {
    return engineState.lastFut;
  }
  try {
    const inst = await ensureFutInstrument(clock);
    const { ltp } = await getFutureLtp({ symbol: getEngineSymbol(), expiry: inst.expiry });
    if (Number.isFinite(ltp) && ltp > 0) {
      engineState.lastFut = Number(ltp);
      engineState.lastSpot = engineState.lastFut;
      engineState.lastFutFetchAt = now;
      engineState.lastFutError = null;
      return engineState.lastFut;
    }
    throw new Error('FUT LTP unavailable');
  } catch (err) {
    engineState.lastFutError = err.message || 'FUT price failed';
    if (!Number.isFinite(engineState.lastFut)) {
      throw err;
    }
    return engineState.lastFut;
  }
}

function masterPrice() {
  const fut = Number(engineState.lastFut);
  if (Number.isFinite(fut) && fut > 0) return fut;
  const spot = Number(engineState.lastSpot);
  return Number.isFinite(spot) && spot > 0 ? spot : null;
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

  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 20);
  const strikeLookaround = Math.max(1, Math.floor(Number(settings.strikeLookaround) || 10));
  const maxTradesPerDay = Math.max(1, Math.min(30, Math.floor(Number(settings.maxTradesPerDay) || 2)));
  const cooldownMinutes = Math.max(0, Math.min(60, Number(settings.cooldownMinutes) || 2));
  const minOiRatio = Math.max(
    1.05,
    Math.min(3, Number(settings.minOiRatio) || DEFAULT_MIN_OI_RATIO),
  );
  const confirmEntryWindowMinutes = Math.max(
    1,
    Math.min(5, Math.floor(Number(settings.confirmEntryWindowMinutes) || DEFAULT_CONFIRM_ENTRY_WINDOW_MIN)),
  );
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
    confirmCandleInterval: String(settings.confirmCandleInterval || DEFAULT_CONFIRM_CANDLE_INTERVAL) === '15'
      ? '15'
      : '5',
    minOiRatio,
    confirmEntryWindowMinutes,
    perTradeCost,
  };
}

function getConfirmCandleInterval() {
  return String(engineState.settings.confirmCandleInterval || DEFAULT_CONFIRM_CANDLE_INTERVAL) === '15'
    ? '15'
    : '5';
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

function getMinOiRatio() {
  return Math.max(1.05, Number(engineState.settings.minOiRatio) || DEFAULT_MIN_OI_RATIO);
}

function getConfirmEntryWindowMinutes() {
  return Math.max(
    1,
    Math.floor(Number(engineState.settings.confirmEntryWindowMinutes) || DEFAULT_CONFIRM_ENTRY_WINDOW_MIN),
  );
}

function isOiDominanceClear(ratio) {
  return Number.isFinite(Number(ratio)) && Number(ratio) >= getMinOiRatio();
}

/**
 * Confirm candle just closed → entry only for the next N IST minutes.
 * Example: 10:25–10:30 bar closes at 10:30 → allow 10:30 and 10:31 if window=2.
 */
function isConfirmFreshForEntry(futCandle, clock) {
  if (!futCandle || !clock || !Number.isFinite(Number(futCandle.bucket))) return false;
  const step = Math.max(
    1,
    Number(futCandle.intervalMinutes) || (getConfirmCandleInterval() === '15' ? 15 : 5),
  );
  const closeMin = Number(futCandle.bucket) + step;
  const windowMin = getConfirmEntryWindowMinutes();
  return clock.minutes >= closeMin && clock.minutes < closeMin + windowMin;
}

function isStrongBuildupFighting(optionType, marketStructure = engineState.marketStructure) {
  if (!marketStructure || !optionType) return false;
  const key = String(marketStructure.key || '');
  if (key !== 'LONG_BUILDUP' && key !== 'SHORT_BUILDUP') return false;
  const lean = marketStructure.alignsWith === 'PE' || marketStructure.alignsWith === 'CE'
    ? marketStructure.alignsWith
    : null;
  if (!lean) return false;
  return lean !== optionType;
}

/**
 * Level = highest total OI near spot (the real wall, e.g. 24000).
 * Bias on that strike: Put OI ≥ Call OI → Buy CE, else Buy PE.
 * Clear dominance (ratio ≥ minOiRatio, default 1.2) is enforced at signal/entry time.
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
  if (!isOiDominanceClear(live.ratio)) {
    return {
      ok: false,
      reason: 'WEAK_OI_RATIO',
      ratio: live.ratio,
      need: getMinOiRatio(),
      live,
    };
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

function barOpenMs(bar) {
  const t = new Date(bar?.[0]).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function candleShapeFromOhlc(open, high, low, close, prevClose, meta = {}) {
  if (![open, high, low, close].every(Number.isFinite)) return null;
  if (!(close > open || close < open)) return null; // reject flat/doji
  return {
    open,
    high,
    low,
    close,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    green: close > open,
    red: close < open,
    closed: true,
    ...meta,
  };
}

/**
 * Build confirm-interval OHLC from FUT 1m bars on the NSE 09:15 grid.
 * Closed detection uses IST minutes — never trust "last row is forming".
 */
function aggregateConfirmBarsFrom1m(rows1m, intervalMinutes = 5) {
  const step = Math.max(1, Number(intervalMinutes) || 5);
  const byKey = new Map();
  for (let i = 0; i < (rows1m || []).length; i += 1) {
    const bar = rows1m[i];
    const clock = getIstClock(bar[0]);
    if (!clock?.dateKey) continue;
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    const bucket = istCashSessionBucketStart(clock.minutes, step);
    const key = `${clock.dateKey}:${bucket}`;
    const o = Number(bar[1]);
    const h = Number(bar[2]);
    const l = Number(bar[3]);
    const c = Number(bar[4]);
    if (![o, h, l, c].every(Number.isFinite)) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        dateKey: clock.dateKey,
        bucket,
        open: o,
        high: h,
        low: l,
        close: c,
        barKey: wallClockIsoFromMinutes(clock.dateKey, bucket),
        oneMinCount: 1,
      });
    } else {
      existing.high = Math.max(existing.high, h);
      existing.low = Math.min(existing.low, l);
      existing.close = c;
      existing.oneMinCount += 1;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
    return a.bucket - b.bucket;
  });
}

/**
 * Latest fully closed confirm bucket only (exact previous grid bar — no stale older bar).
 * Example: at 10:31 with 5m → only the 10:25–10:30 bar (closes at 10:30).
 */
function readExactClosedConfirmFromAgg(aggBars, {
  intervalMinutes = 5,
  clock,
  minBarOpenMinutes = null,
} = {}) {
  if (!clock || !Array.isArray(aggBars) || aggBars.length === 0) return null;
  const step = Math.max(1, Number(intervalMinutes) || 5);
  const currentBucket = istCashSessionBucketStart(clock.minutes, step);
  const expectedOpen = currentBucket - step;
  if (!Number.isFinite(expectedOpen)) return null;
  if (minBarOpenMinutes != null && expectedOpen < minBarOpenMinutes) return null;
  // Bucket not closed until nowMinutes >= expectedOpen + step
  if (clock.minutes < expectedOpen + step) return null;

  let idx = -1;
  for (let i = 0; i < aggBars.length; i += 1) {
    const b = aggBars[i];
    if (b.dateKey === clock.dateKey && b.bucket === expectedOpen) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const bar = aggBars[idx];
  // Full bucket only — e.g. 5 of 5 one-minute prints for a 5m confirm.
  if (bar.oneMinCount < step) return null;
  const prev = idx > 0 && aggBars[idx - 1].dateKey === bar.dateKey ? aggBars[idx - 1] : null;
  return candleShapeFromOhlc(bar.open, bar.high, bar.low, bar.close, prev ? prev.close : null, {
    barKey: bar.barKey,
    openMs: new Date(bar.barKey).getTime(),
    closeMs: buildIstWallClockTimestamp(bar.dateKey, bar.bucket + step),
    intervalMinutes: step,
    bucket: bar.bucket,
    oneMinCount: bar.oneMinCount,
    source: 'FUT_1M_AGG',
  });
}

/**
 * From vendor 5m/15m rows: take the bar that opens at expectedOpen and is fully closed by IST clock.
 */
function readExactClosedConfirmFromRows(rows, {
  intervalMinutes = 5,
  clock,
  minBarOpenMinutes = null,
  matchBucket = null,
} = {}) {
  if (!clock || !Array.isArray(rows) || rows.length === 0) return null;
  const step = Math.max(1, Number(intervalMinutes) || 5);
  const currentBucket = istCashSessionBucketStart(clock.minutes, step);
  const expectedOpen = matchBucket != null ? matchBucket : currentBucket - step;
  if (!Number.isFinite(expectedOpen)) return null;
  if (minBarOpenMinutes != null && expectedOpen < minBarOpenMinutes) return null;
  if (clock.minutes < expectedOpen + step) return null;

  let idx = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const c = getIstClock(rows[i][0]);
    if (c.dateKey !== clock.dateKey) continue;
    // Exact IST open minute only (map off-grid stamps to session bucket).
    const barBucket = istCashSessionBucketStart(c.minutes, step);
    if (barBucket === expectedOpen) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const bar = rows[idx];
  const prev = idx > 0 ? rows[idx - 1] : null;
  const open = Number(bar[1]);
  const high = Number(bar[2]);
  const low = Number(bar[3]);
  const close = Number(bar[4]);
  const prevClose = prev != null ? Number(prev[4]) : null;
  return candleShapeFromOhlc(open, high, low, close, prevClose, {
    barKey: String(bar[0] || ''),
    openMs: barOpenMs(bar),
    closeMs: buildIstWallClockTimestamp(clock.dateKey, expectedOpen + step),
    intervalMinutes: step,
    bucket: expectedOpen,
    source: 'VENDOR_TF',
  });
}

/** Today's FUT session Open / High / Low from 1m bars (+ live LTP for H/L). */
function summarizeFutDayOhl(rows = engineState.todayBars1m) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { open: null, high: null, low: null, bars: 0 };
  }
  let open = null;
  let high = -Infinity;
  let low = Infinity;
  for (let i = 0; i < rows.length; i += 1) {
    const bar = rows[i];
    const o = Number(bar[1]);
    const h = Number(bar[2]);
    const l = Number(bar[3]);
    if (open == null && Number.isFinite(o)) open = o;
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
  }
  const live = Number(engineState.lastFut ?? engineState.lastSpot);
  if (Number.isFinite(live)) {
    if (live > high) high = live;
    if (live < low) low = live;
  }
  return {
    open: Number.isFinite(open) ? Number(open.toFixed(2)) : null,
    high: Number.isFinite(high) && high !== -Infinity ? Number(high.toFixed(2)) : null,
    low: Number.isFinite(low) && low !== Infinity ? Number(low.toFixed(2)) : null,
    bars: rows.length,
  };
}

/** Sum Call+Put ΔOI across the live OI board (overall chain change today). */
function sumBoardOiChange(board = engineState.liveOiBoard) {
  const strikes = board?.strikes;
  if (!Array.isArray(strikes) || strikes.length === 0) {
    return { callChgOi: null, putChgOi: null, totalChgOi: null };
  }
  let callChg = 0;
  let putChg = 0;
  let sawCall = false;
  let sawPut = false;
  for (let i = 0; i < strikes.length; i += 1) {
    const c = Number(strikes[i]?.callChgOi);
    const p = Number(strikes[i]?.putChgOi);
    if (Number.isFinite(c)) {
      callChg += c;
      sawCall = true;
    }
    if (Number.isFinite(p)) {
      putChg += p;
      sawPut = true;
    }
  }
  if (!sawCall && !sawPut) {
    return { callChgOi: null, putChgOi: null, totalChgOi: null };
  }
  const callChgOi = sawCall ? callChg : null;
  const putChgOi = sawPut ? putChg : null;
  const totalChgOi = (sawCall ? callChg : 0) + (sawPut ? putChg : 0);
  return { callChgOi, putChgOi, totalChgOi };
}

/**
 * Overall market structure from FUT session move + overall option ΔOI.
 * Display / notification only — never blocks or changes entry rules.
 */
function classifyOverallBuildup({ priceDelta, oiDelta, futOpen, futPrice } = {}) {
  const priceOk = Number.isFinite(priceDelta);
  const oiOk = Number.isFinite(oiDelta);
  if (!priceOk || !oiOk) {
    return {
      key: 'UNAVAILABLE',
      label: 'Buildup n/a',
      lean: null,
      hint: 'Need FUT session open + option ΔOI',
      priceDelta: priceOk ? Number(priceDelta.toFixed(1)) : null,
      oiDelta: oiOk ? Math.round(oiDelta) : null,
      futOpen: Number.isFinite(futOpen) ? futOpen : null,
      futPrice: Number.isFinite(futPrice) ? futPrice : null,
      alignsWith: null,
    };
  }

  const priceEps = Math.max(5, Math.abs(Number(futPrice) || 0) * 0.0002);
  const oiEps = 1000;
  const priceUp = priceDelta > priceEps;
  const priceDown = priceDelta < -priceEps;
  const oiUp = oiDelta > oiEps;
  const oiDown = oiDelta < -oiEps;

  let key = 'NEUTRAL';
  let label = 'Neutral / chop';
  let lean = null;
  let hint = 'No clear overall buildup yet';
  let alignsWith = null;

  if (priceUp && oiUp) {
    key = 'LONG_BUILDUP';
    label = 'Long buildup';
    lean = 'CE';
    hint = 'Fresh longs · overall bullish bias';
    alignsWith = 'CE';
  } else if (priceDown && oiUp) {
    key = 'SHORT_BUILDUP';
    label = 'Short buildup';
    lean = 'PE';
    hint = 'Fresh shorts · overall bearish bias';
    alignsWith = 'PE';
  } else if (priceUp && oiDown) {
    key = 'SHORT_COVERING';
    label = 'Short covering';
    lean = 'CE_WEAK';
    hint = 'Shorts covering · bounce may fade';
    alignsWith = 'CE';
  } else if (priceDown && oiDown) {
    key = 'LONG_UNWINDING';
    label = 'Long unwinding';
    lean = 'PE_WEAK';
    hint = 'Longs exiting · dip may fade';
    alignsWith = 'PE';
  } else if (priceUp || priceDown) {
    key = 'PRICE_ONLY';
    label = priceUp ? 'Price up · flat OI' : 'Price down · flat OI';
    lean = priceUp ? 'CE' : 'PE';
    hint = 'Price moved but overall OI is flat';
    alignsWith = priceUp ? 'CE' : 'PE';
  } else if (oiUp || oiDown) {
    key = 'OI_ONLY';
    label = oiUp ? 'OI rising · flat price' : 'OI falling · flat price';
    hint = 'OI changing without a clear FUT session move';
  }

  return {
    key,
    label,
    lean,
    hint,
    priceDelta: Number(priceDelta.toFixed(1)),
    oiDelta: Math.round(oiDelta),
    futOpen: Number.isFinite(futOpen) ? Number(Number(futOpen).toFixed(2)) : null,
    futPrice: Number.isFinite(futPrice) ? Number(Number(futPrice).toFixed(2)) : null,
    alignsWith,
  };
}

/** Refresh display-only overall buildup onto engineState.marketStructure. */
function refreshOverallBuildup({ board = engineState.liveOiBoard, futPrice = null } = {}) {
  const day = summarizeFutDayOhl();
  const price = Number(
    futPrice
    ?? engineState.lastFut
    ?? board?.fut
    ?? board?.spot
    ?? engineState.lastSpot,
  );
  const open = Number(day.open);
  const oiParts = sumBoardOiChange(board);
  const priceDelta = Number.isFinite(price) && Number.isFinite(open) ? price - open : null;
  const structure = classifyOverallBuildup({
    priceDelta,
    oiDelta: oiParts.totalChgOi,
    futOpen: open,
    futPrice: price,
  });
  engineState.marketStructure = {
    ...structure,
    callChgOi: oiParts.callChgOi != null ? Math.round(oiParts.callChgOi) : null,
    putChgOi: oiParts.putChgOi != null ? Math.round(oiParts.putChgOi) : null,
    at: new Date().toISOString(),
    source: 'FUT_SESSION_OPEN + OPTION_CHAIN_ΔOI',
    displayOnly: true,
  };
  return engineState.marketStructure;
}

/**
 * FUT closed confirm — real wall reaction only:
 * CE: wick tags support, closes GREEN at/above wall (bounce).
 * PE: wick tags resistance, closes RED at/below wall (reject).
 */
function futCandleConfirms(signal, candle) {
  if (!signal || !candle || !candle.closed) return false;
  const level = Number(signal.levelStrike);
  const prox = Number(engineState.settings.proximityPoints) || 20;
  if (!Number.isFinite(level)) return false;

  if (signal.optionType === 'CE') {
    const taggedSupport = candle.low <= level + prox && candle.low >= level - prox;
    const closedAboveWall = candle.close >= level;
    const bounce = Number.isFinite(candle.prevClose) ? candle.close >= candle.prevClose : true;
    return Boolean(taggedSupport && closedAboveWall && candle.green && bounce);
  }

  const taggedResist = candle.high >= level - prox && candle.high <= level + prox;
  const closedBelowWall = candle.close <= level;
  const reject = Number.isFinite(candle.prevClose) ? candle.close <= candle.prevClose : true;
  return Boolean(taggedResist && closedBelowWall && candle.red && reject);
}

/** Long option premium confirm — closed green candle only (same bucket as FUT). */
function optionPremiumCandleConfirms(candle) {
  if (!candle || !candle.closed) return false;
  const bounce = Number.isFinite(candle.prevClose) ? candle.close >= candle.prevClose : true;
  return Boolean(candle.green && bounce);
}

function sideAlreadyTradedToday(optionType) {
  const side = optionType === 'PE' ? 'PE' : 'CE';
  return Boolean(engineState.sidesTradedToday?.[side]);
}

function markSideTradedToday(optionType) {
  const side = optionType === 'PE' ? 'PE' : 'CE';
  engineState.sidesTradedToday = {
    ...(engineState.sidesTradedToday || { CE: false, PE: false }),
    [side]: true,
  };
}

function confirmBarAlreadyUsed(optionType, futBarKey) {
  if (!futBarKey) return false;
  const key = `${engineState.tradesTodayDateKey || ''}:${optionType}:${futBarKey}`;
  return engineState.usedConfirmBarKeys?.has(key);
}

function markConfirmBarUsed(optionType, futBarKey) {
  if (!futBarKey) return;
  if (!(engineState.usedConfirmBarKeys instanceof Set)) {
    engineState.usedConfirmBarKeys = new Set();
  }
  engineState.usedConfirmBarKeys.add(
    `${engineState.tradesTodayDateKey || ''}:${optionType}:${futBarKey}`,
  );
}

function resolveEntryStrikeForSignal(signal, spot) {
  const optionType = signal?.optionType === 'PE' ? 'PE' : 'CE';
  const strikeStep = getStrikeStep(getEngineSymbol());
  const fut = Number(spot);
  if (!Number.isFinite(fut) || fut <= 0) return null;
  return pickStrike({
    entrySpot: fut,
    strikeStep,
    optionType,
    strikeMode: engineState.settings.strikeMode,
  });
}

/**
 * Publish live signal status for UI + day notifications.
 * Status is never a sticky "Buy CE" when criteria are off.
 * marketStructure is attached for display only (never gates trades).
 */
function publishLiveSignal(next) {
  const prev = engineState.liveSignal;
  const marketStructure = engineState.marketStructure || null;
  const optionType = next.optionType === 'PE' || next.optionType === 'CE' ? next.optionType : null;
  const buildupAligns = Boolean(
    marketStructure?.alignsWith
    && optionType
    && marketStructure.alignsWith === optionType,
  );
  engineState.liveSignal = {
    ...next,
    marketStructure,
    buildupAligns: marketStructure ? buildupAligns : null,
    at: new Date().toISOString(),
    ageMs: 0,
  };
  // Push live signal + open MTM to UI over Socket.IO (throttled).
  publishLiveMarkSnapshot();

  const key = [
    next.status,
    next.optionType || '',
    next.levelStrike || '',
    next.reason || '',
    next.signalOnly ? 'SO' : 'TR',
    next.entryBlock || '',
    marketStructure?.key || '',
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

  if (status === 'OUTSIDE_WINDOW' || status === 'IN_TRADE' || status === 'COOLDOWN') {
    return;
  }

  let type = 'OI_SIGNAL';
  let title = next.label || status;
  let body = next.detail || '';

  if (status === 'CLEARED') {
    type = 'SIGNAL_CLEARED';
    title = next.label || 'Signal cleared';
  } else if (status === 'READY') {
    type = next.signalOnly ? 'SIGNAL_INFO' : 'SIGNAL_READY';
    title = next.label || `${next.signalOnly ? 'Signal' : 'Ready'} ${next.optionType} · ${next.levelStrike}`;
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

  if (marketStructure?.label && marketStructure.key !== 'UNAVAILABLE') {
    const alignNote = optionType && marketStructure.alignsWith
      ? (buildupAligns ? ' · aligns' : ' · differs')
      : '';
    body = [body, `Overall: ${marketStructure.label}${alignNote}`].filter(Boolean).join(' · ');
  }
  if (next.signalOnly) {
    body = [body, 'No trade · signal only'].filter(Boolean).join(' · ');
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
      signalOnly: Boolean(next.signalOnly),
      entryBlock: next.entryBlock || null,
      buyLive: Boolean(next.buyLive),
      marketStructure: marketStructure
        ? {
          key: marketStructure.key,
          label: marketStructure.label,
          lean: marketStructure.lean,
          alignsWith: marketStructure.alignsWith,
          priceDelta: marketStructure.priceDelta,
          oiDelta: marketStructure.oiDelta,
        }
        : null,
      buildupAligns: marketStructure ? buildupAligns : null,
    },
    dedupeKey: `oi-wall-live:${key}:${Math.floor(Date.now() / 30000)}`,
  });
}

async function refreshLiveSignalStatus(clock) {
  const prox = Number(engineState.settings.proximityPoints) || 20;
  const maxTradesHit = engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay;
  const cooldownMs = (Number(engineState.settings.cooldownMinutes) || 0) * 60 * 1000;
  const cooldownActive = Boolean(
    cooldownMs > 0
    && engineState.lastExitAtMs
    && Date.now() - engineState.lastExitAtMs < cooldownMs,
  );

  // Keep display-only overall buildup fresh whenever we evaluate signals.
  try {
    await refreshOneMinuteCandles(clock);
  } catch {
    /* keep prior 1m bars */
  }
  refreshOverallBuildup({ board: engineState.liveOiBoard });

  if (clock.minutes < tradeFromMin() || clock.minutes > tradeToMin()) {
    publishLiveSignal({
      status: 'OUTSIDE_WINDOW',
      label: 'Outside trade window',
      detail: `Active ${engineState.settings.tradeFromTime}–${engineState.settings.tradeToTime}`,
      reason: 'OUTSIDE_WINDOW',
      optionType: null,
      levelStrike: null,
      buyLive: false,
      signalOnly: false,
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
      signalOnly: false,
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
      signalOnly: false,
      entryBlock: maxTradesHit ? 'MAX_TRADES' : null,
    });
    return engineState.liveSignal;
  }

  if (!signal || signal.skip) {
    publishLiveSignal({
      status: maxTradesHit ? 'MAX_TRADES' : 'CLEARED',
      label: maxTradesHit ? 'Max trades · no wall yet' : 'No wall signal',
      detail: maxTradesHit
        ? `${engineState.tradesTodayCount}/${engineState.settings.maxTradesPerDay} done · waiting for next wall signal (info only)`
        : (signal?.skipReason || 'Waiting for dominant OI wall'),
      reason: maxTradesHit ? 'MAX_TRADES' : (signal?.skipReason || 'NO_WALL'),
      optionType: null,
      levelStrike: null,
      buyLive: false,
      signalOnly: maxTradesHit,
      entryBlock: maxTradesHit ? 'MAX_TRADES' : null,
      putOi: signal?.putOi,
      callOi: signal?.callOi,
    });
    return engineState.liveSignal;
  }

  const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
  const sideDone = sideAlreadyTradedToday(optionType);
  let entryBlock = null;
  if (maxTradesHit) entryBlock = 'MAX_TRADES';
  else if (sideDone) entryBlock = 'SAME_SIDE_DONE';
  else if (cooldownActive) entryBlock = 'COOLDOWN';
  const signalOnly = Boolean(entryBlock);

  const level = Number(signal.levelStrike);
  try {
    await refreshFutPrice({ clock });
  } catch {
    /* keep lastFut if any */
  }
  refreshOverallBuildup({
    board: engineState.liveOiBoard,
    futPrice: masterPrice(),
  });
  const spot = Number(masterPrice() ?? signal.spotAtScan);
  const spotDist = Number.isFinite(spot) && Number.isFinite(level) ? Math.abs(spot - level) : null;
  const proximityOk = Number.isFinite(spotDist) && spotDist <= prox;
  const deltaFighting = isDeltaOiFighting(optionType, signal.putChgOi, signal.callChgOi);
  const flipCooling = Date.now() < engineState.oiFlipUntilMs;

  let candle = null;
  let optionCandle = null;
  let candleOk = false;
  let futCandleOk = false;
  let optionCandleOk = false;
  let confirmFresh = false;
  const confirmInterval = getConfirmCandleInterval();
  const minOiRatio = getMinOiRatio();
  const ratioOk = isOiDominanceClear(signal.ratio);
  const buildupFighting = isStrongBuildupFighting(optionType);
  try {
    const confirm = await hasReactionConfirmation(clock, signal, spot);
    candle = confirm.futCandle;
    optionCandle = confirm.optionCandle;
    futCandleOk = Boolean(confirm.futOk);
    optionCandleOk = Boolean(confirm.optionOk);
    confirmFresh = Boolean(confirm.confirmFresh);
    candleOk = Boolean(confirm.ok);
  } catch {
    candleOk = false;
    confirmFresh = false;
  }

  const entryBlockDetail = entryBlock === 'MAX_TRADES'
    ? `${engineState.tradesTodayCount}/${engineState.settings.maxTradesPerDay} trades done · signal only`
    : entryBlock === 'SAME_SIDE_DONE'
      ? `${optionType} side already traded today · signal only`
      : entryBlock === 'COOLDOWN'
        ? 'Cooldown after exit · signal only'
        : null;

  const base = {
    optionType,
    levelStrike: level,
    dominantSide: signal.dominantSide,
    putOi: signal.putOi,
    callOi: signal.callOi,
    putChgOi: signal.putChgOi,
    callChgOi: signal.callChgOi,
    ratio: signal.ratio,
    ratioOk,
    minOiRatio,
    priceSource: 'FUT',
    futExpiry: engineState.futExpiry,
    spot: Number.isFinite(spot) ? spot : null,
    fut: Number.isFinite(spot) ? spot : null,
    spotDist: Number.isFinite(spotDist) ? Number(spotDist.toFixed(1)) : null,
    proximityPoints: prox,
    proximityOk,
    deltaOk: !deltaFighting,
    buildupOk: !buildupFighting,
    candleOk,
    futCandleOk,
    optionCandleOk,
    confirmFresh,
    confirmEntryWindowMinutes: getConfirmEntryWindowMinutes(),
    confirmCandleInterval: confirmInterval,
    candle,
    optionCandle,
    buyLive: false,
    signalOnly,
    entryBlock,
    sidesTradedToday: engineState.sidesTradedToday,
    tradesTodayCount: engineState.tradesTodayCount,
    maxTradesPerDay: engineState.settings.maxTradesPerDay,
  };

  if (flipCooling) {
    publishLiveSignal({
      ...base,
      status: 'CAUTION',
      label: `Stabilizing after flip · was ${optionType}`,
      detail: [
        'OI side flipped recently — wait ~1m before trusting a new bias',
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'OI_FLIP_COOLDOWN',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!ratioOk) {
    publishLiveSignal({
      ...base,
      status: 'CAUTION',
      label: `Weak wall · ${optionType} ${level}`,
      detail: [
        `Need clear OI dominance ≥ ${minOiRatio.toFixed(2)}× (now ${Number(signal.ratio) || '—'}×)`,
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'WEAK_OI_RATIO',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (deltaFighting) {
    publishLiveSignal({
      ...base,
      status: 'CAUTION',
      label: `Watch ${optionType} · wall ${level} · ΔOI fighting`,
      detail: [
        optionType === 'CE'
          ? 'Wall still Put-biased, but Call ΔOI rising faster — not a live buy'
          : 'Wall still Call-biased, but Put ΔOI rising faster — not a live buy',
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'DELTA_OI_FIGHTING',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (buildupFighting) {
    const ms = engineState.marketStructure;
    publishLiveSignal({
      ...base,
      status: 'CAUTION',
      label: `Watch ${optionType} · wall ${level} · buildup fights`,
      detail: [
        `Overall ${ms?.label || 'buildup'} leans ${ms?.alignsWith || '?'} — skips ${optionType}`,
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'BUILDUP_FIGHTING',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!proximityOk) {
    publishLiveSignal({
      ...base,
      status: 'WATCHING',
      label: `Watch ${optionType} · wall ${level}`,
      detail: [
        Number.isFinite(spotDist)
          ? `FUT ${spotDist.toFixed(0)} pts from wall — need ≤ ${prox} pts`
          : 'Waiting for FUT near wall',
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'WAIT_PROXIMITY',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!futCandleOk || !optionCandleOk) {
    const waitingParts = [];
    if (!futCandleOk) waitingParts.push(`FUT ${confirmInterval}m`);
    if (!optionCandleOk) waitingParts.push(`option ${confirmInterval}m`);
    publishLiveSignal({
      ...base,
      status: 'NEAR',
      label: `Near wall · ${optionType} ${level}`,
      detail: [
        optionType === 'CE'
          ? `In proximity — need ${waitingParts.join(' + ') || `${confirmInterval}m`} green bounce confirm (FUT + option)`
          : `In proximity — need FUT ${confirmInterval}m red reject + option ${confirmInterval}m green confirm`,
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'WAIT_CANDLE',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!confirmFresh) {
    publishLiveSignal({
      ...base,
      status: 'NEAR',
      label: `Confirm stale · ${optionType} ${level}`,
      detail: [
        `Closed ${confirmInterval}m OK but entry only within ${getConfirmEntryWindowMinutes()}m of candle close — wait next bar`,
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'CONFIRM_WINDOW_EXPIRED',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (!candleOk) {
    publishLiveSignal({
      ...base,
      status: 'NEAR',
      label: `Near wall · ${optionType} ${level}`,
      detail: [
        'Confirm not ready yet (bucket / same-bar / option match)',
        entryBlockDetail,
      ].filter(Boolean).join(' · '),
      reason: 'WAIT_CANDLE',
      buyLive: false,
    });
    return engineState.liveSignal;
  }

  if (signalOnly) {
    publishLiveSignal({
      ...base,
      status: 'READY',
      label: `SIGNAL ${optionType} · wall ${level}`,
      detail: [
        `Wall ≥${minOiRatio}× · FUT proximity · dual ${confirmInterval}m confirm · within ${getConfirmEntryWindowMinutes()}m window`,
        entryBlockDetail || 'No trade · signal only',
      ].filter(Boolean).join(' · '),
      reason: entryBlock || 'SIGNAL_ONLY',
      buyLive: false,
      signalOnly: true,
    });
    return engineState.liveSignal;
  }

  publishLiveSignal({
    ...base,
    status: 'READY',
    label: `LIVE BUY ${optionType} · wall ${level}`,
    detail: `Wall ≥${minOiRatio}× · FUT proximity · dual ${confirmInterval}m confirm · within ${getConfirmEntryWindowMinutes()}m of close — entry eligible`,
    reason: 'READY',
    buyLive: true,
    signalOnly: false,
    entryBlock: null,
  });
  return engineState.liveSignal;
}

/**
 * Live OI board for UI — option OI walls + FUT price for ATM / dashed line.
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
    let futLtp = null;
    try {
      futLtp = await refreshFutPrice({ force, clock });
    } catch (err) {
      engineState.lastFutError = err.message || 'FUT price failed';
    }
    // Keep day O/H/L fresh for the top bar (cached by CANDLE_REFRESH_MIN_GAP_MS).
    refreshOneMinuteCandles(clock).catch(() => {});
    const lookaround = Math.max(
      OI_BOARD_LOOKAROUND,
      Number(engineState.settings.strikeLookaround) || 10,
    );
    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      lookaroundStrikes: lookaround,
      spotOverride: Number.isFinite(futLtp) ? futLtp : null,
    });
    engineState.lastOiBoardFetchAt = now;
    if (Number.isFinite(snapshot.chainSpot)) engineState.chainSpot = snapshot.chainSpot;
    if (Number.isFinite(snapshot.spot)) {
      engineState.lastSpot = snapshot.spot;
      if (Number.isFinite(futLtp)) engineState.lastFut = futLtp;
    }

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

    let callChgSum = 0;
    let putChgSum = 0;
    let sawCallChg = false;
    let sawPutChg = false;
    for (const row of strikes) {
      if (Number.isFinite(row.putChgOi)) {
        putChgSum += row.putChgOi;
        sawPutChg = true;
      }
      if (Number.isFinite(row.callChgOi)) {
        callChgSum += row.callChgOi;
        sawCallChg = true;
      }
    }
    const oiChg = {
      callChgOi: sawCallChg ? Math.round(callChgSum) : null,
      putChgOi: sawPutChg ? Math.round(putChgSum) : null,
      totalChgOi: (sawCallChg || sawPutChg)
        ? Math.round((sawCallChg ? callChgSum : 0) + (sawPutChg ? putChgSum : 0))
        : null,
    };

    engineState.liveOiBoard = {
      at: new Date().toISOString(),
      dateKey: clock.dateKey,
      priceSource: 'FUT',
      spot: snapshot.spot,
      fut: Number.isFinite(futLtp) ? futLtp : snapshot.spot,
      futExpiry: engineState.futExpiry,
      chainSpot: snapshot.chainSpot ?? engineState.chainSpot,
      atm: snapshot.atm,
      expiry,
      strikeStep: snapshot.strikeStep,
      strikes,
      totals: {
        callOi: totals.callOi ?? null,
        putOi: totals.putOi ?? null,
        callChgOi: oiChg.callChgOi,
        putChgOi: oiChg.putChgOi,
        totalChgOi: oiChg.totalChgOi,
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
    refreshOverallBuildup({
      board: engineState.liveOiBoard,
      futPrice: Number.isFinite(futLtp) ? futLtp : snapshot.spot,
    });
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
  const futSpot = Number(masterPrice());
  const chainLtp = premiumFromChain(chain, optionType);
  if (Number.isFinite(chainLtp) && chainLtp > 0) {
    return {
      optionLtp: chainLtp,
      spot: Number.isFinite(futSpot) ? futSpot : null,
      source: 'chain',
      optionType,
      priceSource: 'FUT',
    };
  }
  const tickLtp = Number(engineState.lastOptionTick?.ltp);
  if (Number.isFinite(tickLtp) && tickLtp > 0) {
    return {
      optionLtp: tickLtp,
      spot: Number.isFinite(futSpot) ? futSpot : null,
      source: 'websocket',
      optionType,
      priceSource: 'FUT',
    };
  }
  const entryPrem = Number(trade.entryPremium);
  return {
    optionLtp: Number.isFinite(entryPrem) ? entryPrem : 0.05,
    spot: Number.isFinite(futSpot) ? futSpot : trade.entrySpot,
    source: 'entry',
    optionType,
    priceSource: 'FUT',
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
    if (Number.isFinite(chain?.chainSpot)) engineState.chainSpot = chain.chainSpot;
    // Keep option premium from chain; never overwrite FUT master with cash spot.
    return getOptionMarkFromTrade(trade, chain);
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
    spot: Number.isFinite(Number(mark.spot)) ? Number(Number(mark.spot).toFixed(2)) : null,
    priceSource: 'FUT',
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

function cacheOpenTradeLite(trade) {
  if (!trade) {
    engineState.openTradeLite = null;
    return null;
  }
  engineState.openTradeLite = {
    _id: trade._id?.toString?.() || String(trade._id || engineState.openTradeId || ''),
    id: trade._id?.toString?.() || String(trade._id || engineState.openTradeId || ''),
    symbol: trade.symbol || getEngineSymbol(),
    optionType: tradeOptionType(trade),
    strike: Number(trade.strike) || null,
    expiryDate: trade.expiryDate || null,
    entryTime: trade.entryTime || null,
    entryPremium: Number(trade.entryPremium) || 0,
    entrySpot: Number(trade.entrySpot) || null,
    qty: Number(trade.qty) || 0,
    lots: Number(trade.lots) || null,
    charges: Number(trade.charges) || 0,
    investedAmount: Number(trade.investedAmount) || null,
    targetPremium: trade.targetPremium != null ? Number(trade.targetPremium) : null,
    stopLossPremium: trade.stopLossPremium != null ? Number(trade.stopLossPremium) : null,
    status: 'OPEN',
  };
  return engineState.openTradeLite;
}

function getLiveMarkSnapshot() {
  return {
    strategyId: 'strategy-9',
    open: Boolean(engineState.openTradeId),
    tradeId: engineState.openTradeId,
    mark: engineState.openPositionMark,
    openTradeLite: engineState.openTradeLite,
    lastFut: engineState.lastFut,
    futExpiry: engineState.futExpiry,
    liveSignal: engineState.liveSignal,
    at: new Date().toISOString(),
  };
}

function publishLiveMarkSnapshot(extra = {}) {
  const payload = { ...getLiveMarkSnapshot(), ...extra };
  const now = Date.now();
  const gap = now - engineState.lastLiveMarkEmitAt;
  if (gap >= LIVE_MARK_EMIT_MIN_GAP_MS) {
    engineState.lastLiveMarkEmitAt = now;
    broadcast('paper-live:mark', payload);
    return;
  }
  if (engineState.liveMarkEmitTimer) return;
  engineState.liveMarkEmitTimer = setTimeout(() => {
    engineState.liveMarkEmitTimer = null;
    engineState.lastLiveMarkEmitAt = Date.now();
    broadcast('paper-live:mark', getLiveMarkSnapshot());
  }, Math.max(20, LIVE_MARK_EMIT_MIN_GAP_MS - gap));
}

function publishOpenMark(trade, mark, clock, { persist = true, forcePersist = false } = {}) {
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  publishLiveMarkSnapshot();
  if (!persist) return positionMark;
  const now = Date.now();
  if (!forcePersist && now - engineState.lastMarkPersistAt < MARK_DB_PERSIST_MIN_GAP_MS) {
    return positionMark;
  }
  engineState.lastMarkPersistAt = now;
  persistOpenMarkToDb(trade, positionMark).catch((err) => {
    engineState.lastError = `Mark persist: ${err.message}`;
  });
  return positionMark;
}

/** Instant UI update from Dhan option websocket tick (no Mongo wait). */
function publishTickMarkFast(ltp) {
  const lite = engineState.openTradeLite;
  if (!lite || !Number.isFinite(ltp) || ltp <= 0) return null;
  const entry = Number(lite.entryPremium) || 0;
  const qty = Number(lite.qty) || 0;
  const unrealized = (ltp - entry) * qty - (Number(lite.charges) || 0);
  const clock = getIstClock(new Date());
  const positionMark = {
    optionType: lite.optionType,
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    spot: Number.isFinite(Number(masterPrice())) ? Number(Number(masterPrice()).toFixed(2)) : null,
    priceSource: 'FUT',
    source: 'websocket',
    isLiveMark: true,
    unrealizedPnl: Number(unrealized.toFixed(2)),
    at: new Date().toISOString(),
    ist: istClockLabel(clock),
  };
  engineState.openPositionMark = positionMark;
  publishLiveMarkSnapshot();
  return positionMark;
}

async function subscribeOpenOption(trade) {
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.lastOptionTick = null;
  cacheOpenTradeLite(trade);
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

/**
 * Rewrite an open paper trade that was entered on cash Nifty so entrySpot /
 * mark spot match local FUT-based engine (option legs/premium unchanged).
 */
async function alignOpenTradeToFut(trade, clock = getIstClock(new Date())) {
  if (!trade || trade.exitTime) return trade;
  const notes = String(trade.notes || '');
  const currentEntry = Number(trade.entrySpot);
  const alreadyAligned =
    (notes.includes('priceSource=FUT') || notes.includes('entrySpotSource=FUT'))
    && Number.isFinite(currentEntry)
    && currentEntry > 1000;
  if (alreadyAligned) return trade;

  const barTsMs = (bar) => {
    const raw = bar?.[0];
    if (typeof raw === 'string') {
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? ms : NaN;
    }
    const t = Number(raw);
    if (!Number.isFinite(t)) return NaN;
    return t > 1e12 ? t : t * 1000;
  };
  const plausibleFut = (n) => Number.isFinite(n) && n > 1000;

  let futAtEntry = null;
  try {
    const rows = await refreshOneMinuteCandles(clock, { force: true });
    const entryMs = new Date(trade.entryTime).getTime();
    if (Number.isFinite(entryMs) && Array.isArray(rows) && rows.length) {
      let best = null;
      for (const bar of rows) {
        const ts = barTsMs(bar);
        const close = Number(bar[4]);
        if (!Number.isFinite(ts) || !plausibleFut(close)) continue;
        if (!best || Math.abs(ts - entryMs) < Math.abs(best.ts - entryMs)) {
          best = { ts, close };
        }
      }
      if (best && Math.abs(best.ts - entryMs) <= 5 * 60 * 1000) {
        futAtEntry = best.close;
      }
    }
  } catch (err) {
    engineState.lastCandleError = err.message || 'FUT candle align failed';
  }

  if (!plausibleFut(futAtEntry)) {
    try {
      futAtEntry = await refreshFutPrice({ force: true, clock });
    } catch {
      futAtEntry = Number(masterPrice());
    }
  }
  if (!plausibleFut(futAtEntry)) {
    logEntry('ALIGN_OPEN_TRADE_FUT_SKIP', {
      tradeId: trade._id.toString(),
      reason: 'NO_PLAUSIBLE_FUT',
      cashEntrySpot: currentEntry,
    });
    return trade;
  }

  const cashSpot = Number.isFinite(currentEntry) && currentEntry > 1000
    ? currentEntry
    : Number(String(notes).match(/cashEntrySpot=([0-9.]+)/)?.[1]);
  trade.entrySpot = Number(Number(futAtEntry).toFixed(2));
  const baseNotes = notes
    .replace(/\s*\|\s*entrySpotSource=FUT; priceSource=FUT; cashEntrySpot=[^|]*/g, '')
    .trim();
  trade.notes = [
    baseNotes,
    `entrySpotSource=FUT; priceSource=FUT; cashEntrySpot=${Number.isFinite(cashSpot) ? cashSpot : 'n/a'}`,
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
  await trade.save();
  logEntry('ALIGN_OPEN_TRADE_FUT', {
    tradeId: trade._id.toString(),
    cashEntrySpot: cashSpot,
    futEntrySpot: trade.entrySpot,
  });
  return trade;
}

function clearOpenTrade() {
  stopPositionPoll();
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.openTradeLite = null;
  engineState.lastOptionTick = null;
  engineState.openPositionMark = null;
  publishLiveMarkSnapshot({ open: false, tradeId: null, mark: null });
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
  const dayChanged = engineState.tradesTodayDateKey !== clock.dateKey;
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  })
    .select({ optionType: 1, exitTime: 1 })
    .lean();

  engineState.tradesTodayCount = rows.length;
  engineState.tradesTodayDateKey = clock.dateKey;
  engineState.sidesTradedToday = {
    CE: rows.some((r) => String(r.optionType || '').toUpperCase() === 'CE'),
    PE: rows.some((r) => String(r.optionType || '').toUpperCase() === 'PE'),
  };

  if (dayChanged) {
    engineState.armedBias = null;
    engineState.oiFlipUntilMs = 0;
    engineState.usedConfirmBarKeys = new Set();
  }

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

    let futLtp = null;
    try {
      futLtp = await refreshFutPrice({ clock });
    } catch (err) {
      engineState.lastFutError = err.message || 'FUT price failed';
    }

    const snapshot = await getOptionChainOiSnapshot({
      symbol,
      expiry,
      lookaroundStrikes: Math.max(
        OI_BOARD_LOOKAROUND,
        Number(engineState.settings.strikeLookaround) || 10,
      ),
      spotOverride: Number.isFinite(futLtp) ? futLtp : null,
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
        fut: futLtp,
      });
      return existing || null;
    }

    if (Number.isFinite(snapshot.chainSpot)) engineState.chainSpot = snapshot.chainSpot;
    if (Number.isFinite(snapshot.spot)) engineState.lastSpot = snapshot.spot;
    if (Number.isFinite(futLtp)) engineState.lastFut = futLtp;

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
    const fut = await ensureFutInstrument(clock);
    const { rows } = await fetchIntradayCandlesBySecurity({
      securityId: fut.securityId,
      exchangeSegment: fut.exchangeSegment || 'NSE_FNO',
      instrument: fut.instrument || 'FUTIDX',
      interval: '1',
      dateKey: clock.dateKey,
    });
    engineState.todayBars1m = Array.isArray(rows) ? rows : [];
    engineState.todayBars1mSource = 'FUT';
    engineState.lastCandleFetchAt = now;
    engineState.lastCandleError = null;
    return engineState.todayBars1m;
  } catch (err) {
    // Index 1m is OK for day O/H/L display only — NEVER for entry confirm.
    try {
      const { rows } = await fetchTradingDayCandles({
        symbol: getEngineSymbol(),
        interval: '1',
        dateKey: clock.dateKey,
      });
      engineState.todayBars1m = Array.isArray(rows) ? rows : [];
      engineState.todayBars1mSource = 'INDEX';
      engineState.lastCandleFetchAt = now;
      engineState.lastCandleError = `FUT candles failed (${err.message}); index 1m for display only`;
      return engineState.todayBars1m;
    } catch (err2) {
      engineState.lastCandleError = err.message || err2.message || '1m candle fetch failed';
      engineState.lastError = `1m candles: ${engineState.lastCandleError}`;
      return engineState.todayBars1m;
    }
  }
}

async function refreshFutConfirmCandles(clock, { force = false } = {}) {
  const interval = getConfirmCandleInterval();
  const now = Date.now();
  if (
    !force
    && engineState.todayConfirmBarsFut.length > 0
    && now - engineState.lastConfirmFutFetchAt < CONFIRM_CANDLE_REFRESH_MIN_GAP_MS
  ) {
    return engineState.todayConfirmBarsFut;
  }
  try {
    const fut = await ensureFutInstrument(clock);
    const { rows } = await fetchIntradayCandlesBySecurity({
      securityId: fut.securityId,
      exchangeSegment: fut.exchangeSegment || 'NSE_FNO',
      instrument: fut.instrument || 'FUTIDX',
      interval,
      dateKey: clock.dateKey,
    });
    engineState.todayConfirmBarsFut = Array.isArray(rows) ? rows : [];
    engineState.lastConfirmFutFetchAt = now;
    engineState.lastConfirmCandleError = null;
    return engineState.todayConfirmBarsFut;
  } catch (err) {
    engineState.lastConfirmCandleError = err.message || `${interval}m FUT candles failed`;
    return engineState.todayConfirmBarsFut;
  }
}

async function refreshOptionConfirmCandles(clock, signal, spot, { force = false } = {}) {
  const interval = getConfirmCandleInterval();
  const optionType = signal?.optionType === 'PE' ? 'PE' : 'CE';
  const strike = resolveEntryStrikeForSignal(signal, spot);
  const expiry = signal?.expiry || (await getEntryExpiry(getEngineSymbol(), clock.dateKey));
  if (!Number.isFinite(strike) || !expiry) {
    engineState.todayConfirmBarsOption = [];
    engineState.confirmOptionCacheKey = null;
    return { rows: [], strike: null, optionType, expiry: null };
  }

  const cacheKey = `${getEngineSymbol()}:${expiry}:${strike}:${optionType}:${interval}:${clock.dateKey}`;
  const now = Date.now();
  if (
    !force
    && engineState.confirmOptionCacheKey === cacheKey
    && engineState.todayConfirmBarsOption.length > 0
    && now - engineState.lastConfirmOptionFetchAt < CONFIRM_CANDLE_REFRESH_MIN_GAP_MS
  ) {
    return {
      rows: engineState.todayConfirmBarsOption,
      strike,
      optionType,
      expiry,
    };
  }

  try {
    const instrument = await resolveOptionInstrument({
      symbol: getEngineSymbol(),
      strike,
      expiry,
      optionType,
    });
    const { rows } = await fetchIntradayCandlesBySecurity({
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment || 'NSE_FNO',
      instrument: instrument.instrument || 'OPTIDX',
      interval,
      dateKey: clock.dateKey,
    });
    engineState.todayConfirmBarsOption = Array.isArray(rows) ? rows : [];
    engineState.lastConfirmOptionFetchAt = now;
    engineState.confirmOptionCacheKey = cacheKey;
    engineState.lastConfirmCandleError = null;
    return {
      rows: engineState.todayConfirmBarsOption,
      strike,
      optionType,
      expiry,
    };
  } catch (err) {
    engineState.lastConfirmCandleError = err.message || `${interval}m option candles failed`;
    engineState.todayConfirmBarsOption = [];
    engineState.confirmOptionCacheKey = null;
    return { rows: [], strike, optionType, expiry };
  }
}

/**
 * Favorable confirm on BOTH closed bars (never forming candle):
 * - FUT confirm built from FUT 1m only → exact previous 5m/15m IST bucket (full bucket)
 * - Option vendor TF bar for the SAME bucket must be green
 * Index 1m fallback is never used for confirm.
 */
async function hasReactionConfirmation(clock, signal, spot, { force = false } = {}) {
  const interval = getConfirmCandleInterval();
  const intervalMinutes = Number(interval) === 15 ? 15 : 5;
  const optionType = signal?.optionType === 'PE' ? 'PE' : 'CE';
  const minBarOpenMinutes = tradeFromMin();

  const rows1m = await refreshOneMinuteCandles(clock, { force });
  let futCandle = null;
  let candleError = engineState.lastCandleError || null;

  if (engineState.todayBars1mSource === 'FUT' && Array.isArray(rows1m) && rows1m.length > 0) {
    const agg = aggregateConfirmBarsFrom1m(rows1m, intervalMinutes);
    futCandle = readExactClosedConfirmFromAgg(agg, {
      intervalMinutes,
      clock,
      minBarOpenMinutes,
    });
  } else if (engineState.todayBars1mSource === 'INDEX') {
    candleError = 'FUT 1m unavailable — refuse confirm on index candles';
  } else if (!rows1m?.length) {
    candleError = candleError || 'FUT 1m candles empty';
  }

  // Vendor FUT TF only if we have no FUT 1m aggregate (never after index fallback).
  if (!futCandle && engineState.todayBars1mSource !== 'INDEX') {
    const futRows = await refreshFutConfirmCandles(clock, { force });
    futCandle = readExactClosedConfirmFromRows(futRows, {
      intervalMinutes,
      clock,
      minBarOpenMinutes,
    });
    if (!futCandle && !candleError) {
      candleError = engineState.lastConfirmCandleError || `${intervalMinutes}m FUT confirm bar missing`;
    }
  }

  const futOk = futCandleConfirms(signal, futCandle);

  const optionPack = await refreshOptionConfirmCandles(clock, signal, spot, { force });
  const optionCandle = futCandle
    ? readExactClosedConfirmFromRows(optionPack.rows, {
      intervalMinutes,
      clock,
      minBarOpenMinutes,
      matchBucket: futCandle.bucket,
    })
    : null;
  const optionOk = optionPremiumCandleConfirms(optionCandle);

  const usedSameBar = confirmBarAlreadyUsed(optionType, futCandle?.barKey);
  const confirmFresh = Boolean(futCandle && isConfirmFreshForEntry(futCandle, clock));
  const ok = Boolean(
    futOk
    && optionOk
    && !usedSameBar
    && optionPack.strike
    && futCandle
    && confirmFresh,
  );

  return {
    ok,
    futOk: Boolean(futOk),
    optionOk: Boolean(optionOk),
    confirmFresh,
    usedSameBar,
    interval,
    confirmEntryWindowMinutes: getConfirmEntryWindowMinutes(),
    strike: optionPack.strike,
    optionType: optionPack.optionType || optionType,
    futCandle,
    optionCandle,
    candleError: candleError || engineState.lastConfirmCandleError || engineState.lastCandleError,
  };
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

    // One open position at a time; max 2/day · one support + one resistance.
    if (engineState.openTradeId) return;

    if (clock.minutes > tradeToMin() || clock.minutes < tradeFromMin()) return;

    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'MAX_TRADES',
        count: engineState.tradesTodayCount,
        max: engineState.settings.maxTradesPerDay,
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

    const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    if (!isOiDominanceClear(signal.ratio)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'WEAK_OI_RATIO',
        ratio: signal.ratio,
        need: getMinOiRatio(),
        level: signal.levelStrike,
        optionType,
      });
      return;
    }
    if (sideAlreadyTradedToday(optionType)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'SAME_SIDE_DONE',
        optionType,
        sides: engineState.sidesTradedToday,
      });
      return;
    }

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
    refreshOverallBuildup({ board: engineState.liveOiBoard });
    if (isStrongBuildupFighting(optionType)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'BUILDUP_FIGHTING',
        optionType,
        buildup: engineState.marketStructure?.key,
        lean: engineState.marketStructure?.alignsWith,
      });
      return;
    }

    let spot;
    try {
      spot = await refreshFutPrice({ force: true, clock });
    } catch (err) {
      engineState.lastError = `Live FUT: ${err.message}`;
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'FUT_FETCH_FAILED', error: err.message });
      return;
    }
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'Live FUT unavailable from Dhan';
      return;
    }
    engineState.lastFut = spot;
    engineState.lastSpot = spot;

    const dist = Math.abs(spot - Number(signal.levelStrike));
    if (dist > engineState.settings.proximityPoints) {
      logEntry('WAIT_PROXIMITY', {
        ist: istClockLabel(clock),
        priceSource: 'FUT',
        fut: spot,
        futExpiry: engineState.futExpiry,
        level: signal.levelStrike,
        dist: Number(dist.toFixed(1)),
        need: engineState.settings.proximityPoints,
      });
      return;
    }

    let confirmed = false;
    let confirmDetail = null;
    try {
      confirmDetail = await hasReactionConfirmation(clock, signal, spot, { force: true });
      confirmed = Boolean(confirmDetail?.ok);
    } catch (err) {
      engineState.lastError = `${getConfirmCandleInterval()}m confirm: ${err.message}`;
      return;
    }
    if (!confirmed) {
      logEntry('WAIT_REACTION', {
        ist: istClockLabel(clock),
        optionType: signal.optionType,
        level: signal.levelStrike,
        fut: spot,
        priceSource: 'FUT',
        confirmInterval: confirmDetail?.interval || getConfirmCandleInterval(),
        futOk: confirmDetail?.futOk,
        optionOk: confirmDetail?.optionOk,
        usedSameBar: confirmDetail?.usedSameBar,
        optionStrike: confirmDetail?.strike,
        futCandle: confirmDetail?.futCandle
          ? {
            barKey: confirmDetail.futCandle.barKey,
            o: confirmDetail.futCandle.open,
            h: confirmDetail.futCandle.high,
            l: confirmDetail.futCandle.low,
            c: confirmDetail.futCandle.close,
            green: confirmDetail.futCandle.green,
            red: confirmDetail.futCandle.red,
          }
          : null,
        optionCandle: confirmDetail?.optionCandle
          ? {
            barKey: confirmDetail.optionCandle.barKey,
            o: confirmDetail.optionCandle.open,
            h: confirmDetail.optionCandle.high,
            l: confirmDetail.optionCandle.low,
            c: confirmDetail.optionCandle.close,
            green: confirmDetail.optionCandle.green,
          }
          : null,
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
    if (!isOiDominanceClear(fresh.ratio)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'WEAK_OI_RATIO',
        ratio: fresh.ratio,
        need: getMinOiRatio(),
        afterRevalidate: true,
      });
      return;
    }

    // Fresh FUT after OI revalidate — never reuse pre-confirm spot for proximity / strike.
    let freshSpot = spot;
    try {
      freshSpot = await refreshFutPrice({ force: true, clock });
    } catch (err) {
      engineState.lastError = `Live FUT after revalidate: ${err.message}`;
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'FUT_FETCH_FAILED',
        afterRevalidate: true,
        error: err.message,
      });
      return;
    }
    if (!Number.isFinite(freshSpot) || freshSpot <= 0) {
      engineState.lastError = 'Live FUT unavailable after revalidate';
      return;
    }
    spot = freshSpot;
    engineState.lastFut = spot;
    engineState.lastSpot = spot;

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
    let freshConfirmDetail = null;
    try {
      freshConfirmDetail = await hasReactionConfirmation(clock, fresh, spot, { force: true });
      freshConfirmed = Boolean(freshConfirmDetail?.ok);
    } catch (err) {
      engineState.lastError = `${getConfirmCandleInterval()}m reaction: ${err.message}`;
      return;
    }
    if (!freshConfirmed) {
      logEntry('WAIT_REACTION', {
        ist: istClockLabel(clock),
        optionType: fresh.optionType,
        level: fresh.levelStrike,
        spot,
        afterRevalidate: true,
        confirmInterval: freshConfirmDetail?.interval || getConfirmCandleInterval(),
        futOk: freshConfirmDetail?.futOk,
        optionOk: freshConfirmDetail?.optionOk,
        usedSameBar: freshConfirmDetail?.usedSameBar,
        optionStrike: freshConfirmDetail?.strike,
        candleError: freshConfirmDetail?.candleError,
      });
      return;
    }

    if (sideAlreadyTradedToday(fresh.optionType === 'PE' ? 'PE' : 'CE')) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'SAME_SIDE_DONE',
        optionType: fresh.optionType,
        afterRevalidate: true,
      });
      return;
    }

    await placeLongOption(clock, fresh, spot, freshConfirmDetail);
  } catch (err) {
    engineState.lastError = `Entry loop: ${err.message}`;
    logEntry('ENTRY_LOOP_ERROR', { error: err.message });
  } finally {
    engineState.evaluatingEntry = false;
  }
}

async function placeLongOption(clock, signal, spot, confirmDetail = null) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) return;
    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) return;

    const symbol = getEngineSymbol();
    let optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    if (sideAlreadyTradedToday(optionType)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'SAME_SIDE_DONE',
        optionType,
        atPlace: true,
      });
      return;
    }

    // Fill-time re-check: FUT proximity + wall/ΔOI can drift while premiums load.
    let fillSpot = Number(spot);
    try {
      fillSpot = await refreshFutPrice({ force: true, clock });
    } catch (err) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'FUT_FETCH_FAILED',
        atPlace: true,
        error: err.message,
      });
      return;
    }
    if (!Number.isFinite(fillSpot) || fillSpot <= 0) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'FUT_UNAVAILABLE', atPlace: true });
      return;
    }
    spot = fillSpot;
    engineState.lastFut = spot;
    engineState.lastSpot = spot;

    const prox = Number(engineState.settings.proximityPoints) || 20;
    const dist = Math.abs(spot - Number(signal.levelStrike));
    if (dist > prox) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'PROXIMITY_LOST_AT_FILL',
        fut: spot,
        level: signal.levelStrike,
        dist: Number(dist.toFixed(1)),
        need: prox,
      });
      return;
    }

    let fillCheck;
    try {
      fillCheck = await revalidateWallEntry(clock, signal);
    } catch (err) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'OI_REVALIDATE_FAILED',
        atPlace: true,
        error: err.message,
      });
      return;
    }
    if (!fillCheck.ok) {
      logEntry('ENTRY_SKIP_REVALIDATE', {
        ist: istClockLabel(clock),
        reason: fillCheck.reason,
        intended: optionType,
        level: signal.levelStrike,
        atPlace: true,
      });
      return;
    }
    signal = fillCheck.signal || signal;
    const fillType = signal.optionType === 'PE' ? 'PE' : 'CE';
    if (fillType !== optionType) {
      logEntry('ENTRY_SKIP_REVALIDATE', {
        ist: istClockLabel(clock),
        reason: 'OI_SIDE_FLIPPED',
        intended: optionType,
        now: fillType,
        atPlace: true,
      });
      return;
    }
    optionType = fillType;
    if (!isOiDominanceClear(signal.ratio)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'WEAK_OI_RATIO',
        ratio: signal.ratio,
        need: getMinOiRatio(),
        atPlace: true,
      });
      return;
    }
    refreshOverallBuildup({ board: engineState.liveOiBoard, futPrice: spot });
    if (isStrongBuildupFighting(optionType)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'BUILDUP_FIGHTING',
        optionType,
        buildup: engineState.marketStructure?.key,
        atPlace: true,
      });
      return;
    }
    if (sideAlreadyTradedToday(optionType)) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'SAME_SIDE_DONE',
        optionType,
        atPlace: true,
      });
      return;
    }

    // Confirm must still be the exact previous closed bucket (no stale chase).
    let fillConfirm = null;
    try {
      fillConfirm = await hasReactionConfirmation(clock, signal, spot, { force: true });
    } catch (err) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'CONFIRM_FAILED_AT_FILL',
        error: err.message,
      });
      return;
    }
    if (!fillConfirm?.ok) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'CONFIRM_LOST_AT_FILL',
        futOk: fillConfirm?.futOk,
        optionOk: fillConfirm?.optionOk,
        candleError: fillConfirm?.candleError,
      });
      return;
    }
    confirmDetail = fillConfirm;

    const expiry = signal.expiry || (await getEntryExpiry(symbol, clock.dateKey));
    const strikeStep = getStrikeStep(symbol);
    const strike = Number.isFinite(Number(confirmDetail?.strike))
      ? Number(confirmDetail.strike)
      : pickStrike({
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

    // Last proximity glance after premium fetch (chain call can take seconds).
    try {
      const lastSpot = await refreshFutPrice({ force: true, clock });
      if (Number.isFinite(lastSpot) && lastSpot > 0) {
        spot = lastSpot;
        engineState.lastFut = spot;
        engineState.lastSpot = spot;
      }
    } catch {
      /* keep prior fill spot */
    }
    const lastDist = Math.abs(spot - Number(signal.levelStrike));
    if (lastDist > prox) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'PROXIMITY_LOST_AFTER_PREMIUM',
        fut: spot,
        level: signal.levelStrike,
        dist: Number(lastDist.toFixed(1)),
        need: prox,
      });
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

    const confirmInterval = confirmDetail?.interval || getConfirmCandleInterval();
    const futBarKey = confirmDetail?.futCandle?.barKey || '';
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
      entryReason: `Buy ${optionType} · wall ${signal.levelStrike} · ${signal.dominantSide} · FUT+opt ${confirmInterval}m confirm`,
      notes: `oi_wall; priceSource=FUT; level=${signal.levelStrike}; side=${signal.dominantSide}; ratio=${signal.ratio}; confirm=${confirmInterval}m; futBar=${futBarKey}; tg=${tgPct}%; sl=${hasSl ? `${slPct}%` : 'off'}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradesTodayCount += 1;
    engineState.tradesTodayDateKey = clock.dateKey;
    markSideTradedToday(optionType);
    markConfirmBarUsed(optionType, futBarKey);
    engineState.armedBias = null;
    engineState.oiFlipUntilMs = 0;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      levelStrike: signal.levelStrike,
      confirmInterval,
      futOk: confirmDetail?.futOk,
      optionOk: confirmDetail?.optionOk,
      futBarKey,
      futCandle: confirmDetail?.futCandle
        ? {
          o: confirmDetail.futCandle.open,
          h: confirmDetail.futCandle.high,
          l: confirmDetail.futCandle.low,
          c: confirmDetail.futCandle.close,
          green: confirmDetail.futCandle.green,
          red: confirmDetail.futCandle.red,
          bucket: confirmDetail.futCandle.bucket,
          source: confirmDetail.futCandle.source,
        }
        : null,
      optionCandle: confirmDetail?.optionCandle
        ? {
          o: confirmDetail.optionCandle.open,
          h: confirmDetail.optionCandle.high,
          l: confirmDetail.optionCandle.low,
          c: confirmDetail.optionCandle.close,
          green: confirmDetail.optionCandle.green,
        }
        : null,
      entryPremium: Number(entryPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
    });
    pushNotification({
      type: 'ENTRY',
      strategy: 'OI Wall',
      title: `Entered ${optionType} ${strike}`,
      body: [
        `Wall ${signal.levelStrike} · +${tgPct}%${hasSl ? ` / −${slPct}%` : ''} · ₹${Number(entryPremium.toFixed(2))}`,
        engineState.marketStructure?.label && engineState.marketStructure.key !== 'UNAVAILABLE'
          ? `Overall: ${engineState.marketStructure.label}`
          : null,
      ].filter(Boolean).join(' · '),
      meta: {
        tradeId: tradeDoc._id.toString(),
        optionType,
        strike,
        marketStructure: engineState.marketStructure
          ? {
            key: engineState.marketStructure.key,
            label: engineState.marketStructure.label,
            lean: engineState.marketStructure.lean,
          }
          : null,
      },
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
  const n = Number(ltp);
  engineState.lastOptionTick = { ltp: n, ts: Date.now() };
  if (engineState.openTradeId && Number.isFinite(n) && n > 0) {
    publishTickMarkFast(n);
  }
  checkOpenTrade({ preferTicks: true }).catch((err) => {
    engineState.lastError = `OI Wall tick check: ${err.message}`;
  });
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
  cacheOpenTradeLite(trade);

  if (clock.dateKey !== trade.entryDateKey) {
    const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    await finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason: 'DAY_CLOSE', forceChain: true });
    return;
  }

  try {
    await refreshFutPrice({ force: false, clock });
  } catch {
    /* keep last FUT */
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: true,
    forceChain: !preferTicks && !optionTickIsFresh(),
  });
  publishOpenMark(trade, mark, clock, { persist: true, forcePersist: false });

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
      const aligned = await alignOpenTradeToFut(orphan, clock);
      engineState.openTradeId = aligned._id.toString();
      await subscribeOpenOption(aligned);
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
    // Migrate old defaults → proximity 20 · max 2 trades/day.
    if (migrated.proximityPoints == null || Number(migrated.proximityPoints) === 30) {
      migrated.proximityPoints = 20;
    }
    if (migrated.maxTradesPerDay == null || Number(migrated.maxTradesPerDay) === 8) {
      migrated.maxTradesPerDay = 2;
    }
    if (!migrated.confirmCandleInterval) {
      migrated.confirmCandleInterval = DEFAULT_CONFIRM_CANDLE_INTERVAL;
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
    let trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (!trade || trade.exitTime) {
      clearOpenTrade();
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    trade = await alignOpenTradeToFut(trade, clock);
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
    let openInDb = await LivePaperTrade.findById(engineState.openTradeId);
    if (openInDb && !openInDb.exitTime) {
      openInDb = await alignOpenTradeToFut(openInDb, clock);
      await subscribeOpenOption(openInDb);
      startPositionPoll();
    }
  } else if (engineState.openTradeId) {
    const openInDb = await LivePaperTrade.findById(engineState.openTradeId);
    if (openInDb && !openInDb.exitTime) {
      await alignOpenTradeToFut(openInDb, clock);
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
    priceSource: 'FUT',
    lastFut: engineState.lastFut,
    futExpiry: engineState.futExpiry,
    chainSpot: engineState.chainSpot,
    lastSpot: engineState.lastFut ?? engineState.lastSpot,
    lastFutError: engineState.lastFutError,
    lastOptionTick: engineState.lastOptionTick,
    morningSignal: engineState.morningSignal,
    liveSignal: engineState.liveSignal,
    liveOiBoard: engineState.liveOiBoard,
    marketStructure: engineState.marketStructure,
    lastOiError: engineState.lastOiError,
    lastCandleError: engineState.lastCandleError,
    candleInterval: '1',
    confirmCandleInterval: getConfirmCandleInterval(),
    candleSource: 'FUT',
    oneMinuteBars: engineState.todayBars1m.length,
    futDayOhl: summarizeFutDayOhl(),
    tradesTodayCount: engineState.tradesTodayCount,
    maxTradesPerDay: engineState.settings.maxTradesPerDay,
    sidesTradedToday: engineState.sidesTradedToday,
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
  const current = engineState.openPositionMark;
  if (current?.at) {
    const ageMs = Date.now() - new Date(current.at).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STATUS_MARK_REFRESH_MIN_GAP_MS) {
      publishLiveMarkSnapshot();
      return current;
    }
  }
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return null;
  cacheOpenTradeLite(trade);
  const clock = getIstClock(new Date());
  try {
    await refreshFutPrice({ force: false, clock });
  } catch {
    /* keep last FUT */
  }
  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks: true,
    allowChain: true,
    forceChain: !optionTickIsFresh(),
  });
  return publishOpenMark(trade, mark, clock, { persist: true, forcePersist: false });
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
  getLiveMarkSnapshot,
};

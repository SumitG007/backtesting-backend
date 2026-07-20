/**
 * Factory for SL Flip paper-live engines (one isolated instance per scenario).
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
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');
const { fetchIntradayCandlesBySecurity, fetchTradingDayCandles } = require('./dhanDataService');

const POLL_INTERVAL_MS = 5000;
/** Open-position mark/exit poll — keep tight so SL/trail are not delayed. */
const POSITION_POLL_MS = 1000;
/** Merge 1m option OHLC so brief wicks arm trail / hit SL even when ticker skips them. */
const OHLC_RECONCILE_MS = 10000;
/** Ignore 1m OHLC on the entry minute — prevents same-bar high/low re-exit loops. */
const OHLC_WARMUP_AFTER_ENTRY_MS = 60_000;
/** After TRAIL_STOP, wait before same-side re-entry (avoids instant re-exit on stale bar). */
const TRAIL_REENTRY_COOLDOWN_MS = 60_000;
/** Brief pause after hard SL before opposite flip. */
const FLIP_REENTRY_COOLDOWN_MS = 3000;
/** Hard floor between any two entries. */
const MIN_ENTRY_GAP_MS = 5000;
const TICK_FRESH_MS = 45000;
/** Anti-flicker only — was 8s and blocked real SL hits right after entry. */
const MIN_HOLD_MS = 2000;
const SESSION_START_MIN = 555;
const DEFAULT_ENTRY_FROM = 560; // 09:20
const DEFAULT_ENTRY_TO = 915; // 15:15
const EOD_EXIT = 920; // 15:20

function createSlFlipPaperLiveEngine(config) {
  const {
    scenarioId,
    scenarioLabel,
    strategyKey: STRATEGY_KEY,
    walletKey,
    optionSubKey: OPTION_SUB_KEY,
    logTag,
    barIntervalMinutes: BAR_INTERVAL,
    defaultStopLossPoints: DEFAULT_SL,
    defaultTrailActivationPoints: DEFAULT_TRAIL_ACT,
    defaultTrailStepPoints: DEFAULT_TRAIL_STEP,
  } = config;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  settings: {},
  lotSize: 65,
  expiry: null,
  lastSpot: null,
  sessionDateKey: null,
  /** True once today's CE starter has been filled (or day already had trades). */
  dayStartedCE: false,
  /** After DAY_CLOSE / MANUAL — block entries until next session day. */
  entriesClosedForDay: false,
  /** Immediate opposite-side re-entry after SL (retry on later polls if place fails). */
  pendingFlipOpposite: false,
  pendingFlipOptionType: null,
  /** Same-side re-entry after TRAIL_STOP, gated by earliestEntryBarOpenMinutes. */
  pendingSameSideReentry: false,
  pendingSameSideOptionType: null,
  /** Next 5m bar open (IST minutes) allowed for trail same-side re-entry. */
  earliestEntryBarOpenMinutes: null,
  lastClosedOptionType: null,
  openTradeId: null,
  entryAtMs: null,
  /** Entry premium of the open trade — used so WS ticks can update trail peak immediately. */
  openEntryPremium: null,
  peakProfitPoints: 0,
  /** Lowest LTP seen since entry — catches SL wicks between polls. */
  lowSinceEntry: null,
  trailStopPremium: null,
  /** Hard SL floor (entry − stopLossPoints). Effective stop may ratchet above this. */
  hardStopPremium: null,
  lastOptionTick: null,
  openPositionMark: null,
  /** Cached Dhan contract for 1m OHLC reconcile on the open leg. */
  openOptionInstrument: null,
  lastOhlcReconcileAt: null,
  /** Coalesce tick-driven exit checks so we don't stampede finalize. */
  tickExitCheckScheduled: false,
  pollTimer: null,
  positionPollTimer: null,
  enteringTrade: false,
  closingTrade: false,
  lastError: null,
  lastSignalAt: null,
  dayTradeCount: 0,
  /** Block re-entry until this timestamp (ms). */
  nextEntryAllowedAtMs: 0,
  lastEntryPlacedAtMs: null,
  /** No 1m OHLC reconcile until this time (ms) — entry bar excluded. */
  ohlcEligibleAfterMs: null,
};

/** Cache index 5m bar direction to avoid hammering charts API on every poll. */
const barDirectionCache = {
  at: 0,
  dateKey: null,
  formingOpen: null,
  direction: null,
};

function istLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logLine(line, payload = {}) {
  console.log(`[${logTag}] ${line}`, JSON.stringify({ at: new Date().toISOString(), line, scenarioId, ...payload }));
}

function normalizeSettings(settings = {}) {
  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount: Math.max(1, Number(settings.lotCount) || 5),
    entryFromTime: String(settings.entryFromTime || '09:20'),
    entryToTime: String(settings.entryToTime || '15:15'),
    eodExitTime: String(settings.eodExitTime || '15:20'),
    stopLossPoints: Math.max(0.01, Number(settings.stopLossPoints) || DEFAULT_SL),
    trailingActivationPoints: Math.max(
      0.01,
      Number(settings.trailingActivationPoints ?? settings.targetProfitPoints) || DEFAULT_TRAIL_ACT,
    ),
    trailingStepPoints: Math.max(0.01, Number(settings.trailingStepPoints) || DEFAULT_TRAIL_STEP),
    trailReentryBarMinutes: BAR_INTERVAL,
    strikeMode: String(settings.strikeMode || 'ATM'),
    scenarioId: String(settings.scenarioId || scenarioId),
    perTradeCost:
      Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
        ? Number(settings.perTradeCost)
        : 100,
  };
}

function barOpenMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return null;
  if (m < SESSION_START_MIN) return SESSION_START_MIN;
  return Math.floor((m - SESSION_START_MIN) / BAR_INTERVAL) * BAR_INTERVAL + SESSION_START_MIN;
}

/** BULL = green 5m bar (close > open), BEAR = red, FLAT = doji. */
async function getCurrentBarDirection(symbol, clock) {
  const formingOpen = barOpenMinutes(clock.minutes);
  const now = Date.now();
  if (
    barDirectionCache.dateKey === clock.dateKey
    && barDirectionCache.formingOpen === formingOpen
    && now - barDirectionCache.at < 15000
  ) {
    return barDirectionCache.direction;
  }

  try {
    const { rows } = await fetchTradingDayCandles({
      symbol,
      interval: String(BAR_INTERVAL),
      dateKey: clock.dateKey,
    });
    if (!rows?.length) return null;

    let bar = null;
    for (const row of rows) {
      const barClock = getIstClock(new Date(row[0]));
      if (barOpenMinutes(barClock.minutes) === formingOpen) {
        bar = row;
        break;
      }
    }
    if (!bar) bar = rows[rows.length - 1];

    const open = Number(bar[1]);
    const close = Number(bar[4]);
    if (!Number.isFinite(open) || !Number.isFinite(close)) return null;

    let direction = 'FLAT';
    if (close > open) direction = 'BULL';
    else if (close < open) direction = 'BEAR';

    barDirectionCache.at = now;
    barDirectionCache.dateKey = clock.dateKey;
    barDirectionCache.formingOpen = formingOpen;
    barDirectionCache.direction = direction;
    return direction;
  } catch {
    return null;
  }
}

/** CE re-enters on bullish 5m; PE on bearish. FLAT/null → allow (do not block entries). */
function directionSupportsOption(optionType, direction) {
  if (direction == null || direction === 'FLAT') return true;
  const side = String(optionType).toUpperCase();
  if (direction === 'BULL') return side === 'CE';
  if (direction === 'BEAR') return side === 'PE';
  return true;
}

/** After restart, re-arm pending flip / trail from the latest closed trade today. */
async function restorePendingReentryIfNeeded(clock) {
  if (
    engineState.openTradeId
    || engineState.pendingFlipOpposite
    || engineState.pendingSameSideReentry
    || engineState.enteringTrade
    || engineState.entriesClosedForDay
    || !canPlaceNewEntry(clock.minutes)
  ) {
    return;
  }

  const last = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
    exitTime: { $ne: null },
    status: 'CLOSED',
  })
    .sort({ exitTime: -1 })
    .lean();

  if (!last) return;

  const reason = String(last.reason || '').toUpperCase();
  if (reason === 'DAY_CLOSE' || reason === 'MANUAL_CLOSE' || reason === 'MANUAL') return;

  const exitMs = new Date(last.exitTime).getTime();
  if (!Number.isFinite(exitMs) || Date.now() - exitMs > 4 * 60 * 60 * 1000) return;

  const closedSide = String(last.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
  if (reason === 'STOP_LOSS' || reason === 'BREAKEVEN_STOP') {
    engineState.pendingFlipOpposite = true;
    engineState.pendingFlipOptionType = oppositeOptionType(closedSide);
    logLine('RESTORE_PENDING_FLIP', {
      from: closedSide,
      to: engineState.pendingFlipOptionType,
      ist: istLabel(clock),
    });
  } else if (reason === 'TRAIL_STOP') {
    engineState.pendingSameSideReentry = true;
    engineState.pendingSameSideOptionType = closedSide;
    engineState.earliestEntryBarOpenMinutes = clock.minutes + 1;
    engineState.nextEntryAllowedAtMs = Date.now() + TRAIL_REENTRY_COOLDOWN_MS;
    logLine('RESTORE_PENDING_TRAIL', { optionType: closedSide, ist: istLabel(clock) });
  }
}

function entryFromMin() {
  return parseClockMinutes(engineState.settings.entryFromTime, DEFAULT_ENTRY_FROM);
}

function entryToMin() {
  return parseClockMinutes(engineState.settings.entryToTime, DEFAULT_ENTRY_TO);
}

function eodExitMinutes() {
  return parseClockMinutes(engineState.settings.eodExitTime, EOD_EXIT);
}

function isEod(minutes) {
  return minutes >= eodExitMinutes();
}

function inEntryWindow(minutes) {
  return minutes >= entryFromMin() && minutes < entryToMin();
}

function canPlaceNewEntry(minutes) {
  if (engineState.entriesClosedForDay) return false;
  if (minutes >= entryToMin()) return false;
  if (isEod(minutes)) return false;
  return true;
}

function premiumFromChain(chain, optionType) {
  const t = String(optionType).toUpperCase();
  const v = t === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function oppositeOptionType(optionType) {
  return String(optionType).toUpperCase() === 'CE' ? 'PE' : 'CE';
}

function clearPendingEntryState() {
  engineState.pendingFlipOpposite = false;
  engineState.pendingFlipOptionType = null;
  engineState.pendingSameSideReentry = false;
  engineState.pendingSameSideOptionType = null;
  engineState.earliestEntryBarOpenMinutes = null;
}

function clearOpenRuntime() {
  engineState.openTradeId = null;
  engineState.entryAtMs = null;
  engineState.openEntryPremium = null;
  engineState.peakProfitPoints = 0;
  engineState.lowSinceEntry = null;
  engineState.trailStopPremium = null;
  engineState.hardStopPremium = null;
  engineState.openPositionMark = null;
  engineState.lastOptionTick = null;
  engineState.openOptionInstrument = null;
  engineState.lastOhlcReconcileAt = null;
  engineState.ohlcEligibleAfterMs = null;
  engineState.tickExitCheckScheduled = false;
}

/**
 * Restore trail peak from DB fields so a restart mid-trade does not forget activation.
 */
function restoreTrailFromTrade(trade) {
  const entry = Number(trade?.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return;
  engineState.openEntryPremium = entry;

  const mark = trade.openPositionMark || {};
  let peak = Number(mark.peakProfitPoints);
  if (!Number.isFinite(peak) || peak < 0) peak = 0;

  const highSince = Number(trade.highSinceEntry);
  if (Number.isFinite(highSince) && highSince > 0) {
    peak = Math.max(peak, highSince - entry);
  }

  engineState.peakProfitPoints = peak;

  let low = Number(trade.lowSinceEntry);
  if (!Number.isFinite(low) || low <= 0) low = Number(mark.optionLtp);
  if (!Number.isFinite(low) || low <= 0) low = entry;
  engineState.lowSinceEntry = low;

  const act = engineState.settings.trailingActivationPoints;
  const step = engineState.settings.trailingStepPoints;
  const hardSl = Math.max(0.05, entry - engineState.settings.stopLossPoints);
  engineState.hardStopPremium = hardSl;
  let stop = hardSl;
  if (peak >= act) {
    stop = Math.max(hardSl, entry + peak - step);
  }
  const savedTrail = Number(mark.trailStopPremium);
  if (peak >= act && Number.isFinite(savedTrail) && savedTrail > stop) stop = savedTrail;
  engineState.trailStopPremium = stop;
}

function maybeScheduleTickExitCheck(ltp) {
  if (!engineState.openTradeId || engineState.closingTrade || engineState.tickExitCheckScheduled) {
    return;
  }
  const stop = engineState.trailStopPremium;
  if (stop == null) return;
  const low = engineState.lowSinceEntry != null ? engineState.lowSinceEntry : ltp;
  const checkPx = Math.min(Number(ltp), Number(low));
  // Fire when current tick OR any earlier low since entry has touched/crossed stop.
  if (!(Number.isFinite(checkPx) && checkPx <= Number(stop))) return;

  engineState.tickExitCheckScheduled = true;
  setImmediate(() => {
    engineState.tickExitCheckScheduled = false;
    checkOpenTrade().catch(() => {});
  });
}

function scenarioDefaultSettings() {
  return normalizeSettings({
    stopLossPoints: DEFAULT_SL,
    trailingActivationPoints: DEFAULT_TRAIL_ACT,
    trailingStepPoints: DEFAULT_TRAIL_STEP,
    trailReentryBarMinutes: BAR_INTERVAL,
    scenarioId,
  });
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey,
      strategy11EngineSettings: scenarioDefaultSettings(),
    });
  }
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

async function persistSettingsToWallet() {
  const wallet = await ensureWallet();
  wallet.strategy11EngineSettings = { ...engineState.settings };
  await wallet.save();
}

async function loadSettingsFromWallet() {
  const wallet = await ensureWallet();
  const raw = wallet.strategy11EngineSettings
    ? wallet.strategy11EngineSettings.toObject?.() || wallet.strategy11EngineSettings
    : {};
  const savedScenarioId = String(raw.scenarioId || '');
  // Fresh / wrong-scenario wallets get schema defaults (A: 8/4/2). Re-seed once per scenario.
  if (savedScenarioId !== String(scenarioId)) {
    if (!savedScenarioId && String(scenarioId) === 'A') {
      // Existing live A wallet — keep current numbers, only stamp scenarioId.
      engineState.settings = normalizeSettings({ ...raw, scenarioId });
    } else {
      // B/C/D first boot (or mismatched) — apply this scenario's SL / trail presets.
      engineState.settings = normalizeSettings({
        symbol: raw.symbol,
        lotCount: raw.lotCount,
        perTradeCost: raw.perTradeCost,
        entryFromTime: raw.entryFromTime,
        entryToTime: raw.entryToTime,
        eodExitTime: raw.eodExitTime,
        strikeMode: raw.strikeMode,
        stopLossPoints: DEFAULT_SL,
        trailingActivationPoints: DEFAULT_TRAIL_ACT,
        trailingStepPoints: DEFAULT_TRAIL_STEP,
        trailReentryBarMinutes: BAR_INTERVAL,
        scenarioId,
      });
      logLine('seeded_scenario_settings', {
        stopLossPoints: engineState.settings.stopLossPoints,
        trailingActivationPoints: engineState.settings.trailingActivationPoints,
        trailingStepPoints: engineState.settings.trailingStepPoints,
        trailReentryBarMinutes: engineState.settings.trailReentryBarMinutes,
      });
    }
    engineState.symbol = engineState.settings.symbol;
    await persistSettingsToWallet();
    return;
  }
  engineState.settings = normalizeSettings({ ...raw, scenarioId });
  engineState.symbol = engineState.settings.symbol;
}

async function countTodayTrades(dateKey) {
  return LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
  });
}

async function resetSessionIfNewDay(clock) {
  if (engineState.sessionDateKey === clock.dateKey) return;
  engineState.sessionDateKey = clock.dateKey;
  engineState.dayTradeCount = await countTodayTrades(clock.dateKey);
  engineState.dayStartedCE = engineState.dayTradeCount > 0;
  engineState.entriesClosedForDay = false;
  clearPendingEntryState();
  engineState.lastClosedOptionType = null;
}

function noteLowFromLtp(ltp) {
  const px = Number(ltp);
  if (!Number.isFinite(px) || px <= 0) return;
  if (engineState.lowSinceEntry == null || px < engineState.lowSinceEntry) {
    engineState.lowSinceEntry = px;
  }
}

function syncTrailStopPremium(entryPremium) {
  const act = engineState.settings.trailingActivationPoints;
  const step = engineState.settings.trailingStepPoints;
  const hardSl = Math.max(0.05, Number(entryPremium) - engineState.settings.stopLossPoints);
  engineState.hardStopPremium = hardSl;
  if (engineState.peakProfitPoints >= act) {
    engineState.trailStopPremium = Math.max(
      hardSl,
      Number(entryPremium) + engineState.peakProfitPoints - step,
    );
  } else {
    engineState.trailStopPremium = hardSl;
  }
}

function noteHighFromPrice(entryPremium, price) {
  const profit = Number(price) - Number(entryPremium);
  if (Number.isFinite(profit) && profit > engineState.peakProfitPoints) {
    engineState.peakProfitPoints = profit;
  }
}

function updateTrailFromLtp(entryPremium, ltp) {
  noteHighFromPrice(entryPremium, ltp);
  noteLowFromLtp(ltp);
  syncTrailStopPremium(entryPremium);
}

/** Apply bar/tick extremes — high arms trail, low can trigger SL. */
function applyPriceExtremes(entryPremium, high, low) {
  if (Number.isFinite(high) && high > 0) noteHighFromPrice(entryPremium, high);
  if (Number.isFinite(low) && low > 0) noteLowFromLtp(low);
  syncTrailStopPremium(entryPremium);
}

async function reconcileOhlcFromCandles(trade, clock) {
  const now = Date.now();
  if (engineState.ohlcEligibleAfterMs != null && now < engineState.ohlcEligibleAfterMs) {
    return;
  }
  if (
    engineState.lastOhlcReconcileAt != null
    && now - engineState.lastOhlcReconcileAt < OHLC_RECONCILE_MS
  ) {
    return;
  }
  engineState.lastOhlcReconcileAt = now;

  try {
    if (!engineState.openOptionInstrument) {
      engineState.openOptionInstrument = await resolveOptionInstrument({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
        optionType: trade.optionType,
      });
    }
    const inst = engineState.openOptionInstrument;
    const { rows } = await fetchIntradayCandlesBySecurity({
      securityId: inst.securityId,
      exchangeSegment: inst.exchangeSegment || 'NSE_FNO',
      instrument: 'OPTIDX',
      interval: '1',
      dateKey: clock.dateKey,
    });
    if (!rows?.length) return;

    const entryMs = new Date(trade.entryTime).getTime();
    // Only 1m bars that OPEN after the entry minute (skip entry-bar spike from prior position).
    const ohlcFloorMs = entryMs + 60_000;
    let maxHigh = null;
    let minLow = null;
    for (const row of rows) {
      const ts = new Date(row[0]).getTime();
      if (Number.isNaN(ts) || ts < ohlcFloorMs) continue;
      const h = Number(row[2]);
      const l = Number(row[3]);
      if (Number.isFinite(h) && h > 0) {
        maxHigh = maxHigh == null ? h : Math.max(maxHigh, h);
      }
      if (Number.isFinite(l) && l > 0) {
        minLow = minLow == null ? l : Math.min(minLow, l);
      }
    }
    if (maxHigh == null && minLow == null) return;

    const entry = Number(trade.entryPremium);
    const peakBefore = engineState.peakProfitPoints;
    const lowBefore = engineState.lowSinceEntry;
    applyPriceExtremes(entry, maxHigh ?? entry, minLow ?? entry);

    const peakChanged = engineState.peakProfitPoints > peakBefore + 1e-6;
    const lowChanged = lowBefore != null && engineState.lowSinceEntry < lowBefore - 1e-6;
    if (peakChanged || lowChanged) {
      logLine('OHLC_RECONCILE', {
        maxHigh,
        minLow,
        peakProfitPoints: engineState.peakProfitPoints,
        trailStopPremium: engineState.trailStopPremium,
        lowSinceEntry: engineState.lowSinceEntry,
        ist: istLabel(clock),
      });
      maybeScheduleTickExitCheck(engineState.lowSinceEntry ?? maxHigh ?? entry);
    }
  } catch (err) {
    logLine('OHLC_RECONCILE_FAIL', { error: err.message, ist: istLabel(clock) });
  }
}

async function getOpenTrade() {
  if (engineState.openTradeId) {
    const t = await LivePaperTrade.findById(engineState.openTradeId);
    if (t && !t.exitTime) return t;
  }
  return LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).sort({ entryTime: -1 });
}

async function getMarkPremium(trade) {
  if (engineState.lastOptionTick && Date.now() - engineState.lastOptionTick.ts < TICK_FRESH_MS) {
    return engineState.lastOptionTick.ltp;
  }
  try {
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    return premiumFromChain(chain, trade.optionType);
  } catch {
    return null;
  }
}

function clearSubs() {
  unsubscribeLiveSymbol(OPTION_SUB_KEY);
}

async function subscribeOpenOption(trade) {
  clearSubs();
  const entryPremium = Number(trade.entryPremium);
  if (Number.isFinite(entryPremium) && entryPremium > 0) {
    engineState.openEntryPremium = entryPremium;
  }
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType: trade.optionType,
    });
    engineState.openOptionInstrument = instrument;
    engineState.lastOhlcReconcileAt = null;
    subscribeLiveInstrument({
      key: OPTION_SUB_KEY,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: (tick) => {
        const ltp = Number(tick.ltp);
        if (!Number.isFinite(ltp) || ltp <= 0) return;
        engineState.lastOptionTick = { ltp, ts: Date.now() };
        // Critical: update trail on EVERY tick. Polling alone misses brief +activation spikes
        // and then wrongly exits on hard SL instead of TRAIL_STOP.
        const entry = Number(engineState.openEntryPremium);
        if (Number.isFinite(entry) && entry > 0) {
          updateTrailFromLtp(entry, ltp);
          maybeScheduleTickExitCheck(ltp);
        }
      },
    });
  } catch (err) {
    engineState.lastError = `WS: ${err.message}`;
  }
}

/**
 * Close trade and set re-entry / day-stop state from reason.
 * @returns {Promise<string>} normalized exit reason
 */
async function finalizeTrade(trade, { exitPremium, reason }) {
  const safeExit = Math.max(0.05, Number(exitPremium) || Number(trade.entryPremium) || 0.05);
  const entry = Number(trade.entryPremium) || 0;
  const qty = Number(trade.qty) || 0;
  const charges = Math.max(0, Number(trade.charges) || 0);
  const pnl = (safeExit - entry) * qty - charges;
  const clock = getIstClock(new Date());
  const reasonUpper = String(reason || 'UNKNOWN').toUpperCase();
  const closedSide = String(trade.optionType || '').toUpperCase() === 'PE' ? 'PE' : 'CE';

  trade.status = 'CLOSED';
  trade.exitPremium = Number(safeExit.toFixed(2));
  trade.exitSpot = Number(trade.entrySpot || 0);
  trade.exitTime = new Date();
  trade.exitDateKey = clock.dateKey;
  trade.reason = reasonUpper;
  trade.finalValue = Number((safeExit * qty).toFixed(2));
  trade.pnl = Number(pnl.toFixed(2));
  trade.pnlPct = entry > 0 ? Number((((safeExit - entry) / entry) * 100).toFixed(2)) : 0;
  trade.openPositionMark = null;
  trade.openPositionMarkAt = null;
  await trade.save();

  engineState.lastClosedOptionType = closedSide;
  clearOpenRuntime();
  clearSubs();
  stopPositionPoll();

  if (reasonUpper === 'STOP_LOSS' || reasonUpper === 'BREAKEVEN_STOP') {
    engineState.pendingSameSideReentry = false;
    engineState.pendingSameSideOptionType = null;
    engineState.earliestEntryBarOpenMinutes = null;
    engineState.pendingFlipOpposite = true;
    engineState.pendingFlipOptionType = oppositeOptionType(closedSide);
    engineState.nextEntryAllowedAtMs = Date.now() + FLIP_REENTRY_COOLDOWN_MS;
  } else if (reasonUpper === 'TRAIL_STOP') {
    engineState.pendingFlipOpposite = false;
    engineState.pendingFlipOptionType = null;
    engineState.pendingSameSideReentry = true;
    engineState.pendingSameSideOptionType = closedSide;
    engineState.earliestEntryBarOpenMinutes = clock.minutes + 1;
    engineState.nextEntryAllowedAtMs = Date.now() + TRAIL_REENTRY_COOLDOWN_MS;
  } else if (
    reasonUpper === 'DAY_CLOSE'
    || reasonUpper === 'MANUAL_CLOSE'
    || reasonUpper === 'MANUAL'
  ) {
    clearPendingEntryState();
    engineState.entriesClosedForDay = true;
  }

  await recalcWalletFromTrades();
  logLine('EXIT', {
    reason: reasonUpper,
    exitPremium: safeExit,
    pnl: trade.pnl,
    pendingFlipOpposite: engineState.pendingFlipOpposite,
    pendingSameSideReentry: engineState.pendingSameSideReentry,
    earliestEntryBarOpenMinutes: engineState.earliestEntryBarOpenMinutes,
    ist: istLabel(clock),
  });
  return reasonUpper;
}

async function placeLongOption(clock, { optionType, entryKind }) {
  if (engineState.enteringTrade || engineState.openTradeId) return { ok: false, reason: 'BUSY' };
  if (!canPlaceNewEntry(clock.minutes)) return { ok: false, reason: 'ENTRY_WINDOW_CLOSED' };
  const now = Date.now();
  if (engineState.nextEntryAllowedAtMs && now < engineState.nextEntryAllowedAtMs) {
    return { ok: false, reason: 'REENTRY_COOLDOWN' };
  }
  if (
    engineState.lastEntryPlacedAtMs
    && now - engineState.lastEntryPlacedAtMs < MIN_ENTRY_GAP_MS
  ) {
    return { ok: false, reason: 'ENTRY_THROTTLE' };
  }
  engineState.enteringTrade = true;
  try {
    const open = await getOpenTrade();
    if (open) {
      engineState.openTradeId = open._id.toString();
      return { ok: false, reason: 'ALREADY_OPEN' };
    }

    const symbol = engineState.symbol;
    const expiry = await getNearestWeeklyExpiry(symbol);
    engineState.expiry = expiry;
    const spotChain = await getAtmPremiums({ symbol, strike: 0, expiry });
    const spot = Number(spotChain.chainSpot || spotChain.spot);
    if (!Number.isFinite(spot) || spot <= 0) {
      logLine('ENTRY_FAIL', { reason: 'NO_SPOT', ist: istLabel(clock) });
      return { ok: false, reason: 'NO_SPOT' };
    }
    engineState.lastSpot = spot;
    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = engineState.settings.lotCount;
    const qty = lotSize * lots;
    const side = String(optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
    const strike = pickStrike({
      entrySpot: spot,
      strikeStep: getStrikeStep(symbol),
      optionType: side,
      strikeMode: engineState.settings.strikeMode,
    });
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, side);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      logLine('ENTRY_FAIL', { reason: `NO_${side}`, strike });
      return { ok: false, reason: `NO_${side}` };
    }
    const stopLossPremium = Math.max(0.05, entryPremium - engineState.settings.stopLossPoints);
    const doc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType: side,
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(buildIstWallClockTimestamp(clock.dateKey, clock.minutes)),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(engineState.settings.perTradeCost.toFixed(2)),
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: null,
      highSinceEntry: Number(entryPremium.toFixed(2)),
      lowSinceEntry: Number(entryPremium.toFixed(2)),
      legs: [{ optionType: side, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `slFlip; scenario=${scenarioId}; kind=${entryKind || 'entry'}; trail; tick`,
    });

    engineState.openTradeId = doc._id.toString();
    engineState.entryAtMs = Date.now();
    engineState.openEntryPremium = entryPremium;
    engineState.dayTradeCount += 1;
    engineState.lastSignalAt = new Date();
    engineState.peakProfitPoints = 0;
    engineState.lowSinceEntry = entryPremium;
    engineState.hardStopPremium = stopLossPremium;
    engineState.trailStopPremium = stopLossPremium; // effective stop starts at hard SL
    engineState.lastOptionTick = { ltp: entryPremium, ts: Date.now() };
    engineState.lastEntryPlacedAtMs = Date.now();
    engineState.ohlcEligibleAfterMs = Date.now() + OHLC_WARMUP_AFTER_ENTRY_MS;
    engineState.lastOhlcReconcileAt = null;

    if (side === 'CE') engineState.dayStartedCE = true;
    // Clear only the pending that this fill satisfies.
    if (engineState.pendingFlipOpposite && engineState.pendingFlipOptionType === side) {
      engineState.pendingFlipOpposite = false;
      engineState.pendingFlipOptionType = null;
    }
    if (engineState.pendingSameSideReentry && engineState.pendingSameSideOptionType === side) {
      engineState.pendingSameSideReentry = false;
      engineState.pendingSameSideOptionType = null;
      engineState.earliestEntryBarOpenMinutes = null;
    }

    await subscribeOpenOption(doc);
    startPositionPoll();
    logLine('ENTRY', {
      ist: istLabel(clock),
      optionType: side,
      entryKind,
      entryPremium,
      strike,
    });
    return { ok: true };
  } catch (err) {
    engineState.lastError = err.message;
    logLine('ENTRY_EXCEPTION', { error: err.message });
    return { ok: false, reason: 'EXCEPTION' };
  } finally {
    engineState.enteringTrade = false;
  }
}

/**
 * One-shot entry attempt (no recursive flip loops). Failures leave pending* for next poll.
 */
async function tryPendingOrStarterEntry(clock) {
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) return;
  if (!canPlaceNewEntry(clock.minutes)) return;
  if (engineState.nextEntryAllowedAtMs && Date.now() < engineState.nextEntryAllowedAtMs) return;

  if (engineState.pendingFlipOpposite && engineState.pendingFlipOptionType) {
    const placed = await placeLongOption(clock, {
      optionType: engineState.pendingFlipOptionType,
      entryKind: 'sl_flip',
    });
    if (!placed?.ok) {
      logLine('FLIP_PENDING', {
        optionType: engineState.pendingFlipOptionType,
        fail: placed?.reason,
        ist: istLabel(clock),
      });
    }
    return;
  }

  if (engineState.pendingSameSideReentry && engineState.pendingSameSideOptionType) {
    const readyAt = engineState.earliestEntryBarOpenMinutes;
    if (readyAt != null && clock.minutes < readyAt) return;

    const direction = await getCurrentBarDirection(engineState.symbol, clock);
    const aligned = directionSupportsOption(engineState.pendingSameSideOptionType, direction);
    if (!aligned) {
      logLine('TRAIL_REENTRY_DIRECTION_SOFT', {
        optionType: engineState.pendingSameSideOptionType,
        direction: direction || 'UNKNOWN',
        note: 'entering_anyway',
        ist: istLabel(clock),
      });
    }

    const placed = await placeLongOption(clock, {
      optionType: engineState.pendingSameSideOptionType,
      entryKind: 'trail_reentry',
    });
    if (!placed?.ok) {
      logLine('TRAIL_REENTRY_PENDING', {
        optionType: engineState.pendingSameSideOptionType,
        fail: placed?.reason,
        ist: istLabel(clock),
      });
    }
    return;
  }

  // Day starter: first position is always CE (including mid-day boot with dayTradeCount==0).
  if (!engineState.dayStartedCE && engineState.dayTradeCount === 0 && inEntryWindow(clock.minutes)) {
    const placed = await placeLongOption(clock, {
      optionType: 'CE',
      entryKind: 'day_starter_ce',
    });
    if (!placed?.ok) {
      logLine('STARTER_CE_PENDING', { fail: placed?.reason, ist: istLabel(clock) });
    }
  }
}

async function evaluateTickExit(trade, clock, ltp) {
  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return null;

  const entryPremium = Number(trade.entryPremium);
  if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(entryPremium)) return null;

  updateTrailFromLtp(entryPremium, ltp);

  const stopPx = engineState.trailStopPremium;
  if (stopPx == null) return null;

  // Use the worst (lowest) price seen since entry — not only the latest LTP.
  // Fast wicks that touch SL and bounce are otherwise missed.
  const low = engineState.lowSinceEntry != null ? Number(engineState.lowSinceEntry) : Number(ltp);
  const checkPx = Math.min(Number(ltp), low);
  if (!(Number.isFinite(checkPx) && checkPx <= Number(stopPx))) return null;

  const hardSl =
    engineState.hardStopPremium != null
      ? Number(engineState.hardStopPremium)
      : trade.stopLossPremium != null
        ? Number(trade.stopLossPremium)
        : entryPremium - engineState.settings.stopLossPoints;
  // Moved above hard SL → profit lock (TRAIL_STOP). Still at hard floor → STOP_LOSS (flip).
  const reason = Number(stopPx) > hardSl + 1e-6 ? 'TRAIL_STOP' : 'STOP_LOSS';
  return finalizeTrade(trade, {
    exitPremium: Number(stopPx),
    reason,
  });
}

async function checkOpenTrade() {
  if (engineState.closingTrade) return;
  const trade = await getOpenTrade();
  if (!trade || trade.exitTime) {
    engineState.openTradeId = null;
    return;
  }
  engineState.openTradeId = trade._id.toString();
  if (engineState.entryAtMs == null && trade.entryTime) {
    engineState.entryAtMs = new Date(trade.entryTime).getTime();
  }
  const clock = getIstClock(new Date());

  await reconcileOhlcFromCandles(trade, clock);

  const ltp = await getMarkPremium(trade);
  if (Number.isFinite(ltp) && ltp > 0) {
    const entry = Number(trade.entryPremium);
    engineState.openEntryPremium = entry;
    updateTrailFromLtp(entry, ltp);
    const prevHigh = Number(trade.highSinceEntry);
    const peakHigh = entry + engineState.peakProfitPoints;
    const highSinceEntry = Number.isFinite(prevHigh)
      ? Math.max(prevHigh, ltp, peakHigh)
      : Math.max(ltp, peakHigh);
    trade.highSinceEntry = Number(highSinceEntry.toFixed(2));
    const prevLow = Number(trade.lowSinceEntry);
    const lowSinceEntry = Number.isFinite(prevLow) && prevLow > 0
      ? Math.min(prevLow, engineState.lowSinceEntry ?? ltp, ltp)
      : (engineState.lowSinceEntry ?? ltp);
    trade.lowSinceEntry = Number(Number(lowSinceEntry).toFixed(2));
    engineState.lowSinceEntry = trade.lowSinceEntry;
    const mark = {
      at: new Date().toISOString(),
      source: engineState.lastOptionTick ? 'websocket' : 'chain',
      isLiveMark: true,
      optionType: trade.optionType,
      optionLtp: Number(ltp.toFixed(2)),
      entryPremium: entry,
      unrealizedPnl: Number(((ltp - entry) * trade.qty - (trade.charges || 0)).toFixed(2)),
      stopLossPremium: trade.stopLossPremium,
      trailStopPremium: engineState.trailStopPremium,
      peakProfitPoints: engineState.peakProfitPoints,
      lowSinceEntry: trade.lowSinceEntry,
      highSinceEntry: trade.highSinceEntry,
      exitMode: 'tick+low+ohlc1m',
      minHoldMs: MIN_HOLD_MS,
    };
    trade.openPositionMark = mark;
    trade.openPositionMarkAt = new Date();
    await trade.save();
    engineState.openPositionMark = mark;
  }

  engineState.closingTrade = true;
  let exitReason = null;
  try {
    if (isEod(clock.minutes)) {
      exitReason = await finalizeTrade(trade, {
        exitPremium: (Number.isFinite(ltp) && ltp > 0 ? ltp : null) || trade.entryPremium,
        reason: 'DAY_CLOSE',
      });
    } else {
      exitReason = await evaluateTickExit(trade, clock, ltp);
    }
  } finally {
    engineState.closingTrade = false;
  }

  // Immediate re-entry after exit — flip on SL, same-side on trail when direction aligns.
  if (
    exitReason === 'STOP_LOSS'
    || exitReason === 'BREAKEVEN_STOP'
    || exitReason === 'TRAIL_STOP'
  ) {
    await tryPendingOrStarterEntry(clock);
  }
}

async function pollOnce() {
  if (!engineState.running) return;
  const clock = getIstClock(new Date());
  try {
    await ensureNseHolidaysLoaded();
    if (isWeekendDateKey(clock.dateKey) || !isNseCashTradingDay(clock.dateKey)) {
      engineState.lastError = getNseHolidayDescription(clock.dateKey) || 'Market closed';
      return;
    }
    await resetSessionIfNewDay(clock);

    const open = await getOpenTrade();
    if (open) {
      engineState.openTradeId = open._id.toString();
      await checkOpenTrade();
    } else {
      engineState.openTradeId = null;
      if (!isEod(clock.minutes)) {
        await restorePendingReentryIfNeeded(clock);
        await tryPendingOrStarterEntry(clock);
      }
    }

    if (isEod(clock.minutes)) {
      const open = await getOpenTrade();
      if (open) {
        await finalizeTrade(open, {
          exitPremium: (await getMarkPremium(open)) || open.entryPremium,
          reason: 'DAY_CLOSE',
        });
      }
    }
  } catch (err) {
    engineState.lastError = err.message;
  }
}

function startPositionPoll() {
  if (engineState.positionPollTimer) return;
  engineState.positionPollTimer = setInterval(() => {
    checkOpenTrade().catch(() => {});
  }, POSITION_POLL_MS);
}

function stopPositionPoll() {
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => pollOnce().catch((e) => { engineState.lastError = e.message; });
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function syncOpenStateFromDb() {
  const open = await getOpenTrade();
  if (!open) {
    engineState.openTradeId = null;
    clearSubs();
    stopPositionPoll();
    const clock = getIstClock(new Date());
    await restorePendingReentryIfNeeded(clock);
    return;
  }
  engineState.openTradeId = open._id.toString();
  engineState.entryAtMs = open.entryTime ? new Date(open.entryTime).getTime() : Date.now();
  engineState.dayStartedCE = true;
  restoreTrailFromTrade(open);
  await subscribeOpenOption(open);
  startPositionPoll();
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings, symbol });
  engineState.symbol = engineState.settings.symbol;
  engineState.running = true;
  engineState.startedAt = new Date();
  engineState.lastError = null;
  const clock = getIstClock(new Date());
  await resetSessionIfNewDay(clock);
  await persistSettingsToWallet();
  await syncOpenStateFromDb();

  // Mid-day boot: window open, flat, no trades yet → buy CE once (via first poll / tryPending).
  if (
    !engineState.openTradeId
    && engineState.dayTradeCount === 0
    && !engineState.dayStartedCE
    && inEntryWindow(clock.minutes)
  ) {
    logLine('MIDDAY_STARTER_ARMED', { ist: istLabel(clock) });
  }

  startPoll();
  logLine('ENGINE_START', {
    ist: istLabel(clock),
    dayTradeCount: engineState.dayTradeCount,
    dayStartedCE: engineState.dayStartedCE,
    settings: engineState.settings,
  });
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  engineState.running = false;
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  engineState.pollTimer = null;
  stopPositionPoll();
  clearSubs();
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  engineState.settings = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.symbol = engineState.settings.symbol;
  await persistSettingsToWallet();
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  await loadSettingsFromWallet();
  return startEngine({ symbol: engineState.symbol || symbol, settings: engineState.settings });
}

async function resumeOpenPositionFromDb() {
  await loadSettingsFromWallet();
  if (!engineState.running) await startEngine({ symbol: engineState.symbol, settings: engineState.settings });
  else await syncOpenStateFromDb();
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    await bootEngineFromDb({ symbol: engineState.symbol || 'NIFTY' });
  }
  return { ok: true, state: getEngineSnapshot() };
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    strategyKey: STRATEGY_KEY,
    scenarioId,
    scenarioLabel,
    barIntervalMinutes: BAR_INTERVAL,
    symbol: engineState.symbol,
    startedAt: engineState.startedAt,
    settings: engineState.settings,
    lastError: engineState.lastError,
    lastSignalAt: engineState.lastSignalAt,
    dayTradeCount: engineState.dayTradeCount,
    dayStartedCE: engineState.dayStartedCE,
    entriesClosedForDay: engineState.entriesClosedForDay,
    pendingFlipOpposite: engineState.pendingFlipOpposite,
    pendingFlipOptionType: engineState.pendingFlipOptionType,
    pendingSameSideReentry: engineState.pendingSameSideReentry,
    pendingSameSideOptionType: engineState.pendingSameSideOptionType,
    openTradeId: engineState.openTradeId,
    earliestEntryBarOpenMinutes: engineState.earliestEntryBarOpenMinutes,
    earliestNextDecisionMinutes: engineState.earliestEntryBarOpenMinutes,
    peakProfitPoints: engineState.peakProfitPoints,
    trailStopPremium: engineState.trailStopPremium,
    hardStopPremium: engineState.hardStopPremium,
    lowSinceEntry: engineState.lowSinceEntry,
    highSinceEntry: engineState.openPositionMark?.highSinceEntry ?? null,
    openPositionMark: engineState.openPositionMark,
    lastOptionTick: engineState.lastOptionTick,
    exitMode: 'tick+low+ohlc1m',
  };
}

async function refreshOpenPositionMarkForStatus() {
  const trade = await getOpenTrade();
  if (!trade) return null;
  const clock = getIstClock(new Date());
  await reconcileOhlcFromCandles(trade, clock);
  const ltp = await getMarkPremium(trade);
  if (!Number.isFinite(ltp)) return trade.openPositionMark;
  const entry = Number(trade.entryPremium);
  engineState.openEntryPremium = entry;
  updateTrailFromLtp(entry, ltp);
  const prevHigh = Number(trade.highSinceEntry);
  const highSinceEntry = Number.isFinite(prevHigh) ? Math.max(prevHigh, ltp) : ltp;
  trade.highSinceEntry = Number(highSinceEntry.toFixed(2));
  const prevLow = Number(trade.lowSinceEntry);
  const lowSinceEntry = Number.isFinite(prevLow) && prevLow > 0
    ? Math.min(prevLow, engineState.lowSinceEntry ?? ltp, ltp)
    : (engineState.lowSinceEntry ?? ltp);
  trade.lowSinceEntry = Number(Number(lowSinceEntry).toFixed(2));
  engineState.lowSinceEntry = trade.lowSinceEntry;
  const mark = {
    at: new Date().toISOString(),
    source: engineState.lastOptionTick ? 'websocket' : 'chain',
    isLiveMark: true,
    optionType: trade.optionType,
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    unrealizedPnl: Number(((ltp - entry) * trade.qty - (trade.charges || 0)).toFixed(2)),
    stopLossPremium: trade.stopLossPremium,
    hardStopPremium: engineState.hardStopPremium,
    trailStopPremium: engineState.trailStopPremium,
    peakProfitPoints: engineState.peakProfitPoints,
    lowSinceEntry: trade.lowSinceEntry,
    highSinceEntry: trade.highSinceEntry,
    exitMode: 'tick+low+ohlc1m',
  };
  trade.openPositionMark = mark;
  trade.openPositionMarkAt = new Date();
  await trade.save();
  engineState.openPositionMark = mark;
  return mark;
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).lean();
  let realized = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
    const p = Number(t.pnl) || 0;
    realized += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realized.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = closed.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return wallet;
}

async function closeOpenPosition({ reason = 'MANUAL_CLOSE' } = {}) {
  const trade = await getOpenTrade();
  if (!trade) return { ok: true };
  await finalizeTrade(trade, {
    exitPremium: (await getMarkPremium(trade)) || trade.entryPremium,
    reason,
  });
  return { ok: true };
}

async function reconcileOpenTrades() {
  await syncOpenStateFromDb();
  return { ok: true };
}

async function clearDailySkipState() {
  const clock = getIstClock(new Date());
  engineState.entriesClosedForDay = false;
  clearPendingEntryState();
  if (engineState.dayTradeCount === 0) engineState.dayStartedCE = false;
  logLine('CLEAR_DAILY_SKIP', { ist: istLabel(clock) });
  return { ok: true, state: getEngineSnapshot() };
}

  return {
    STRATEGY_KEY,
    scenarioId,
    scenarioLabel,
    barIntervalMinutes: BAR_INTERVAL,
    startEngine,
    stopEngine,
    updateEngineSettings,
    bootEngineFromDb,
    ensureEngineRunning,
    getEngineSnapshot,
    refreshOpenPositionMark: refreshOpenPositionMarkForStatus,
    refreshOpenPositionMarkForStatus,
    ensureWallet,
    recalcWalletFromTrades,
    reconcileOpenTrades,
    resumeOpenPositionFromDb,
    closeOpenPosition,
    clearDailySkipState,
  };
}

module.exports = { createSlFlipPaperLiveEngine };

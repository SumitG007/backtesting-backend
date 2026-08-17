/**
 * OI Flow minute recorder — current trading day only (LOCKED).
 * Captures every IST minute from 09:15 → 15:30.
 * On a new day, previous dateKeys are deleted (one day in DB).
 *
 * Focus = Change in OI (ΔOI), not absolute standing OI.
 * dayCallChgOi / dayPutChgOi = ATM ± 3 day-so-far ΔOI (our "total OI")
 * callsChgOi / putsChgOi     = interval ΔOI on overlapping strikes (ignores ATM window hops)
 * chngInDir                  = Puts chng − Calls chng (interval)
 * diffInOi                   = day Put Δ − day Call Δ (+ when Puts building more)
 * dirOfChng                  = up / down / flat from chngInDir
 * callOiTotal / putOiTotal   = absolute OI stored for reference only
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { getIstClock, isWeekendDateKey, sleep } = require('../utils/dateTime');
const { isNseCashTradingDay } = require('./nseHolidayService');
const {
  getNearestWeeklyExpiry,
  getOptionChainOiSnapshot,
} = require('./dhanLiveService');
const { compactStrikes, intervalOiFromRows } = require('../utils/oiFlowIntervalOi');

const SYMBOL = 'NIFTY';
const SESSION_FROM = 9 * 60 + 15; // 09:15
const SESSION_TO = 15 * 60 + 30; // 15:30
/** ATM ± 3 strikes (3 left + ATM + 3 right). */
const LOOKAROUND_STRIKES = 3;
const LOOP_MS = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const engineState = {
  running: false,
  startedAt: null,
  loopTimer: null,
  tickInFlight: false,
  symbol: SYMBOL,
  dateKey: null,
  lastMinutes: null,
  lastError: null,
  lastFetchedAt: null,
  lastRow: null,
  expiry: null,
};

function formatHhmm(minutes) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function dirArrow(value) {
  if (!Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function sentimentFromDiff(chngInDir) {
  if (!Number.isFinite(chngInDir) || chngInDir === 0) return 'Neutral';
  // Chng in dir = Puts chng − Calls chng → Put-heavy = Bull, Call-heavy = Bear
  return chngInDir > 0 ? 'Bull' : 'Bear';
}

function deriveFields({
  dayCallChgOi,
  dayPutChgOi,
  strikes,
  prev,
}) {
  const interval = intervalOiFromRows({ dayCallChgOi, dayPutChgOi, strikes }, prev);
  const callsChgOi = interval.callsChgOi;
  const putsChgOi = interval.putsChgOi;

  // Chng in dir = interval Calls/Puts Δ (Puts − Calls).
  const chngInDir =
    Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
      ? putsChgOi - callsChgOi
      : null;

  // Diff. in OI = day Put Δ − day Call Δ (change totals, not absolute OI).
  const diffInOi =
    Number.isFinite(dayPutChgOi) && Number.isFinite(dayCallChgOi)
      ? dayPutChgOi - dayCallChgOi
      : null;

  return {
    callsChgOi,
    putsChgOi,
    dayCallChgOi: Number.isFinite(dayCallChgOi) ? dayCallChgOi : null,
    dayPutChgOi: Number.isFinite(dayPutChgOi) ? dayPutChgOi : null,
    diffInOi,
    chngInDir,
    dirOfChng: dirArrow(chngInDir),
    sentiment: sentimentFromDiff(chngInDir),
  };
}

async function purgeOtherDays(dateKey) {
  const result = await OiFlowMinuteRow.deleteMany({
    dateKey: { $ne: dateKey },
  });
  return result?.deletedCount || 0;
}

async function getPreviousRow(symbol, dateKey, minutes) {
  return OiFlowMinuteRow.findOne({
    symbol,
    dateKey,
    minutes: { $lt: minutes },
    fetchOk: true,
    callOiTotal: { $ne: null },
  })
    .sort({ minutes: -1 })
    .lean();
}

async function captureMinute({ dateKey, minutes, forceRetry = false } = {}) {
  const time = formatHhmm(minutes);
  const existing = await OiFlowMinuteRow.findOne({
    symbol: engineState.symbol,
    dateKey,
    minutes,
  }).lean();

  if (existing?.fetchOk && !forceRetry) {
    engineState.lastMinutes = minutes;
    engineState.lastRow = existing;
    return existing;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      if (!engineState.expiry) {
        engineState.expiry = await getNearestWeeklyExpiry(engineState.symbol);
      }
      const snapshot = await getOptionChainOiSnapshot({
        symbol: engineState.symbol,
        expiry: engineState.expiry,
        lookaroundStrikes: LOOKAROUND_STRIKES,
      });
      // ATM ± 3 window only (not full chain).
      const callOiTotal = snapshot?.totals?.callOi;
      const putOiTotal = snapshot?.totals?.putOi;
      const dayCallChgOi = snapshot?.totals?.callChgOi;
      const dayPutChgOi = snapshot?.totals?.putChgOi;
      const strikes = compactStrikes(snapshot?.strikes);
      const spotPrice = Number.isFinite(snapshot?.spot) ? snapshot.spot : null;
      const prev = await getPreviousRow(engineState.symbol, dateKey, minutes);
      const derived = deriveFields({
        dayCallChgOi,
        dayPutChgOi,
        strikes,
        prev,
      });

      const doc = {
        symbol: engineState.symbol,
        dateKey,
        minutes,
        time,
        spotPrice,
        atm: Number.isFinite(snapshot?.atm) ? snapshot.atm : null,
        lookaroundStrikes: LOOKAROUND_STRIKES,
        strikes,
        callOiTotal: Number.isFinite(callOiTotal) ? callOiTotal : null,
        putOiTotal: Number.isFinite(putOiTotal) ? putOiTotal : null,
        dayCallChgOi: Number.isFinite(dayCallChgOi) ? dayCallChgOi : null,
        dayPutChgOi: Number.isFinite(dayPutChgOi) ? dayPutChgOi : null,
        ...derived,
        expiry: engineState.expiry || null,
        fetchOk: true,
        error: null,
        fetchedAt: new Date(),
      };

      const saved = await OiFlowMinuteRow.findOneAndUpdate(
        { symbol: engineState.symbol, dateKey, minutes },
        { $set: doc },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();

      engineState.lastMinutes = minutes;
      engineState.lastRow = saved;
      engineState.lastFetchedAt = saved.fetchedAt;
      engineState.lastError = null;
      return saved;
    } catch (err) {
      lastErr = err;
      engineState.lastError = err.message;
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  const failed = {
    symbol: engineState.symbol,
    dateKey,
    minutes,
    time,
    spotPrice: null,
    atm: null,
    lookaroundStrikes: LOOKAROUND_STRIKES,
    strikes: [],
    callOiTotal: null,
    putOiTotal: null,
    dayCallChgOi: null,
    dayPutChgOi: null,
    callsChgOi: null,
    putsChgOi: null,
    diffInOi: null,
    dirOfChng: null,
    chngInDir: null,
    sentiment: null,
    expiry: engineState.expiry || null,
    fetchOk: false,
    error: lastErr?.message || 'Fetch failed',
    fetchedAt: new Date(),
  };

  const saved = await OiFlowMinuteRow.findOneAndUpdate(
    { symbol: engineState.symbol, dateKey, minutes },
    { $set: failed },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  engineState.lastMinutes = minutes;
  engineState.lastRow = saved;
  engineState.lastFetchedAt = saved.fetchedAt;
  return saved;
}

async function tick() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    const clock = getIstClock(new Date());
    const { dateKey, minutes } = clock;

    if (engineState.dateKey && engineState.dateKey !== dateKey) {
      engineState.expiry = null;
      engineState.lastMinutes = null;
      engineState.lastRow = null;
    }
    if (engineState.dateKey !== dateKey) {
      await purgeOtherDays(dateKey);
      engineState.dateKey = dateKey;
    }

    if (isWeekendDateKey(dateKey) || !isNseCashTradingDay(dateKey)) {
      engineState.lastError = isWeekendDateKey(dateKey) ? 'WEEKEND' : 'HOLIDAY';
      return;
    }

    if (minutes < SESSION_FROM || minutes > SESSION_TO) {
      return;
    }

    if (engineState.lastMinutes === minutes && engineState.lastRow?.fetchOk) {
      return;
    }

    await captureMinute({ dateKey, minutes });
  } catch (err) {
    engineState.lastError = err.message;
  } finally {
    engineState.tickInFlight = false;
  }
}

function ensureEngineRunning() {
  if (engineState.running && engineState.loopTimer) {
    return { ok: true, already: true };
  }
  engineState.running = true;
  engineState.startedAt = new Date().toISOString();
  if (engineState.loopTimer) clearInterval(engineState.loopTimer);
  engineState.loopTimer = setInterval(() => {
    tick().catch((err) => {
      engineState.lastError = err.message;
    });
  }, LOOP_MS);
  tick().catch((err) => {
    engineState.lastError = err.message;
  });
  return { ok: true, started: true };
}

function buildRowFromSnapshot(snapshot, clock, prev, { livePreview = false, afterClose = false } = {}) {
  const callOiTotal = snapshot?.totals?.callOi;
  const putOiTotal = snapshot?.totals?.putOi;
  const dayCallChgOi = snapshot?.totals?.callChgOi;
  const dayPutChgOi = snapshot?.totals?.putChgOi;
  const strikes = compactStrikes(snapshot?.strikes);
  const spotPrice = Number.isFinite(snapshot?.spot) ? snapshot.spot : null;
  const derived = deriveFields({
    dayCallChgOi,
    dayPutChgOi,
    strikes,
    prev,
  });
  return {
    symbol: engineState.symbol,
    dateKey: clock.dateKey,
    minutes: clock.minutes,
    time: formatHhmm(clock.minutes),
    spotPrice,
    atm: Number.isFinite(snapshot?.atm) ? snapshot.atm : null,
    lookaroundStrikes: LOOKAROUND_STRIKES,
    strikes,
    callOiTotal: Number.isFinite(callOiTotal) ? callOiTotal : null,
    putOiTotal: Number.isFinite(putOiTotal) ? putOiTotal : null,
    dayCallChgOi: Number.isFinite(dayCallChgOi) ? dayCallChgOi : null,
    dayPutChgOi: Number.isFinite(dayPutChgOi) ? dayPutChgOi : null,
    ...derived,
    expiry: engineState.expiry || null,
    fetchOk: true,
    error: null,
    fetchedAt: new Date(),
    livePreview: Boolean(livePreview),
    afterClose: Boolean(afterClose),
    isLastEntry: true,
  };
}

/** Display-only fetch after 15:30 — never written as a session minute row. */
async function buildAfterCloseLastEntry(clock, prev) {
  try {
    if (!engineState.expiry) {
      engineState.expiry = await getNearestWeeklyExpiry(engineState.symbol);
    }
    const snapshot = await getOptionChainOiSnapshot({
      symbol: engineState.symbol,
      expiry: engineState.expiry,
      lookaroundStrikes: LOOKAROUND_STRIKES,
    });
    return buildRowFromSnapshot(snapshot, clock, prev, { livePreview: true, afterClose: true });
  } catch (err) {
    engineState.lastError = err.message;
    return null;
  }
}

/** API payload — omit per-strike snapshots (large; table uses precomputed ΔOI). */
const OI_FLOW_TODAY_SELECT =
  '-strikes -createdAt -updatedAt -__v';

function stripStrikes(row) {
  if (!row || typeof row !== 'object') return row;
  const { strikes: _s, ...rest } = row;
  return rest;
}

async function getStatus() {
  const clock = getIstClock(new Date());
  const count = await OiFlowMinuteRow.countDocuments({
    symbol: engineState.symbol,
    dateKey: clock.dateKey,
  });
  let lastRow = engineState.lastRow;
  if (!lastRow) {
    lastRow = await OiFlowMinuteRow.findOne({
      symbol: engineState.symbol,
      dateKey: clock.dateKey,
      fetchOk: true,
    })
      .sort({ minutes: -1 })
      .lean();
    if (lastRow) {
      engineState.lastRow = lastRow;
      engineState.lastMinutes = lastRow.minutes;
      engineState.lastFetchedAt = lastRow.fetchedAt;
    }
  }
  const lastMinutes = lastRow?.minutes ?? null;
  const lastTime = lastRow?.time || null;
  return {
    running: engineState.running,
    startedAt: engineState.startedAt,
    symbol: engineState.symbol,
    dateKey: clock.dateKey,
    nowTime: formatHhmm(clock.minutes),
    sessionFrom: formatHhmm(SESSION_FROM),
    sessionTo: formatHhmm(SESSION_TO),
    inSession: clock.minutes >= SESSION_FROM && clock.minutes <= SESSION_TO,
    isTradingDay: !isWeekendDateKey(clock.dateKey) && isNseCashTradingDay(clock.dateKey),
    rowCount: count,
    expectedRows: SESSION_TO - SESSION_FROM + 1,
    lastMinutes,
    lastTime,
    lastFetchedAt: lastRow?.fetchedAt || null,
    lastError: engineState.lastError,
    lastRow: lastRow || null,
    expiry: engineState.expiry,
    lookaroundStrikes: LOOKAROUND_STRIKES,
  };
}

async function listTodayRows() {
  const clock = getIstClock(new Date());
  const rows = await OiFlowMinuteRow.find({
    symbol: engineState.symbol,
    dateKey: clock.dateKey,
  })
    .select(OI_FLOW_TODAY_SELECT)
    .sort({ minutes: -1 })
    .lean();

  const lastRowFromDb = rows.find((r) => r.fetchOk) || rows[0] || null;
  let lastRow = engineState.lastRow;
  if (
    lastRowFromDb
    && (!lastRow?.minutes || lastRowFromDb.minutes >= lastRow.minutes)
  ) {
    lastRow = lastRowFromDb;
  }
  if (lastRow) lastRow = stripStrikes(lastRow);

  const status = {
    running: engineState.running,
    startedAt: engineState.startedAt,
    symbol: engineState.symbol,
    dateKey: clock.dateKey,
    nowTime: formatHhmm(clock.minutes),
    sessionFrom: formatHhmm(SESSION_FROM),
    sessionTo: formatHhmm(SESSION_TO),
    inSession: clock.minutes >= SESSION_FROM && clock.minutes <= SESSION_TO,
    isTradingDay: !isWeekendDateKey(clock.dateKey) && isNseCashTradingDay(clock.dateKey),
    rowCount: rows.length,
    expectedRows: SESSION_TO - SESSION_FROM + 1,
    lastMinutes: lastRow?.minutes ?? null,
    lastTime: lastRow?.time || null,
    lastFetchedAt: lastRow?.fetchedAt || null,
    lastError: engineState.lastError,
    lastRow,
    expiry: engineState.expiry,
    lookaroundStrikes: LOOKAROUND_STRIKES,
  };

  let displayRow = status.lastRow || rows[0] || null;

  // Outside 09:15–15:30: still show last entry, Time always 15:30.
  if (!status.inSession) {
    if (displayRow) {
      displayRow = {
        ...displayRow,
        time: formatHhmm(SESSION_TO),
        minutes: SESSION_TO,
        sessionCaptureTime: displayRow.time,
        afterClose: true,
        isLastEntry: true,
        livePreview: false,
      };
    } else {
      const preview = await buildAfterCloseLastEntry(clock, null);
      if (preview) {
        displayRow = {
          ...preview,
          time: formatHhmm(SESSION_TO),
          minutes: SESSION_TO,
          afterClose: true,
          isLastEntry: true,
        };
      }
    }
  }

  return { ...status, rows, displayRow };
}

module.exports = {
  ensureEngineRunning,
  getStatus,
  listTodayRows,
  captureMinute,
  SESSION_FROM,
  SESSION_TO,
  LOOKAROUND_STRIKES,
};

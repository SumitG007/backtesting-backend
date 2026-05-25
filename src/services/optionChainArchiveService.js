const OptionChainSnapshot = require('../models/optionChainSnapshot');
const { ensureOptionChainIndexes } = require('../models/optionChainSnapshot');
const { fetchOptionChain } = require('./dhanLiveService');
const { resolveSymbolConfig } = require('../utils/market');
const { getIstClock, isWeekendDateKey, sleep, buildIstWallClockTimestamp } = require('../utils/dateTime');
const { isNseCashTradingDay } = require('./nseHolidayService');
const {
  DEFAULT_ARCHIVE_EXPIRIES,
  DEFAULT_ARCHIVE_SYMBOL,
  EXPIRY_FETCH_GAP_MS,
  RECORDER_CYCLE_PAUSE_MS,
  FETCH_MAX_ATTEMPTS,
  FETCH_RETRY_DELAYS_MS,
  DB_SAVE_MAX_ATTEMPTS,
  ALLOWED_CAPTURE_MINUTES,
  ALLOWED_IST_TIME_KEYS,
  CAPTURE_TIME_SLOTS,
  formatIstTimeKey,
  minutesFromIstTimeKey,
  isOutsideCaptureZones,
} = require('../config/optionChainArchive');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeLeg(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const g = leg.greeks || {};
  const oi = int(leg.oi);
  const previousOi = int(leg.previous_oi);
  const oiChange = oi != null && previousOi != null ? oi - previousOi : null;
  return {
    average_price: num(leg.average_price),
    implied_volatility: num(leg.implied_volatility),
    last_price: num(leg.last_price),
    oi,
    oi_change: oiChange,
    previous_close_price: num(leg.previous_close_price),
    previous_oi: previousOi,
    previous_volume: int(leg.previous_volume),
    security_id: leg.security_id != null ? Number(leg.security_id) : null,
    top_ask_price: num(leg.top_ask_price),
    top_ask_quantity: int(leg.top_ask_quantity),
    top_bid_price: num(leg.top_bid_price),
    top_bid_quantity: int(leg.top_bid_quantity),
    volume: int(leg.volume),
    greeks: {
      delta: num(g.delta),
      theta: num(g.theta),
      gamma: num(g.gamma),
      vega: num(g.vega),
    },
  };
}

/** Dhan POST /optionchain returns { data: { last_price, oc } } — unwrap all shapes. */
function unwrapDhanChainPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (raw.oc && typeof raw.oc === 'object') return raw;
  if (raw.data?.oc) return raw.data;
  return raw;
}

function parseDhanError(error) {
  const status = Number(error?.response?.status);
  const body = error?.response?.data;
  const code = body?.errorCode || body?.error_code;
  const msg = body?.errorMessage || body?.error_message || body?.message || error?.message;
  if (status === 401 || status === 403 || /token|credential|auth/i.test(String(msg))) {
    return { code: 'DHAN_AUTH', message: 'Dhan access token missing or expired. Update token in settings.' };
  }
  if (status === 429 || code === 'DH-904' || /rate\s*limit/i.test(String(msg))) {
    return { code: 'RATE_LIMIT', message: 'Dhan rate limit — retrying automatically.' };
  }
  if (status >= 500) {
    return { code: 'DHAN_SERVER', message: `Dhan server error (${status}) — retrying.` };
  }
  return { code: 'DHAN_API', message: String(msg || 'Failed to fetch option chain from Dhan') };
}

function flattenOptionChain(chainData) {
  const payload = unwrapDhanChainPayload(chainData);
  const oc = payload?.oc || {};
  const strikes = Object.keys(oc)
    .map((key) => {
      const strike = Number(key);
      if (!Number.isFinite(strike)) return null;
      const row = oc[key] || {};
      return {
        strike,
        ce: normalizeLeg(row.ce),
        pe: normalizeLeg(row.pe),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.strike - b.strike);
  return {
    spot: num(payload?.last_price),
    strikes,
    rawOc: oc,
  };
}

function validateArchiveSetup() {
  const resolved = resolveSymbolConfig(DEFAULT_ARCHIVE_SYMBOL);
  if (!resolved.securityId || resolved.exchangeSegment !== 'IDX_I') {
    throw new Error(`Invalid NIFTY Dhan config: securityId=${resolved.securityId} seg=${resolved.exchangeSegment}`);
  }
  for (const expiry of DEFAULT_ARCHIVE_EXPIRIES) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
      throw new Error(`Invalid expiry format (use YYYY-MM-DD): ${expiry}`);
    }
  }
}

function isAllowedCaptureMinute(minutes) {
  return ALLOWED_CAPTURE_MINUTES.includes(minutes);
}

function isWithinCaptureWindow(now = new Date()) {
  const clock = getIstClock(now.toISOString());
  if (!isNseCashTradingDay(clock.dateKey)) return false;
  return isAllowedCaptureMinute(clock.minutes);
}

/** @deprecated alias */
function isWithinNseCashSession() {
  return isWithinCaptureWindow();
}

function normalizeIstTimeQuery(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (isOutsideCaptureZones(minutes)) return null;
  const key = formatIstTimeKey(minutes);
  return ALLOWED_IST_TIME_KEYS.includes(key) ? key : null;
}

function istMinuteUtcRange(dateKey, timeKey) {
  const minutes = minutesFromIstTimeKey(timeKey);
  if (!Number.isFinite(minutes)) return null;
  const startMs = buildIstWallClockTimestamp(dateKey, minutes);
  const endMs = buildIstWallClockTimestamp(dateKey, minutes + 1);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { start: new Date(startMs), end: new Date(endMs) };
}

function deriveIstTimeFromRow(row) {
  if (row?.istTime && ALLOWED_IST_TIME_KEYS.includes(row.istTime)) return row.istTime;
  const clock = getIstClock(row.capturedAt);
  if (isOutsideCaptureZones(clock.minutes)) return null;
  return formatIstTimeKey(clock.minutes);
}

async function findSnapshotAtSlot({ symbol, expiry, dateKey, istTime }) {
  const sym = String(symbol).toUpperCase();
  const exp = String(expiry).slice(0, 10);
  const timeKey = normalizeIstTimeQuery(istTime);
  if (!timeKey) return null;

  const dayKey = dateKey
    ? String(dateKey).slice(0, 10)
    : getIstClock(new Date().toISOString()).dateKey;

  let row = await OptionChainSnapshot.findOne({
    symbol: sym,
    expiry: exp,
    dateKey: dayKey,
    istTime: timeKey,
  })
    .sort({ capturedAt: -1 })
    .lean();

  if (row) return row;

  const range = istMinuteUtcRange(dayKey, timeKey);
  if (!range) return null;

  row = await OptionChainSnapshot.findOne({
    symbol: sym,
    expiry: exp,
    dateKey: dayKey,
    capturedAt: { $gte: range.start, $lt: range.end },
  })
    .sort({ capturedAt: -1 })
    .lean();

  return row;
}

async function findLatestInWindowSnapshot({ symbol, expiry, dateKey }) {
  const sym = String(symbol).toUpperCase();
  const exp = String(expiry).slice(0, 10);
  const dayKey = dateKey
    ? String(dateKey).slice(0, 10)
    : getIstClock(new Date().toISOString()).dateKey;

  let row = await OptionChainSnapshot.findOne({
    symbol: sym,
    expiry: exp,
    dateKey: dayKey,
    istTime: { $in: ALLOWED_IST_TIME_KEYS },
  })
    .sort({ capturedAt: -1 })
    .lean();

  if (row) return row;

  const candidates = await OptionChainSnapshot.find({ symbol: sym, expiry: exp, dateKey: dayKey })
    .sort({ capturedAt: -1 })
    .limit(80)
    .lean();

  return (
    candidates.find((doc) => {
      const clock = getIstClock(doc.capturedAt);
      return !isOutsideCaptureZones(clock.minutes);
    }) || null
  );
}

const recorderState = {
  running: false,
  symbol: DEFAULT_ARCHIVE_SYMBOL,
  expiries: [...DEFAULT_ARCHIVE_EXPIRIES],
  onlyCaptureWindows: true,
  loopTask: null,
  startedAt: null,
  lastCycleAt: null,
  lastError: null,
  lastErrorCode: null,
  marketWasOpen: false,
  totals: { saved: 0, failed: 0 },
  lastCaptureByExpiry: {},
};

const MARKET_CLOSED_POLL_MS = 10000;

function retryDelayMs(attemptIndex, errorCode) {
  if (errorCode === 'RATE_LIMIT') return FETCH_RETRY_DELAYS_MS[FETCH_RETRY_DELAYS_MS.length - 1];
  return FETCH_RETRY_DELAYS_MS[attemptIndex] ?? 12000;
}

async function fetchOptionChainWithRetry({ symbol, expiry }) {
  let lastError = null;
  for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const code = lastError ? parseDhanError(lastError).code : 'DHAN_API';
      const waitMs = retryDelayMs(attempt, code);
      console.warn(
        `[OptionChainArchive] Retry ${attempt + 1}/${FETCH_MAX_ATTEMPTS} ${expiry} after ${waitMs}ms (${code})`,
      );
      await sleep(waitMs);
    }
    try {
      const raw = await fetchOptionChain({ symbol, expiry });
      const payload = unwrapDhanChainPayload(raw);
      const strikeKeys = Object.keys(payload?.oc || {});
      if (strikeKeys.length === 0) {
        throw Object.assign(new Error('Empty option chain (no strikes in oc)'), { code: 'EMPTY_CHAIN' });
      }
      return payload;
    } catch (error) {
      lastError = error;
      const parsed = parseDhanError(error);
      if (parsed.code === 'DHAN_AUTH' && attempt >= FETCH_MAX_ATTEMPTS - 1) break;
    }
  }
  throw lastError || new Error('Failed to fetch option chain');
}

async function saveChainSnapshot({ symbol, expiry, chainData, recorderRunId }) {
  const capturedAt = new Date();
  const clock = getIstClock(capturedAt.toISOString());

  if (!isAllowedCaptureMinute(clock.minutes)) {
    throw Object.assign(new Error('Snapshot outside capture windows (9:15–9:30 or 15:15–15:30 IST)'), {
      code: 'OUTSIDE_CAPTURE_WINDOW',
    });
  }

  const istTime = formatIstTimeKey(clock.minutes);
  const flat = flattenOptionChain(chainData);

  if (flat.strikes.length === 0) {
    throw new Error('Cannot save snapshot: zero strikes after normalize');
  }

  const docPayload = {
    symbol: String(symbol).toUpperCase(),
    expiry: String(expiry).slice(0, 10),
    capturedAt,
    dateKey: clock.dateKey,
    istTime,
    spot: flat.spot,
    strikeCount: flat.strikes.length,
    strikes: flat.strikes,
    source: 'dhan-optionchain',
    recorderRunId: recorderRunId || null,
  };

  let lastDbError = null;
  for (let attempt = 0; attempt < DB_SAVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 0) await sleep(1000 * attempt);
      const existing = await OptionChainSnapshot.findOne({
        symbol: docPayload.symbol,
        expiry: docPayload.expiry,
        dateKey: docPayload.dateKey,
        istTime: docPayload.istTime,
      });
      if (existing) {
        return await OptionChainSnapshot.findByIdAndUpdate(existing._id, docPayload, { new: true });
      }
      return await OptionChainSnapshot.create(docPayload);
    } catch (error) {
      lastDbError = error;
      if (error?.code === 11000) {
        const existing = await OptionChainSnapshot.findOne({
          symbol: docPayload.symbol,
          expiry: docPayload.expiry,
          dateKey: docPayload.dateKey,
          istTime: docPayload.istTime,
        });
        if (existing) {
          return await OptionChainSnapshot.findByIdAndUpdate(existing._id, docPayload, { new: true });
        }
      }
      console.error(`[OptionChainArchive] Mongo save retry ${attempt + 1}:`, error.message);
    }
  }
  throw lastDbError || new Error('MongoDB save failed');
}

async function captureExpiryChain({ symbol, expiry, recorderRunId }) {
  const chainData = await fetchOptionChainWithRetry({ symbol, expiry });
  const doc = await saveChainSnapshot({ symbol, expiry, chainData, recorderRunId });
  recorderState.lastCaptureByExpiry[expiry] = {
    at: doc.capturedAt,
    spot: doc.spot,
    strikeCount: doc.strikeCount,
    id: String(doc._id),
  };
  recorderState.totals.saved += 1;
  recorderState.lastError = null;
  recorderState.lastErrorCode = null;
  console.log(
    `[OptionChainArchive] Saved ${symbol} ${expiry} — ${doc.strikeCount} strikes, spot ${doc.spot}`,
  );
  return doc;
}

async function captureAllExpiries({ symbol, expiries, recorderRunId, respectRateLimit = true }) {
  const results = [];
  const errors = [];
  const failedExpiries = [];

  for (let i = 0; i < expiries.length; i += 1) {
    const expiry = expiries[i];
    try {
      const doc = await captureExpiryChain({ symbol, expiry, recorderRunId });
      results.push({
        expiry,
        ok: true,
        id: String(doc._id),
        capturedAt: doc.capturedAt,
        strikeCount: doc.strikeCount,
        spot: doc.spot,
      });
    } catch (error) {
      recorderState.totals.failed += 1;
      const parsed = parseDhanError(error);
      recorderState.lastError = parsed.message;
      recorderState.lastErrorCode = parsed.code;
      errors.push({ expiry, ok: false, error: parsed.message, code: parsed.code });
      failedExpiries.push(expiry);
      console.error(`[OptionChainArchive] Failed ${symbol} ${expiry}:`, parsed.message);
    }
    if (respectRateLimit && i < expiries.length - 1) {
      await sleep(EXPIRY_FETCH_GAP_MS);
    }
  }

  if (failedExpiries.length > 0) {
    console.log('[OptionChainArchive] Re-trying failed expiries once more:', failedExpiries.join(', '));
    await sleep(EXPIRY_FETCH_GAP_MS);
    for (const expiry of failedExpiries) {
      try {
        const doc = await captureExpiryChain({ symbol, expiry, recorderRunId });
        results.push({
          expiry,
          ok: true,
          id: String(doc._id),
          capturedAt: doc.capturedAt,
          strikeCount: doc.strikeCount,
          spot: doc.spot,
        });
        errors.splice(errors.findIndex((e) => e.expiry === expiry), 1);
      } catch (error) {
        const parsed = parseDhanError(error);
        console.error(`[OptionChainArchive] Second pass failed ${expiry}:`, parsed.message);
      }
      await sleep(EXPIRY_FETCH_GAP_MS);
    }
  }

  recorderState.lastCycleAt = new Date();
  return { results, errors };
}

async function purgeInvalidSnapshots() {
  const allowedKeySet = new Set(ALLOWED_IST_TIME_KEYS);
  let deleted = 0;

  const badIstTime = await OptionChainSnapshot.deleteMany({
    istTime: { $exists: true, $nin: [...allowedKeySet] },
  });
  deleted += badIstTime.deletedCount || 0;

  const rows = await OptionChainSnapshot.find({})
    .select('_id capturedAt istTime symbol expiry dateKey')
    .lean();

  const toDelete = [];
  const keepBySlot = new Map();

  for (const row of rows) {
    const clock = getIstClock(row.capturedAt);
    const dateKey = row.dateKey || clock.dateKey;

    if (isOutsideCaptureZones(clock.minutes)) {
      toDelete.push(row._id);
      continue;
    }

    const timeKey = deriveIstTimeFromRow(row);
    if (!timeKey) {
      toDelete.push(row._id);
      continue;
    }

    const slotKey = `${row.symbol}|${row.expiry}|${dateKey}|${timeKey}`;
    const prev = keepBySlot.get(slotKey);
    if (!prev || new Date(row.capturedAt) > new Date(prev.capturedAt)) {
      if (prev) toDelete.push(prev._id);
      keepBySlot.set(slotKey, { _id: row._id, istTime: timeKey, dateKey });
    } else {
      toDelete.push(row._id);
    }
  }

  if (toDelete.length > 0) {
    const r = await OptionChainSnapshot.deleteMany({ _id: { $in: toDelete } });
    deleted += r.deletedCount || 0;
  }

  for (const doc of keepBySlot.values()) {
    await OptionChainSnapshot.updateOne(
      { _id: doc._id },
      { $set: { istTime: doc.istTime, dateKey: doc.dateKey } },
    );
  }

  if (deleted > 0) {
    console.log(
      `[OptionChainArchive] Purged ${deleted} snapshot(s) outside 9:15–9:30 & 15:15–15:30 IST (incl. after 9:30 / before 3:15)`,
    );
  }

  return { deleted, kept: keepBySlot.size };
}

async function recorderLoop() {
  console.log(
    '[OptionChainArchive] Recorder active — capture only 9:15–9:30 & 15:15–15:30 IST (1 slot per minute per expiry)',
  );
  while (recorderState.running) {
    const inWindow = isWithinCaptureWindow();
    try {
      if (inWindow && !recorderState.marketWasOpen) {
        console.log('[OptionChainArchive] Capture window open — fetching both expiries');
      }
      recorderState.marketWasOpen = inWindow;

      if (!recorderState.onlyCaptureWindows || inWindow) {
        const runId = `run-${Date.now()}`;
        const { errors } = await captureAllExpiries({
          symbol: recorderState.symbol,
          expiries: recorderState.expiries,
          recorderRunId: runId,
          respectRateLimit: true,
        });
        if (errors.length === recorderState.expiries.length) {
          await sleep(30000);
        } else {
          await sleep(RECORDER_CYCLE_PAUSE_MS);
        }
      } else {
        recorderState.lastError = null;
        recorderState.lastErrorCode = 'OUTSIDE_CAPTURE_WINDOW';
        await sleep(MARKET_CLOSED_POLL_MS);
      }
    } catch (error) {
      const parsed = parseDhanError(error);
      recorderState.lastError = parsed.message;
      recorderState.lastErrorCode = parsed.code;
      recorderState.totals.failed += 1;
      console.error('[OptionChainArchive] Cycle error:', parsed.message);
      await sleep(15000);
    }
  }
}

function startRecorder({ symbol, expiries, onlyCaptureWindows = true } = {}) {
  if (recorderState.running) {
    return { ...getRecorderStatus(), message: 'Recorder already running' };
  }
  recorderState.symbol = String(symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
  recorderState.expiries = (expiries && expiries.length ? expiries : DEFAULT_ARCHIVE_EXPIRIES)
    .map((e) => String(e).slice(0, 10));
  recorderState.onlyCaptureWindows = onlyCaptureWindows !== false;
  recorderState.running = true;
  recorderState.startedAt = new Date();
  recorderState.lastError = null;
  recorderState.loopTask = recorderLoop().catch((err) => {
    recorderState.lastError = err.message;
    console.error('[OptionChainArchive] Recorder loop crashed — restarting in 5s:', err.message);
    recorderState.running = false;
    setTimeout(() => ensureRecorderRunning(), 5000);
  });
  return getRecorderStatus();
}

function stopRecorder() {
  recorderState.running = false;
  return getRecorderStatus();
}

function getRecorderStatus() {
  const captureWindowOpen = isWithinCaptureWindow();
  return {
    running: recorderState.running,
    symbol: recorderState.symbol,
    expiries: recorderState.expiries,
    onlyCaptureWindows: recorderState.onlyCaptureWindows,
    captureWindowOpen,
    marketSessionOpen: captureWindowOpen,
    captureWindows: {
      open: '09:15–09:30 IST',
      close: '15:15–15:30 IST',
    },
    timeSlots: CAPTURE_TIME_SLOTS,
    startedAt: recorderState.startedAt,
    lastCycleAt: recorderState.lastCycleAt,
    lastError: recorderState.lastError,
    lastErrorCode: recorderState.lastErrorCode || (captureWindowOpen ? null : 'OUTSIDE_CAPTURE_WINDOW'),
    totals: { ...recorderState.totals },
    lastCaptureByExpiry: { ...recorderState.lastCaptureByExpiry },
  };
}

function ensureRecorderRunning() {
  if (!recorderState.running) {
    startRecorder({ onlyCaptureWindows: true });
    console.log('[OptionChainArchive] Recorder (re)started');
  }
}

async function getLatestSnapshot({ symbol, expiry, istTime, dateKey }) {
  if (istTime) {
    return findSnapshotAtSlot({ symbol, expiry, dateKey, istTime });
  }
  return findLatestInWindowSnapshot({ symbol, expiry, dateKey });
}

async function listSnapshots({ symbol, expiry, limit = 50, before, istTime, dateKey }) {
  const timeKey = istTime ? normalizeIstTimeQuery(istTime) : null;
  if (timeKey && dateKey) {
    const one = await findSnapshotAtSlot({ symbol, expiry, dateKey, istTime: timeKey });
    return one
      ? [
          {
            symbol: one.symbol,
            expiry: one.expiry,
            capturedAt: one.capturedAt,
            dateKey: one.dateKey,
            istTime: deriveIstTimeFromRow(one),
            spot: one.spot,
            strikeCount: one.strikeCount,
          },
        ]
      : [];
  }

  const q = {
    symbol: String(symbol).toUpperCase(),
    expiry: String(expiry).slice(0, 10),
    istTime: { $in: ALLOWED_IST_TIME_KEYS },
  };
  if (before) q.capturedAt = { $lt: new Date(before) };
  if (dateKey) q.dateKey = String(dateKey).slice(0, 10);

  const rows = await OptionChainSnapshot.find(q)
    .sort({ dateKey: -1, istTime: -1, capturedAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .select('symbol expiry capturedAt dateKey istTime spot strikeCount')
    .lean();
  return rows;
}

async function listAvailableTimes({ symbol, expiry, dateKey }) {
  const q = {
    symbol: String(symbol).toUpperCase(),
    expiry: String(expiry).slice(0, 10),
  };
  if (dateKey) q.dateKey = String(dateKey).slice(0, 10);

  const rows = await OptionChainSnapshot.find(q)
    .select('istTime dateKey capturedAt')
    .sort({ capturedAt: 1 })
    .lean();

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const timeKey = deriveIstTimeFromRow(row);
    if (!timeKey || seen.has(timeKey)) continue;
    seen.add(timeKey);
    out.push({
      istTime: timeKey,
      dateKey: row.dateKey || getIstClock(row.capturedAt).dateKey,
      capturedAt: row.capturedAt,
    });
  }
  return out;
}

async function getSnapshotById(id) {
  return OptionChainSnapshot.findById(id).lean();
}

async function getArchiveStats({ symbol }) {
  const sym = String(symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
  const agg = await OptionChainSnapshot.aggregate([
    { $match: { symbol: sym } },
    {
      $group: {
        _id: '$expiry',
        count: { $sum: 1 },
        firstAt: { $min: '$capturedAt' },
        lastAt: { $max: '$capturedAt' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return agg.map((r) => ({
    expiry: r._id,
    count: r.count,
    firstAt: r.firstAt,
    lastAt: r.lastAt,
  }));
}

async function scheduleAutoRecorder() {
  validateArchiveSetup();
  try {
    await ensureOptionChainIndexes();
    console.log('[OptionChainArchive] Mongo indexes synced (collection: optionchainsnapshots)');
    await purgeInvalidSnapshots();
  } catch (error) {
    const quota = /space quota|over your space/i.test(String(error.message));
    console.error(
      `[OptionChainArchive] Mongo setup skipped (${quota ? 'Atlas storage full' : error.message}).`,
      'Run: node scripts/freeMongoStorage.js — then restart.',
    );
    if (quota) return;
    throw error;
  }
  startRecorder({ onlyCaptureWindows: true });
  console.log(
    '[OptionChainArchive] Always-on recorder | NIFTY | capture 9:15–9:30 & 15:15–15:30 IST | Expiries:',
    recorderState.expiries.join(', '),
  );
  setInterval(() => ensureRecorderRunning(), 30000);
  setInterval(() => {
    purgeInvalidSnapshots().catch((err) => {
      console.error('[OptionChainArchive] Purge job failed:', err.message);
    });
  }, 60 * 60 * 1000);
}

function getArchivePageStatus({ symbol, expiry }) {
  const sym = String(symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
  const exp = String(expiry || DEFAULT_ARCHIVE_EXPIRIES[0]).slice(0, 10);
  const recorder = getRecorderStatus();
  const last = recorder.lastCaptureByExpiry[exp];
  return {
    symbol: sym,
    expiry: exp,
    viewFilterOnly: true,
    recordingExpiries: [...recorder.expiries],
    captureWindowOpen: recorder.captureWindowOpen,
    marketSessionOpen: recorder.captureWindowOpen,
    captureWindows: recorder.captureWindows,
    recorderRunning: recorder.running,
    lastError: recorder.lastError,
    lastErrorCode: recorder.lastErrorCode,
    lastCaptureAt: last?.at || null,
    lastCaptureByExpiry: { ...recorder.lastCaptureByExpiry },
    totals: recorder.totals,
  };
}

module.exports = {
  flattenOptionChain,
  unwrapDhanChainPayload,
  captureAllExpiries,
  captureExpiryChain,
  fetchOptionChainWithRetry,
  startRecorder,
  stopRecorder,
  getRecorderStatus,
  getLatestSnapshot,
  listSnapshots,
  listAvailableTimes,
  getSnapshotById,
  getArchiveStats,
  isWithinCaptureWindow,
  isWithinNseCashSession,
  purgeInvalidSnapshots,
  normalizeIstTimeQuery,
  findSnapshotAtSlot,
  scheduleAutoRecorder,
  ensureRecorderRunning,
  getArchivePageStatus,
  parseDhanError,
  validateArchiveSetup,
  DEFAULT_ARCHIVE_EXPIRIES,
  CAPTURE_TIME_SLOTS,
  ALLOWED_IST_TIME_KEYS,
};

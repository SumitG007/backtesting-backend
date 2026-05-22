const OptionChainSnapshot = require('../models/optionChainSnapshot');
const { ensureOptionChainIndexes } = require('../models/optionChainSnapshot');
const { fetchOptionChain } = require('./dhanLiveService');
const { resolveSymbolConfig } = require('../utils/market');
const { getIstClock, isWeekendDateKey, sleep } = require('../utils/dateTime');
const { isNseCashTradingDay } = require('./nseHolidayService');
const {
  DEFAULT_ARCHIVE_EXPIRIES,
  DEFAULT_ARCHIVE_SYMBOL,
  EXPIRY_FETCH_GAP_MS,
  RECORDER_CYCLE_PAUSE_MS,
  FETCH_MAX_ATTEMPTS,
  FETCH_RETRY_DELAYS_MS,
  DB_SAVE_MAX_ATTEMPTS,
  MARKET_OPEN_MINUTES,
  MARKET_CLOSE_MINUTES,
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

function isWithinNseCashSession() {
  const now = new Date();
  const clock = getIstClock(now.toISOString());
  if (!isNseCashTradingDay(clock.dateKey)) return false;
  return clock.minutes >= MARKET_OPEN_MINUTES && clock.minutes <= MARKET_CLOSE_MINUTES;
}

const recorderState = {
  running: false,
  symbol: DEFAULT_ARCHIVE_SYMBOL,
  expiries: [...DEFAULT_ARCHIVE_EXPIRIES],
  onlyMarketHours: true,
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
  const flat = flattenOptionChain(chainData);

  if (flat.strikes.length === 0) {
    throw new Error('Cannot save snapshot: zero strikes after normalize');
  }

  const docPayload = {
    symbol: String(symbol).toUpperCase(),
    expiry: String(expiry).slice(0, 10),
    capturedAt,
    dateKey: clock.dateKey,
    spot: flat.spot,
    strikeCount: flat.strikes.length,
    strikes: flat.strikes,
    rawOc: flat.rawOc,
    source: 'dhan-optionchain',
    recorderRunId: recorderRunId || null,
  };

  let lastDbError = null;
  for (let attempt = 0; attempt < DB_SAVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 0) await sleep(1000 * attempt);
      return await OptionChainSnapshot.create(docPayload);
    } catch (error) {
      lastDbError = error;
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

async function recorderLoop() {
  console.log('[OptionChainArchive] Recorder loop active (24/7; fetch 9:15–15:30 IST on trading days)');
  while (recorderState.running) {
    const marketOpen = isWithinNseCashSession();
    try {
      if (marketOpen && !recorderState.marketWasOpen) {
        console.log('[OptionChainArchive] Market open — fetching both expiries');
      }
      recorderState.marketWasOpen = marketOpen;

      if (!recorderState.onlyMarketHours || marketOpen) {
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
        recorderState.lastErrorCode = 'MARKET_CLOSED';
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

function startRecorder({ symbol, expiries, onlyMarketHours = true } = {}) {
  if (recorderState.running) {
    return { ...getRecorderStatus(), message: 'Recorder already running' };
  }
  recorderState.symbol = String(symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
  recorderState.expiries = (expiries && expiries.length ? expiries : DEFAULT_ARCHIVE_EXPIRIES)
    .map((e) => String(e).slice(0, 10));
  recorderState.onlyMarketHours = onlyMarketHours !== false;
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
  const marketSessionOpen = isWithinNseCashSession();
  return {
    running: recorderState.running,
    symbol: recorderState.symbol,
    expiries: recorderState.expiries,
    onlyMarketHours: recorderState.onlyMarketHours,
    marketSessionOpen,
    startedAt: recorderState.startedAt,
    lastCycleAt: recorderState.lastCycleAt,
    lastError: recorderState.lastError,
    lastErrorCode: recorderState.lastErrorCode || (marketSessionOpen ? null : 'MARKET_CLOSED'),
    totals: { ...recorderState.totals },
    lastCaptureByExpiry: { ...recorderState.lastCaptureByExpiry },
  };
}

function ensureRecorderRunning() {
  if (!recorderState.running) {
    startRecorder({ onlyMarketHours: true });
    console.log('[OptionChainArchive] Recorder (re)started');
  }
}

async function getLatestSnapshot({ symbol, expiry }) {
  return OptionChainSnapshot.findOne({
    symbol: String(symbol).toUpperCase(),
    expiry: String(expiry).slice(0, 10),
  })
    .sort({ capturedAt: -1 })
    .lean();
}

async function listSnapshots({ symbol, expiry, limit = 50, before }) {
  const q = {
    symbol: String(symbol).toUpperCase(),
    expiry: String(expiry).slice(0, 10),
  };
  if (before) {
    q.capturedAt = { $lt: new Date(before) };
  }
  const rows = await OptionChainSnapshot.find(q)
    .sort({ capturedAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .select('symbol expiry capturedAt dateKey spot strikeCount')
    .lean();
  return rows;
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
  await ensureOptionChainIndexes();
  console.log('[OptionChainArchive] Mongo indexes synced (collection: optionchainsnapshots)');
  startRecorder({ onlyMarketHours: true });
  console.log(
    '[OptionChainArchive] Always-on recorder | NIFTY | Dhan UnderlyingScrip=13 IDX_I | Expiries:',
    recorderState.expiries.join(', '),
  );
  setInterval(() => ensureRecorderRunning(), 30000);
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
    marketSessionOpen: recorder.marketSessionOpen,
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
  getSnapshotById,
  getArchiveStats,
  isWithinNseCashSession,
  scheduleAutoRecorder,
  ensureRecorderRunning,
  getArchivePageStatus,
  parseDhanError,
  validateArchiveSetup,
  DEFAULT_ARCHIVE_EXPIRIES,
};

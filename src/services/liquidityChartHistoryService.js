/**
 * Liquidity OI Chase — chart history only (strategy paused).
 * Keeps current IST day + previous 6 NSE trading days of NIFTY 5m candles in Mongo.
 * Serve always from Mongo; refresh today (and missing past days) from Dhan in the background.
 */
const ChartCandleDay = require('../models/chartCandleDay');
const { fetchTradingDayCandles } = require('./dhanDataService');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
} = require('./nseHolidayService');
const {
  getIstClock,
  parseDateOnly,
  formatDateOnly,
  addDays,
  sleep,
} = require('../utils/dateTime');

const SYMBOL = 'NIFTY';
const INTERVAL = '5';
const KEEP_TRADING_DAYS = 7;
const TODAY_REFRESH_MS = 8_000;
const LOOP_MS = 15_000;

let loopTimer = null;
let syncBusy = false;
let lastError = null;
let lastSyncAt = null;
let lastDays = [];

/** Walk back from anchor dateKey and collect `count` NSE cash trading days (newest first). */
function listRecentTradingDays(anchorDateKey, count = KEEP_TRADING_DAYS) {
  const out = [];
  let cursor = parseDateOnly(anchorDateKey);
  if (Number.isNaN(cursor.getTime())) return out;
  for (let i = 0; i < 40 && out.length < count; i += 1) {
    const key = formatDateOnly(cursor);
    if (isNseCashTradingDay(key)) out.push(key);
    cursor = addDays(cursor, -1);
  }
  return out;
}

function normalizeCandleRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const iso = row[0];
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]) || 0;
    if (!iso || ![open, high, low, close].every(Number.isFinite)) continue;
    out.push([String(iso), open, high, low, close, volume]);
  }
  return out;
}

async function saveDay(dateKey, rows, source = 'dhan') {
  const candles = normalizeCandleRows(rows);
  await ChartCandleDay.findOneAndUpdate(
    { symbol: SYMBOL, interval: INTERVAL, dateKey },
    {
      $set: {
        symbol: SYMBOL,
        interval: INTERVAL,
        dateKey,
        candles,
        barCount: candles.length,
        source,
        fetchedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return { dateKey, barCount: candles.length, source };
}

async function upsertDayCandles(dateKey, { force = false } = {}) {
  const existing = await ChartCandleDay.findOne({
    symbol: SYMBOL,
    interval: INTERVAL,
    dateKey,
  })
    .select({ barCount: 1, fetchedAt: 1 })
    .lean();

  const clock = getIstClock(new Date());
  const isToday = dateKey === clock.dateKey;
  if (!force && !isToday && existing?.barCount > 0) {
    return { dateKey, barCount: existing.barCount, fromCache: true };
  }

  const payload = await fetchTradingDayCandles({
    symbol: SYMBOL,
    interval: INTERVAL,
    dateKey,
  });
  const saved = await saveDay(dateKey, payload?.rows, 'dhan');
  console.log(`[LIQ CHART] saved ${dateKey} → ${saved.barCount} bars`);
  return { ...saved, fromCache: false };
}

async function pruneOlderThan(keepDateKeys) {
  const keep = new Set(keepDateKeys);
  await ChartCandleDay.deleteMany({
    symbol: SYMBOL,
    interval: INTERVAL,
    dateKey: { $nin: [...keep] },
  });
}

/**
 * Ensure Mongo has the rolling 7 trading days; refresh today from Dhan.
 */
async function syncWeekHistory({ forcePast = false } = {}) {
  await ensureNseHolidaysLoaded();
  const clock = getIstClock(new Date());
  const days = listRecentTradingDays(clock.dateKey, KEEP_TRADING_DAYS);
  lastDays = days;
  let candleCount = 0;
  const errors = [];

  for (const dateKey of [...days].reverse()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await upsertDayCandles(dateKey, {
        force: Boolean(forcePast) && dateKey !== clock.dateKey,
      });
      candleCount += Number(r.barCount) || 0;
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
    } catch (err) {
      errors.push(`${dateKey}: ${err.message}`);
      console.warn('[LIQ CHART] day sync failed', dateKey, err.message);
      // Keep whatever is already in Mongo for that day.
      // eslint-disable-next-line no-await-in-loop
      const existing = await ChartCandleDay.findOne({
        symbol: SYMBOL,
        interval: INTERVAL,
        dateKey,
      })
        .select({ barCount: 1 })
        .lean();
      candleCount += Number(existing?.barCount) || 0;
    }
  }

  await pruneOlderThan(days);
  lastSyncAt = new Date();
  lastError = errors.length ? errors.join(' · ') : null;
  console.log(
    `[LIQ CHART] week sync done — days=${days.join(',')} bars≈${candleCount}${lastError ? ` err=${lastError}` : ''}`,
  );
  return { days, candleCount, errors };
}

/** Read merged candles from Mongo only (never blocks on Dhan). */
async function readWeekFromMongo(days) {
  const docs = await ChartCandleDay.find({
    symbol: SYMBOL,
    interval: INTERVAL,
    dateKey: { $in: days },
  })
    .sort({ dateKey: 1 })
    .lean();

  const byDay = new Map(docs.map((d) => [d.dateKey, d]));
  const candles = [];
  const dayMeta = [];
  for (const dateKey of [...days].sort()) {
    const doc = byDay.get(dateKey);
    const rows = normalizeCandleRows(doc?.candles);
    dayMeta.push({
      dateKey,
      barCount: rows.length,
      fetchedAt: doc?.fetchedAt || null,
      source: doc?.source || null,
    });
    for (const row of rows) candles.push(row);
  }
  return { candles, dayMeta };
}

/**
 * API payload: serve Mongo immediately; kick a soft today-refresh if stale.
 */
async function getWeekChartPayload() {
  await ensureNseHolidaysLoaded();
  const clock = getIstClock(new Date());
  let days = listRecentTradingDays(clock.dateKey, KEEP_TRADING_DAYS);
  lastDays = days;

  let { candles, dayMeta } = await readWeekFromMongo(days);
  const missing = dayMeta.filter((d) => !(d.barCount > 0)).map((d) => d.dateKey);

  // Fill gaps / first boot — await once so the chart is not blank.
  if (missing.length || candles.length === 0) {
    await syncWeekHistory();
    days = lastDays.length ? lastDays : days;
    ({ candles, dayMeta } = await readWeekFromMongo(days));
  } else {
    // Today live: refresh in background if stale (do not block response).
    const todayKey = isNseCashTradingDay(clock.dateKey) ? clock.dateKey : null;
    if (todayKey) {
      const todayMeta = dayMeta.find((d) => d.dateKey === todayKey);
      const age = todayMeta?.fetchedAt
        ? Date.now() - new Date(todayMeta.fetchedAt).getTime()
        : Infinity;
      if (age > TODAY_REFRESH_MS) {
        upsertDayCandles(todayKey).catch((err) => {
          lastError = err.message;
          console.warn('[LIQ CHART] today refresh failed', err.message);
        });
      }
    }
  }

  return {
    ok: true,
    symbol: SYMBOL,
    interval: INTERVAL,
    keepTradingDays: KEEP_TRADING_DAYS,
    days: [...days].sort(),
    dayMeta,
    candles,
    barCount: candles.length,
    dateKey: clock.dateKey,
    lastSyncAt,
    lastError,
    note: 'Strategy paused — chart history only (today + prior 6 trading days).',
  };
}

async function syncOnceSafe({ forcePast = false } = {}) {
  if (syncBusy) return { skipped: true };
  syncBusy = true;
  try {
    const result = await syncWeekHistory({ forcePast });
    return { ok: true, ...result };
  } catch (err) {
    lastError = err.message;
    console.warn('[LIQ CHART] sync failed', err.message);
    return { ok: false, error: err.message };
  } finally {
    syncBusy = false;
  }
}

function getStatus() {
  return {
    running: Boolean(loopTimer),
    symbol: SYMBOL,
    interval: INTERVAL,
    keepTradingDays: KEEP_TRADING_DAYS,
    days: lastDays,
    lastSyncAt,
    lastError,
  };
}

function startHistoryLoop() {
  if (loopTimer) return getStatus();
  // First sync fills any missing of the 7 trading days into Mongo.
  syncOnceSafe({ forcePast: false }).catch(() => {});
  loopTimer = setInterval(() => {
    syncOnceSafe({ forcePast: false }).catch(() => {});
  }, LOOP_MS);
  console.log(
    `[LIQ CHART] history loop started — ${SYMBOL} ${INTERVAL}m × ${KEEP_TRADING_DAYS} trading days → Mongo`,
  );
  return getStatus();
}

function stopHistoryLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  return getStatus();
}

module.exports = {
  KEEP_TRADING_DAYS,
  listRecentTradingDays,
  syncWeekHistory,
  getWeekChartPayload,
  syncOnceSafe,
  startHistoryLoop,
  stopHistoryLoop,
  getStatus,
};

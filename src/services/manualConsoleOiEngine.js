/**
 * Manual Console OI tape — own collection + calc + API surface.
 * Mirrored from OI Flow minute captures today; can diverge later without
 * changing OI Flow Tracker (/api/oi-flow/* · OiFlowMinuteRow).
 *
 * Weekend: keep Friday tape through Sat/Sun; purge on Monday with other days.
 */
const ManualConsoleOiMinuteRow = require('../models/manualConsoleOiMinuteRow');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { getIstClock, isWeekendDateKey, oiTapeDateKey, oiTapeRetainDateKeys } = require('../utils/dateTime');
const { isNseCashTradingDay } = require('./nseHolidayService');
const { buildManualConsoleOiBars } = require('../utils/manualConsoleOiCalc');

const SYMBOL = 'NIFTY';
const SESSION_FROM = 9 * 60 + 15;
const SESSION_TO = 15 * 60 + 30;
const LIST_CACHE_MS = 2500;

const cache = {
  atMs: 0,
  key: '',
  payload: null,
};

function formatHhmm(minutes) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function stripForStore(row = {}) {
  return {
    symbol: row.symbol || SYMBOL,
    dateKey: row.dateKey,
    minutes: row.minutes,
    time: row.time,
    spotPrice: row.spotPrice ?? null,
    atm: row.atm ?? null,
    lookaroundStrikes: row.lookaroundStrikes ?? 3,
    callOiTotal: row.callOiTotal ?? null,
    putOiTotal: row.putOiTotal ?? null,
    dayCallChgOi: row.dayCallChgOi ?? null,
    dayPutChgOi: row.dayPutChgOi ?? null,
    callsChgOi: row.callsChgOi ?? null,
    putsChgOi: row.putsChgOi ?? null,
    strikes: Array.isArray(row.strikes) ? row.strikes : undefined,
    diffInOi: row.diffInOi ?? null,
    dirOfChng: row.dirOfChng ?? null,
    chngInDir: row.chngInDir ?? null,
    sentiment: row.sentiment ?? null,
    expiry: row.expiry ?? null,
    fetchOk: row.fetchOk !== false,
    error: row.error ?? null,
    fetchedAt: row.fetchedAt || new Date(),
    source: row.source || 'oi_flow_mirror',
  };
}

async function mirrorRow(row) {
  if (!row?.dateKey || !Number.isFinite(Number(row.minutes))) return null;
  const doc = stripForStore(row);
  const saved = await ManualConsoleOiMinuteRow.findOneAndUpdate(
    { symbol: doc.symbol, dateKey: doc.dateKey, minutes: doc.minutes },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  cache.atMs = 0;
  cache.payload = null;
  return saved;
}

async function purgeOtherDays(todayKey) {
  const keep = oiTapeRetainDateKeys(todayKey);
  if (!keep.length) return 0;
  // Weekend: keep Friday. Monday+: wipe Friday with other old days.
  const result = await ManualConsoleOiMinuteRow.deleteMany({
    dateKey: { $nin: keep },
  });
  return result?.deletedCount || 0;
}

/** One-time / catch-up seed from OI Flow Tracker collection for the tape day. */
async function seedFromOiFlowIfNeeded(dateKey, symbol = SYMBOL) {
  const mcCount = await ManualConsoleOiMinuteRow.countDocuments({ symbol, dateKey });
  const trackerCount = await OiFlowMinuteRow.countDocuments({ symbol, dateKey });
  if (trackerCount === 0 || mcCount >= trackerCount) return { seeded: 0, mcCount, trackerCount };

  const trackerRows = await OiFlowMinuteRow.find({ symbol, dateKey }).lean();
  let seeded = 0;
  for (const row of trackerRows) {
    await mirrorRow({ ...row, source: 'oi_flow_seed' });
    seeded += 1;
  }
  return { seeded, mcCount: mcCount + seeded, trackerCount };
}

async function listToday({ intervalMin = 5 } = {}) {
  const step = Math.max(1, Math.min(60, Math.floor(Number(intervalMin) || 5)));
  const clock = getIstClock(new Date());
  const tapeDateKey = oiTapeDateKey(clock.dateKey);
  const weekendHold = isWeekendDateKey(clock.dateKey) && tapeDateKey !== clock.dateKey;
  const cacheKey = `${clock.dateKey}:${tapeDateKey}:${step}`;
  const now = Date.now();
  if (cache.payload && cache.key === cacheKey && now - cache.atMs < LIST_CACHE_MS) {
    return cache.payload;
  }

  await purgeOtherDays(clock.dateKey);
  await seedFromOiFlowIfNeeded(tapeDateKey, SYMBOL);

  const rows = await ManualConsoleOiMinuteRow.find({
    symbol: SYMBOL,
    dateKey: tapeDateKey,
  })
    .sort({ minutes: 1 })
    .lean();

  const isTradingDay = !isWeekendDateKey(clock.dateKey) && isNseCashTradingDay(clock.dateKey);
  const inSession =
    isTradingDay && clock.minutes >= SESSION_FROM && clock.minutes <= SESSION_TO;
  const lastOk = [...rows].reverse().find((r) => r.fetchOk) || rows[rows.length - 1] || null;

  let displayRow = lastOk;
  if (!inSession && displayRow) {
    displayRow = {
      ...displayRow,
      time: formatHhmm(SESSION_TO),
      minutes: SESSION_TO,
      afterClose: true,
      isLastEntry: true,
    };
  }

  const candleRows = buildManualConsoleOiBars(rows, step, {
    displayRow,
    inSession,
  });

  const payload = {
    ok: true,
    desk: 'manual_console',
    collection: 'manual_console_oi_minute_rows',
    symbol: SYMBOL,
    dateKey: tapeDateKey,
    calendarDateKey: clock.dateKey,
    weekendHold,
    nowTime: formatHhmm(clock.minutes),
    intervalMin: step,
    inSession,
    isTradingDay,
    rowCount: rows.length,
    expectedRows: SESSION_TO - SESSION_FROM + 1,
    lastTime: lastOk?.time || null,
    lastMinutes: lastOk?.minutes ?? null,
    displayRow: displayRow
      ? {
          time: displayRow.time,
          minutes: displayRow.minutes,
          spotPrice: displayRow.spotPrice,
        }
      : null,
    rows: candleRows,
  };

  cache.key = cacheKey;
  cache.atMs = now;
  cache.payload = payload;
  return payload;
}

module.exports = {
  SYMBOL,
  SESSION_FROM,
  SESSION_TO,
  mirrorRow,
  purgeOtherDays,
  seedFromOiFlowIfNeeded,
  listToday,
};

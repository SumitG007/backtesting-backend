/**
 * Day-end OI Flow JSON archive — save after session (≈15:30) and before minute purge.
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const OiFlowDayArchive = require('../models/oiFlowDayArchive');
const { build5mBars } = require('../utils/oiFlow5mPatterns');
const { getIstClock } = require('../utils/dateTime');

const SYMBOL = 'NIFTY';
const INTERVAL_MIN = 1;

const inFlight = new Set();

function archiveKey(dateKey, symbol = SYMBOL) {
  return `${symbol}:${dateKey}:${INTERVAL_MIN}`;
}

/**
 * Build + upsert archive for a dateKey from live minute rows (no strikes).
 * Idempotent — safe to call many times.
 */
async function archiveDay(dateKey, { symbol = SYMBOL, force = false } = {}) {
  const dk = String(dateKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) {
    return { ok: false, skipped: true, reason: 'bad_date' };
  }

  const key = archiveKey(dk, symbol);
  if (inFlight.has(key)) {
    return { ok: true, skipped: true, reason: 'in_flight', dateKey: dk };
  }

  inFlight.add(key);
  try {
    if (!force) {
      const existing = await OiFlowDayArchive.findOne({
        symbol,
        dateKey: dk,
        intervalMin: INTERVAL_MIN,
      })
        .select('dateKey rowCount archivedAt')
        .lean();
      if (existing && Number(existing.rowCount) > 0) {
        return {
          ok: true,
          skipped: true,
          reason: 'already',
          dateKey: dk,
          rowCount: existing.rowCount,
          archivedAt: existing.archivedAt,
        };
      }
    }

    const sourceRows = await OiFlowMinuteRow.find({
      symbol,
      dateKey: dk,
      fetchOk: true,
    })
      .sort({ minutes: 1 })
      .select('-strikes -createdAt -updatedAt -__v')
      .lean();

    if (!sourceRows.length) {
      return { ok: false, skipped: true, reason: 'no_rows', dateKey: dk };
    }

    const barsAsc = build5mBars(sourceRows, INTERVAL_MIN);
    const rows = [...barsAsc].reverse();
    const payload = {
      ok: true,
      dateKey: dk,
      symbol,
      intervalMin: INTERVAL_MIN,
      archivedAt: new Date().toISOString(),
      sourceMinuteCount: sourceRows.length,
      rowCount: rows.length,
      rows,
    };
    const json = JSON.stringify(payload);
    const byteSize = Buffer.byteLength(json, 'utf8');

    const doc = await OiFlowDayArchive.findOneAndUpdate(
      { symbol, dateKey: dk, intervalMin: INTERVAL_MIN },
      {
        $set: {
          symbol,
          dateKey: dk,
          intervalMin: INTERVAL_MIN,
          rowCount: rows.length,
          sourceMinuteCount: sourceRows.length,
          byteSize,
          archivedAt: new Date(),
          payload,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    return {
      ok: true,
      dateKey: dk,
      rowCount: doc.rowCount,
      sourceMinuteCount: doc.sourceMinuteCount,
      byteSize: doc.byteSize,
      archivedAt: doc.archivedAt,
    };
  } finally {
    inFlight.delete(key);
  }
}

/** After 15:30 — archive today if minute tape exists and archive missing. */
async function maybeArchiveAfterClose(dateKey, { symbol = SYMBOL } = {}) {
  const clock = getIstClock(new Date());
  const dk = dateKey || clock.dateKey;
  // Only after session end (15:30+)
  if (clock.dateKey === dk && clock.minutes <= 15 * 60 + 30) {
    return { ok: true, skipped: true, reason: 'still_in_session' };
  }
  return archiveDay(dk, { symbol });
}

/** Archive any dateKeys about to be purged from live minute collection. */
async function archiveBeforePurge(dateKeys, { symbol = SYMBOL } = {}) {
  const keys = [...new Set((dateKeys || []).map((d) => String(d).slice(0, 10)))].filter((d) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d),
  );
  const results = [];
  for (const dk of keys) {
    results.push(await archiveDay(dk, { symbol }));
  }
  return results;
}

async function listArchivedMonth({ year, month, symbol = SYMBOL } = {}) {
  const y = Math.floor(Number(year));
  const m = Math.floor(Number(month));
  if (!Number.isFinite(y) || y < 2020 || y > 2100 || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error('Invalid year/month');
  }
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  const rows = await OiFlowDayArchive.find({
    symbol,
    intervalMin: INTERVAL_MIN,
    dateKey: { $regex: `^${prefix}-` },
  })
    .select('dateKey rowCount sourceMinuteCount byteSize archivedAt')
    .sort({ dateKey: 1 })
    .lean();

  return {
    symbol,
    year: y,
    month: m,
    dates: rows.map((r) => ({
      dateKey: r.dateKey,
      rowCount: r.rowCount,
      sourceMinuteCount: r.sourceMinuteCount,
      byteSize: r.byteSize,
      archivedAt: r.archivedAt,
    })),
  };
}

async function getArchivePayload(dateKey, { symbol = SYMBOL } = {}) {
  const dk = String(dateKey || '').slice(0, 10);
  const doc = await OiFlowDayArchive.findOne({
    symbol,
    dateKey: dk,
    intervalMin: INTERVAL_MIN,
  }).lean();
  if (!doc?.payload) return null;
  return {
    dateKey: dk,
    filename: `oi-flow-candles-${dk}-1m.json`,
    payload: doc.payload,
    byteSize: doc.byteSize,
    archivedAt: doc.archivedAt,
  };
}

module.exports = {
  INTERVAL_MIN,
  archiveDay,
  maybeArchiveAfterClose,
  archiveBeforePurge,
  listArchivedMonth,
  getArchivePayload,
};

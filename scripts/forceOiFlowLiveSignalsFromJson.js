/**
 * Force-backfill OI Flow live signals for a date from saved minute JSON
 * (when DB minute rows were wiped). Uses ROBUST B live gates.
 *
 * Usage:
 *   node scripts/forceOiFlowLiveSignalsFromJson.js
 *   node scripts/forceOiFlowLiveSignalsFromJson.js 2026-08-12
 *   node scripts/forceOiFlowLiveSignalsFromJson.js data/oi-flow-2026-08-12.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const OiFlowMinuteRow = require('../src/models/oiFlowMinuteRow');
const {
  forceBackfillLiveSignalsFromMinutes,
} = require('../src/services/oiFlowLiveSignalStore');
const { getIstClock } = require('../src/utils/dateTime');

function parseHhmm(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function normalizeRow(r, dateKey) {
  const minutes = Number.isFinite(Number(r.minutes))
    ? Number(r.minutes)
    : parseHhmm(r.time);
  return {
    symbol: r.symbol || 'NIFTY',
    dateKey: r.dateKey || dateKey,
    minutes,
    time: r.time || (Number.isFinite(minutes)
      ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
      : null),
    spotPrice: Number(r.spotPrice ?? r.spot),
    atm: Number.isFinite(Number(r.atm)) ? Number(r.atm) : null,
    callOiTotal: Number.isFinite(Number(r.callOiTotal)) ? Number(r.callOiTotal) : null,
    putOiTotal: Number.isFinite(Number(r.putOiTotal)) ? Number(r.putOiTotal) : null,
    dayCallChgOi: Number.isFinite(Number(r.dayCallChgOi)) ? Number(r.dayCallChgOi) : null,
    dayPutChgOi: Number.isFinite(Number(r.dayPutChgOi)) ? Number(r.dayPutChgOi) : null,
    callsChgOi: Number.isFinite(Number(r.callsChgOi)) ? Number(r.callsChgOi) : null,
    putsChgOi: Number.isFinite(Number(r.putsChgOi)) ? Number(r.putsChgOi) : null,
    diffInOi: Number.isFinite(Number(r.diffInOi)) ? Number(r.diffInOi) : null,
    chngInDir: Number.isFinite(Number(r.chngInDir)) ? Number(r.chngInDir) : null,
    dirOfChng: r.dirOfChng || null,
    sentiment: r.sentiment || null,
    fetchOk: r.fetchOk !== false,
  };
}

function loadRows(filePath, dateKey) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.rows)
      ? raw.rows
      : Array.isArray(raw.data)
        ? raw.data
        : null;
  if (!list) throw new Error(`No rows array in ${filePath}`);
  return list
    .map((r) => normalizeRow(r, dateKey))
    .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.spotPrice))
    .sort((a, b) => a.minutes - b.minutes);
}

async function main() {
  const arg = String(process.argv[2] || '').trim();
  let dateKey = '2026-08-12';
  let filePath = path.join(__dirname, '..', 'data', 'oi-flow-2026-08-12.json');

  if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    dateKey = arg;
    filePath = path.join(__dirname, '..', 'data', `oi-flow-${dateKey}.json`);
  } else if (arg) {
    filePath = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
    const base = path.basename(filePath);
    const m = /oi-flow-(\d{4}-\d{2}-\d{2})\.json/.exec(base);
    if (m) dateKey = m[1];
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI missing');
  }

  const rows = loadRows(filePath, dateKey);
  console.log(`Loaded ${rows.length} rows from ${filePath} → dateKey=${dateKey}`);

  await mongoose.connect(process.env.MONGODB_URI);

  const todayKey = getIstClock(new Date()).dateKey;
  const isToday = dateKey === todayKey;

  // Stage historical minutes only when this is NOT the live trading day.
  // Never wipe today's live minute recorder data.
  if (!isToday) {
    await OiFlowMinuteRow.deleteMany({ symbol: 'NIFTY', dateKey });
    if (rows.length) {
      await OiFlowMinuteRow.insertMany(rows, { ordered: false });
    }
    console.log(`Staged ${rows.length} minute rows for ${dateKey}`);
  } else {
    const liveCount = await OiFlowMinuteRow.countDocuments({ symbol: 'NIFTY', dateKey });
    console.log(`Today ${dateKey}: using live DB minute rows (${liveCount}) — JSON not staged`);
    if (liveCount < 2 && rows.length >= 2) {
      await OiFlowMinuteRow.insertMany(rows, { ordered: false });
      console.log(`Restored ${rows.length} rows from JSON into live DB (was empty)`);
    }
  }

  const result = await forceBackfillLiveSignalsFromMinutes(dateKey);
  console.log(JSON.stringify(result, null, 2));

  if (!isToday) {
    await OiFlowMinuteRow.deleteMany({ symbol: 'NIFTY', dateKey });
    console.log(`Cleaned staged minute rows for ${dateKey} (signals kept in OiFlowLiveSignal)`);
  }

  await mongoose.disconnect();
  if (!result.ok) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

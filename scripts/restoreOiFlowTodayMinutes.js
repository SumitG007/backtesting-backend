/**
 * Restore today's OI flow minute rows from local JSON dump if DB was wiped.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const OiFlowMinuteRow = require('../src/models/oiFlowMinuteRow');
const {
  forceBackfillLiveSignalsFromMinutes,
} = require('../src/services/oiFlowLiveSignalStore');

const DATE = '2026-08-13';
const FILE = path.join(__dirname, '..', 'data', `oi-flow-${DATE}.json`);

function parseHhmm(time) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const existing = await OiFlowMinuteRow.countDocuments({ dateKey: DATE });
  console.log(`Existing minute rows for ${DATE}: ${existing}`);
  if (existing >= 2) {
    console.log('Skip restore — rows already present');
  } else {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.rows || [];
    const rows = list
      .map((r) => ({
        symbol: 'NIFTY',
        dateKey: DATE,
        minutes: Number.isFinite(Number(r.minutes)) ? Number(r.minutes) : parseHhmm(r.time),
        time: r.time,
        spotPrice: Number(r.spotPrice ?? r.spot),
        atm: Number.isFinite(Number(r.atm)) ? Number(r.atm) : null,
        dayCallChgOi: Number(r.dayCallChgOi),
        dayPutChgOi: Number(r.dayPutChgOi),
        callsChgOi: Number(r.callsChgOi),
        putsChgOi: Number(r.putsChgOi),
        diffInOi: Number(r.diffInOi),
        chngInDir: Number(r.chngInDir),
        dirOfChng: r.dirOfChng || null,
        sentiment: r.sentiment || null,
        fetchOk: true,
      }))
      .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.spotPrice));
    if (!rows.length) throw new Error('No rows in JSON');
    await OiFlowMinuteRow.insertMany(rows, { ordered: false });
    console.log(`Restored ${rows.length} minute rows for ${DATE}`);
  }
  const result = await forceBackfillLiveSignalsFromMinutes(DATE);
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

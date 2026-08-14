/**
 * Dump OI Flow minute rows for one IST date to data/oi-flow-YYYY-MM-DD.json
 * Same tape shape as 12/13 dumps (no future, one row per minute).
 *
 * Usage: node scripts/exportOiFlowDayJson.js
 *        node scripts/exportOiFlowDayJson.js 2026-08-14
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const OiFlowMinuteRow = require('../src/models/oiFlowMinuteRow');
const { getIstClock } = require('../src/utils/dateTime');

function dirOfChng(v) {
  if (!Number.isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

function sentimentFrom(v) {
  if (!Number.isFinite(v) || v === 0) return 'Neutral';
  return v > 0 ? 'Bull' : 'Bear';
}

async function main() {
  const arg = String(process.argv[2] || '').trim();
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : getIstClock(new Date()).dateKey;

  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
  await mongoose.connect(process.env.MONGODB_URI);

  const raw = await OiFlowMinuteRow.find({ symbol: 'NIFTY', dateKey })
    .sort({ minutes: 1 })
    .lean();

  const rows = raw
    .filter((r) => Number.isFinite(Number(r.minutes)))
    .map((r, idx) => {
      const callsChgOi = Number(r.callsChgOi);
      const putsChgOi = Number(r.putsChgOi);
      const chngInDir = Number.isFinite(Number(r.chngInDir))
        ? Number(r.chngInDir)
        : Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
          ? putsChgOi - callsChgOi
          : 0;
      const diffInOi = Number.isFinite(Number(r.diffInOi))
        ? Number(r.diffInOi)
        : Number(r.dayPutChgOi) - Number(r.dayCallChgOi);
      return {
        sr: idx + 1,
        time: r.time,
        minutes: Number(r.minutes),
        spot: Number(r.spotPrice ?? r.spot),
        dayCallChgOi: Number(r.dayCallChgOi) || 0,
        dayPutChgOi: Number(r.dayPutChgOi) || 0,
        callsChgOi: Number.isFinite(callsChgOi) ? callsChgOi : 0,
        putsChgOi: Number.isFinite(putsChgOi) ? putsChgOi : 0,
        diffInOi: Number.isFinite(diffInOi) ? diffInOi : 0,
        chngInDir: Number.isFinite(chngInDir) ? chngInDir : 0,
        dirOfChng: r.dirOfChng || dirOfChng(chngInDir),
        sentiment: r.sentiment || sentimentFrom(chngInDir),
      };
    });

  const out = path.join(__dirname, '..', 'data', `oi-flow-${dateKey}.json`);
  fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
  console.log(`Wrote ${rows.length} rows → ${out}`);
  if (rows.length) {
    console.log(`Range ${rows[0].time} → ${rows[rows.length - 1].time}`);
  }
  await mongoose.disconnect();
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

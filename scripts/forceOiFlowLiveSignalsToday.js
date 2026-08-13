/**
 * Force-save today's OI Flow signals into DB as if live engine ran
 * (ROBUST B: 1 open · TP+10 / SL−8 / 15m · cooldown 30m · re-arm after WAIT).
 *
 * Usage: node scripts/forceOiFlowLiveSignalsToday.js
 * Optional: node scripts/forceOiFlowLiveSignalsToday.js 2026-08-13
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { getIstClock } = require('../src/utils/dateTime');
const {
  forceBackfillLiveSignalsFromMinutes,
} = require('../src/services/oiFlowLiveSignalStore');

async function main() {
  const arg = String(process.argv[2] || '').trim();
  const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(arg)
    ? arg
    : getIstClock(new Date()).dateKey;

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI missing in backend .env');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Force backfill live signals for ${dateKey}…`);
  const result = await forceBackfillLiveSignalsFromMinutes(dateKey);
  console.log(JSON.stringify(result, null, 2));
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

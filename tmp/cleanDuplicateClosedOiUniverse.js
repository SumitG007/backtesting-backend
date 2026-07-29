/**
 * Remove duplicate same-second SUNPHARMA (or any) closed spam; keep one per burst.
 * Run: node tmp/cleanDuplicateClosedOiUniverse.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const STRATEGY_KEY = 'strategy13_oi_universe_live';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const LivePaperTrade = require('../src/models/livePaperTrade');
  const engine = require('../src/services/liveOiUniverseScannerEngine');

  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).sort({ entryTime: 1, exitTime: 1 });

  const keep = new Set();
  const removeIds = [];
  const seenBurst = new Map(); // key -> first id

  for (const t of closed) {
    const id = t._id.toString();
    const entryMs = t.entryTime ? new Date(t.entryTime).getTime() : 0;
    const exitMs = t.exitTime ? new Date(t.exitTime).getTime() : 0;
    // Same symbol+strike+side within 5s entry and 5s exit = duplicate burst
    const bucketEntry = Math.floor(entryMs / 5000);
    const bucketExit = Math.floor(exitMs / 5000);
    const key = [
      String(t.symbol || '').toUpperCase(),
      t.optionType,
      t.strike,
      t.reason || '',
      bucketEntry,
      bucketExit,
      Number(t.entryPremium),
    ].join('|');

    if (seenBurst.has(key)) {
      removeIds.push(id);
      continue;
    }
    seenBurst.set(key, id);
    keep.add(id);
  }

  console.log('Closed total:', closed.length);
  console.log('Keep:', keep.size);
  console.log('Delete duplicates:', removeIds.length);

  if (removeIds.length) {
    const del = await LivePaperTrade.deleteMany({
      _id: { $in: removeIds },
      strategyKey: STRATEGY_KEY,
    });
    console.log('Deleted:', del.deletedCount);
    await engine.recalcWalletFromTrades();
    console.log('Wallet recalculated');
  }

  const sun = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    symbol: /sunpharma/i,
  })
    .sort({ entryTime: 1 })
    .lean();
  console.log(
    'SUNPHARMA left:',
    sun.map((t) => ({
      id: String(t._id).slice(-6),
      status: t.status,
      reason: t.reason,
      entry: t.entryPremium,
      exit: t.exitPremium,
      pnl: t.pnl,
      entryTime: t.entryTime,
    })),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

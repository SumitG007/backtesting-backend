/**
 * Keep one SUNPHARMA STOP_LOSS; delete the rest; recalc wallet.
 * Run: node tmp/cleanSunpharmaDupes.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const STRATEGY_KEY = 'strategy13_oi_universe_live';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const LivePaperTrade = require('../src/models/livePaperTrade');
  const engine = require('../src/services/liveOiUniverseScannerEngine');

  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    symbol: /sunpharma/i,
    reason: 'STOP_LOSS',
  }).sort({ entryTime: 1 });

  console.log('SUNPHARMA STOP_LOSS count:', rows.length);
  if (rows.length <= 1) {
    console.log('Nothing to clean');
    await mongoose.disconnect();
    return;
  }

  const keep = rows[0];
  const remove = rows.slice(1);
  console.log('Keep:', keep._id.toString(), 'pnl=', keep.pnl);
  const del = await LivePaperTrade.deleteMany({
    _id: { $in: remove.map((r) => r._id) },
  });
  console.log('Deleted:', del.deletedCount);
  await engine.recalcWalletFromTrades();
  console.log('Wallet recalculated');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

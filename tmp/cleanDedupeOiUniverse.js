/**
 * Remove bogus DEDUPE_CLOSE rows from OI Universe book and restore
 * one open per symbol that was wrongly force-closed.
 * Run: node tmp/cleanDedupeOiUniverse.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const STRATEGY_KEY = 'strategy13_oi_universe_live';

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(mongoUri);
  const LivePaperTrade = require('../src/models/livePaperTrade');
  const engine = require('../src/services/liveOiUniverseScannerEngine');

  const dedupe = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    reason: 'DEDUPE_CLOSE',
  }).sort({ entryTime: 1 });

  console.log('DEDUPE_CLOSE rows:', dedupe.length);

  const openNow = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).lean();
  const openSymbols = new Set(openNow.map((t) => String(t.symbol || '').toUpperCase()));
  console.log(
    'Currently open:',
    openNow.map((t) => `${t.symbol} ${t.optionType} ${t.strike}`),
  );

  // For each symbol with no live open, restore the earliest DEDUPE row as OPEN.
  const restoreBySymbol = {};
  for (const t of dedupe) {
    const sym = String(t.symbol || '').toUpperCase();
    if (openSymbols.has(sym)) continue;
    if (restoreBySymbol[sym]) continue;
    restoreBySymbol[sym] = t;
  }

  const restored = [];
  for (const t of Object.values(restoreBySymbol)) {
    t.status = 'OPEN';
    t.exitTime = null;
    t.exitDateKey = null;
    t.exitPremium = null;
    t.reason = null;
    t.pnl = null;
    t.pnlPct = null;
    t.notes = [t.notes, 'restored_from_dedupe_close'].filter(Boolean).join(' | ').slice(0, 500);
    // eslint-disable-next-line no-await-in-loop
    await t.save();
    openSymbols.add(String(t.symbol || '').toUpperCase());
    restored.push(`${t.symbol} ${t.optionType} ${t.strike} @ ${t.entryPremium}`);
  }
  console.log('Restored opens:', restored);

  // Delete remaining DEDUPE_CLOSE noise (not restored).
  const del = await LivePaperTrade.deleteMany({
    strategyKey: STRATEGY_KEY,
    reason: 'DEDUPE_CLOSE',
  });
  console.log('Deleted leftover DEDUPE_CLOSE:', del.deletedCount);

  await engine.recalcWalletFromTrades();
  await engine.reconcileOpenTrades();
  const after = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).lean();
  console.log(
    'Open after cleanup:',
    after.map((t) => `${t.symbol} ${t.optionType} ${t.strike} entry=${t.entryPremium}`),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

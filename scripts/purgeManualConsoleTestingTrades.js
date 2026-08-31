/**
 * Remove specific manual-console testing trades from MongoDB.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const { MANUAL_CONSOLE_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = MANUAL_CONSOLE_LIVE_KEY;

/** Match by strike, option type, expiry, entry premium (rounded), isTesting. */
const TARGETS = [
  { strike: 24350, optionType: 'CE', expiryDate: '2026-09-01', entryPremium: 51.1, lots: 10, qty: 650 },
  { strike: 24300, optionType: 'CE', expiryDate: '2026-09-01', entryPremium: 62.9, lots: 10, qty: 650 },
  { strike: 24200, optionType: 'PE', expiryDate: '2026-08-25', entryPremium: 36.45, lots: 10, qty: 650 },
  { strike: 24150, optionType: 'PE', expiryDate: '2026-08-25', entryPremium: 23.7, lots: 10, qty: 650 },
];

function matchesTarget(trade, t) {
  return (
    trade.isTesting === true &&
    Number(trade.strike) === t.strike &&
    String(trade.optionType).toUpperCase() === t.optionType &&
    String(trade.expiryDate) === t.expiryDate &&
    Math.abs(Number(trade.entryPremium) - t.entryPremium) < 0.02 &&
    Number(trade.lots) === t.lots &&
    Number(trade.qty) === t.qty
  );
}

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI missing');

  await mongoose.connect(uri);
  const trades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    isTesting: true,
    status: 'CLOSED',
  }).lean();

  const ids = [];
  for (const spec of TARGETS) {
    const hit = trades.find((t) => matchesTarget(t, spec));
    if (!hit) {
      console.warn(`NOT FOUND: ${spec.optionType} ${spec.strike} exp=${spec.expiryDate} entry=${spec.entryPremium}`);
      continue;
    }
    ids.push(hit._id);
    console.log(
      `DELETE ${hit.optionType} ${hit.strike} entry=${hit.entryTime} exit=${hit.exitTime} pnl=${hit.pnl}`,
    );
  }

  if (!ids.length) {
    console.log('No matching trades to delete.');
    await mongoose.disconnect();
    return;
  }

  const result = await LivePaperTrade.deleteMany({ _id: { $in: ids } });
  console.log(`\nDeleted ${result.deletedCount} testing trade(s). Main wallet unchanged (testing book only).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

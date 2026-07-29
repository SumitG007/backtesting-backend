/**
 * Inspect OI Universe opens (with live marks) + any DEDUPE_CLOSE rows.
 * Run: node tmp/inspectOiUniverseOpens.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const STRATEGY_KEY = 'strategy13_oi_universe_live';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const LivePaperTrade = require('../src/models/livePaperTrade');

  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  })
    .sort({ entryTime: 1 })
    .lean();
  console.log('OPEN NOW:', open.length);
  for (const t of open) {
    const m = t.openPositionMark || {};
    console.log(
      `  ${t.symbol} ${t.optionType} ${t.strike} entry=${t.entryPremium} tg=${t.targetPremium} sl=${t.stopLossPremium} ltp=${m.optionLtp ?? '-'} src=${m.source ?? '-'} mtm=${m.unrealizedPnl ?? '-'}`,
    );
  }

  const dedupe = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    reason: 'DEDUPE_CLOSE',
  });
  console.log('DEDUPE_CLOSE rows:', dedupe);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

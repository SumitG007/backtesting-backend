/**
 * Delete CLOSED paper-live trades for Strategy 6 — SL Flip.
 * Keeps any OPEN position. Recalculates wallet realized P&L.
 *
 * Run: node scripts/clearSlFlipClosedPaperTrades.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const { STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy11';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing in backend .env');

  await mongoose.connect(uri);
  console.log('Connected. Strategy key:', STRATEGY_KEY);

  const closedFilter = {
    strategyKey: STRATEGY_KEY,
    $or: [{ status: 'CLOSED' }, { exitTime: { $ne: null } }],
  };

  const openCount = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  });
  const closedCount = await LivePaperTrade.countDocuments(closedFilter);
  console.log(`Before: open=${openCount}, closed=${closedCount}`);

  const result = await LivePaperTrade.deleteMany(closedFilter);
  console.log(`Deleted closed trades: ${result.deletedCount}`);

  const remainingClosed = await LivePaperTrade.find(closedFilter).lean();
  let realized = 0;
  let wins = 0;
  let losses = 0;
  for (const t of remainingClosed) {
    const p = Number(t.pnl) || 0;
    realized += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }

  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) wallet = await LiveWallet.create({ walletKey: WALLET_KEY });
  wallet.startingBalance = 0;
  wallet.realizedPnl = Number(realized.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = remainingClosed.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();

  const openAfter = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  });
  console.log(`After: open=${openAfter}, closed=${remainingClosed.length}`);
  console.log('Wallet:', {
    realizedPnl: wallet.realizedPnl,
    balance: wallet.balance,
    totalTrades: wallet.totalTrades,
    wins: wallet.wins,
    losses: wallet.losses,
  });
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

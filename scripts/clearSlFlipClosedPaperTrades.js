/**
 * Delete CLOSED SL Flip paper-live trades for a fresh start (keeps any OPEN).
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

  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) wallet = await LiveWallet.create({ walletKey: WALLET_KEY });
  wallet.startingBalance = 0;
  wallet.realizedPnl = 0;
  wallet.balance = 0;
  wallet.totalTrades = 0;
  wallet.wins = 0;
  wallet.losses = 0;
  await wallet.save();

  const openAfter = await LivePaperTrade.countDocuments({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  });
  console.log(`After: open=${openAfter}, closed=0`);
  console.log('Wallet reset:', {
    realizedPnl: wallet.realizedPnl,
    balance: wallet.balance,
    totalTrades: wallet.totalTrades,
  });
  console.log('Done. Fresh start for Monday — open position (if any) kept.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

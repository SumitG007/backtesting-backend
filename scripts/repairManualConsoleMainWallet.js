/**
 * Repair Manual Console: testing trades must never count in main available cash.
 *
 * 1. Tag isTesting from notes (testing=1) and closed/open book.
 * 2. Rebuild wallet P/L / wins / losses / balance from MAIN only.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const ManualPendingOrder = require('../src/models/manualPendingOrder');
const { MANUAL_CONSOLE_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = MANUAL_CONSOLE_LIVE_KEY;

function isTestingTrade(trade) {
  if (trade.isTesting === true) return true;
  if (trade.isTesting === false) return false;
  return /testing\s*=\s*1/i.test(String(trade.notes || ''));
}

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI missing');

  await mongoose.connect(uri);

  // 1) Repair testing flags on trades.
  const all = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY })
    .select({ notes: 1, isTesting: 1, pnl: 1 })
    .lean();

  let taggedTesting = 0;
  let taggedMain = 0;
  const testingIds = [];
  const mainIds = [];
  for (const t of all) {
    if (isTestingTrade(t)) {
      if (t.isTesting !== true) {
        testingIds.push(t._id);
        taggedTesting += 1;
      }
    } else if (t.isTesting !== false) {
      mainIds.push(t._id);
      taggedMain += 1;
    }
  }
  if (testingIds.length) {
    await LivePaperTrade.updateMany(
      { _id: { $in: testingIds }, isTesting: { $ne: true } },
      { $set: { isTesting: true } },
    );
  }
  if (mainIds.length) {
    await LivePaperTrade.updateMany(
      { _id: { $in: mainIds }, isTesting: { $ne: false } },
      { $set: { isTesting: false } },
    );
  }
  console.log(
    `Tagged testing=${taggedTesting} main=${taggedMain} (from ${all.length} trades)`,
  );

  // 2) Rebuild main wallet ledger from non-testing closed trades only.
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).lean();
  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).lean();
  const pending = await ManualPendingOrder.find({
    strategyKey: STRATEGY_KEY,
    status: 'PENDING',
    heldAmount: { $gt: 0 },
  }).lean();

  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let mainCount = 0;
  for (const t of closed) {
    if (isTestingTrade(t)) continue;
    const pnl = Number(t.pnl);
    if (!Number.isFinite(pnl)) continue;
    mainCount += 1;
    realizedPnl += pnl;
    if (pnl > 0) {
      wins += 1;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losses += 1;
      grossLoss += Math.abs(pnl);
    }
  }

  let lockedOpen = 0;
  for (const t of open) {
    const locked = Number(t.capitalLocked);
    if (Number.isFinite(locked) && locked > 0) lockedOpen += locked;
    else {
      lockedOpen += (Number(t.investedAmount) || 0) + Math.max(0, Number(t.charges) || 0);
    }
  }
  let heldPending = 0;
  for (const o of pending) {
    heldPending += Number(o.heldAmount) || 0;
  }

  const wallet = await LiveWallet.findOne({ walletKey: 'paper_live_manual' });
  if (!wallet) {
    console.log('No paper_live_manual wallet found — skip rebuild.');
    await mongoose.disconnect();
    return;
  }

  const starting = Number(wallet.startingBalance) || 0;
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.grossProfit = Number(grossProfit.toFixed(2));
  wallet.grossLoss = Number(grossLoss.toFixed(2));
  wallet.totalTrades = mainCount;
  wallet.wins = wins;
  wallet.losses = losses;
  wallet.balance = Number(Math.max(0, starting + realizedPnl - lockedOpen - heldPending).toFixed(2));
  wallet.cashLedger = true;
  await wallet.save();

  console.log(
    JSON.stringify(
      {
        mainTrades: mainCount,
        wins,
        losses,
        grossProfit: wallet.grossProfit,
        grossLoss: wallet.grossLoss,
        realizedPnl: wallet.realizedPnl,
        balance: wallet.balance,
        openCapital: lockedOpen,
        pendingHeld: heldPending,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

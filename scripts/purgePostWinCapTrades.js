/**
 * Remove OI Wall Scalp paper trades that occurred after 7 consecutive wins on the same IST day.
 * Keeps first-SL-stops-day logic intact for remaining history.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const { MANUAL_OI_AUTO_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = MANUAL_OI_AUTO_LIVE_KEY;
const WALLET_KEY = 'paper_live_manual_oi_auto';
const CONSECUTIVE_WINS_CAP = 7;

function isWin(trade) {
  return Number(trade.pnl) > 0;
}

function isSl(trade) {
  const reason = String(trade.reason || '').toUpperCase();
  return reason === 'STOP_LOSS' || Number(trade.pnl) < 0;
}

function tradesToDeleteForDay(trades) {
  const toDelete = [];
  let consecutiveWins = 0;
  let winCapStop = false;

  for (const t of trades) {
    if (winCapStop) {
      toDelete.push(t);
      continue;
    }
    if (isSl(t)) {
      consecutiveWins = 0;
    } else if (isWin(t)) {
      consecutiveWins += 1;
      if (consecutiveWins >= CONSECUTIVE_WINS_CAP) winCapStop = true;
    } else {
      consecutiveWins = 0;
    }
  }
  return toDelete;
}

async function recalcWalletFromTrades() {
  const wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) return null;
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of rows) {
    const p = Number(t.pnl) || 0;
    realizedPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = rows.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return wallet;
}

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI missing');

  await mongoose.connect(uri);
  const trades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    status: 'CLOSED',
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  })
    .sort({ entryTime: 1 })
    .lean();

  const byDay = new Map();
  for (const t of trades) {
    const day = t.entryDateKey || String(t.entryTime).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const ids = [];
  for (const [day, dayTrades] of byDay.entries()) {
    const del = tradesToDeleteForDay(dayTrades);
    for (const t of del) {
      ids.push(t._id);
      console.log(`DELETE ${day} ${t.optionType} ${t.strike} entry=${t.entryTime} reason=${t.reason} pnl=${t.pnl}`);
    }
  }

  if (!ids.length) {
    console.log('No post-win-cap trades to delete.');
    await mongoose.disconnect();
    return;
  }

  const result = await LivePaperTrade.deleteMany({ _id: { $in: ids } });
  console.log(`\nDeleted ${result.deletedCount} trade(s).`);
  const wallet = await recalcWalletFromTrades();
  console.log(`Wallet recalculated: realizedPnl=₹${wallet?.realizedPnl} trades=${wallet?.totalTrades} W/L=${wallet?.wins}/${wallet?.losses}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

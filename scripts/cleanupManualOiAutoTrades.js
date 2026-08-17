/**
 * Remove invalid OI Wall Scalp (manual_oi_auto_live) trades:
 * - Weekend entries (Sat/Sun IST)
 * - Entries after the first STOP_LOSS of the same trading day
 *
 * Usage:
 *   node scripts/cleanupManualOiAutoTrades.js --dry
 *   node scripts/cleanupManualOiAutoTrades.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const { getIstClock, isWeekendDateKey } = require('../src/utils/dateTime');

const STRATEGY_KEY = 'manual_oi_auto_live';
const WALLET_KEY = 'paper_live_manual_oi_auto';

function tradeDayKey(trade) {
  if (trade.entryDateKey) return trade.entryDateKey;
  if (trade.entryTime) return getIstClock(trade.entryTime).dateKey;
  return null;
}

function isWeekendTrade(trade) {
  const dayKey = tradeDayKey(trade);
  if (dayKey && isWeekendDateKey(dayKey)) return true;
  if (trade.entryTime) {
    return isWeekendDateKey(getIstClock(trade.entryTime).dateKey);
  }
  return false;
}

async function recalcWallet() {
  const wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) return null;

  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
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

function collectInvalidTrades(trades) {
  const toDelete = new Map();
  const byDay = new Map();

  for (const t of trades) {
    if (isWeekendTrade(t)) {
      toDelete.set(String(t._id), { trade: t, reason: 'weekend' });
      continue;
    }
    const dayKey = tradeDayKey(t);
    if (!dayKey) continue;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(t);
  }

  for (const [dayKey, dayTrades] of byDay) {
    const slExits = dayTrades
      .filter((t) => t.reason === 'STOP_LOSS' && t.exitTime)
      .sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
    if (!slExits.length) continue;

    const firstSlExitMs = new Date(slExits[0].exitTime).getTime();
    for (const t of dayTrades) {
      const entryMs = new Date(t.entryTime).getTime();
      if (entryMs > firstSlExitMs) {
        toDelete.set(String(t._id), {
          trade: t,
          reason: 'after_first_sl',
          dayKey,
          firstSlExit: slExits[0].exitTime,
        });
      }
    }
  }

  return [...toDelete.values()];
}

async function main() {
  const dry = process.argv.includes('--dry');
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing in .env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const trades = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY })
    .sort({ entryTime: 1 });

  console.log(`Loaded ${trades.length} OI Wall Scalp trades (${dry ? 'DRY RUN' : 'APPLY'})`);

  const invalid = collectInvalidTrades(trades);
  const weekendCount = invalid.filter((x) => x.reason === 'weekend').length;
  const afterSlCount = invalid.filter((x) => x.reason === 'after_first_sl').length;

  console.log(`Invalid: ${invalid.length} (weekend=${weekendCount}, after_first_sl=${afterSlCount})`);

  for (const row of invalid) {
    const t = row.trade;
    console.log(
      [
        row.reason,
        tradeDayKey(t),
        t.status,
        t.reason || '-',
        `entry=${t.entryTime?.toISOString?.() || t.entryTime}`,
        `exit=${t.exitTime?.toISOString?.() || t.exitTime || '-'}`,
        `pnl=${t.pnl ?? '-'}`,
        `id=${t._id}`,
      ].join(' | '),
    );
  }

  if (!dry && invalid.length) {
    const ids = invalid.map((x) => x.trade._id);
    const result = await LivePaperTrade.deleteMany({ _id: { $in: ids } });
    console.log(`Deleted ${result.deletedCount} trades`);
    const wallet = await recalcWallet();
    if (wallet) {
      console.log(
        `Wallet recalculated: balance=${wallet.balance} trades=${wallet.totalTrades} wins=${wallet.wins} losses=${wallet.losses}`,
      );
    }
  } else if (!invalid.length) {
    console.log('No invalid trades to remove.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

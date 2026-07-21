/**
 * Inspect + delete short-straddle paper trades from the retired 15:20 engine.
 * Keeps only ~09:20 entries under strategy6_short_straddle_next_day_live.
 *
 * Usage:
 *   node scripts/purgeStraddle1520PaperTrades.js --dry-run
 *   node scripts/purgeStraddle1520PaperTrades.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const {
  STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SIX_KEY,
} = require('../src/strategies/keys');
const { getIstClock } = require('../src/utils/dateTime');

const DRY = process.argv.includes('--dry-run');
const WALLET4 = 'paper_live_strategy4';
const WALLET6 = 'paper_live_strategy6';

function lockedEntryFromNotes(notes) {
  const m = String(notes || '').match(/lockedEntryTime=([^;]+)/i);
  return m ? String(m[1]).trim() : null;
}

function isAfternoonEntry(trade) {
  const locked = lockedEntryFromNotes(trade.notes);
  if (locked) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(locked);
    if (m) {
      const mins = Number(m[1]) * 60 + Number(m[2]);
      // Afternoon session entries (after 12:00) — primarily 15:20
      return mins >= 12 * 60;
    }
  }
  if (trade.strategyKey === STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY) return true;
  const clock = getIstClock(trade.entryTime || new Date());
  return clock.minutes >= 12 * 60;
}

async function recalcWallet6() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET6 });
  if (!wallet) return null;
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
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
  wallet.startingBalance = 0;
  wallet.totalTrades = rows.length;
  wallet.wins = wins;
  wallet.losses = losses;
  if (!DRY) await wallet.save();
  return {
    totalTrades: wallet.totalTrades,
    realizedPnl: wallet.realizedPnl,
    wins,
    losses,
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const straddleFilter = {
    optionType: 'STRADDLE',
    strategyKey: {
      $in: [
        STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY,
        STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
        STRATEGY_SIX_KEY,
      ],
    },
  };

  const all = await LivePaperTrade.find(straddleFilter).lean();
  const byKey = {};
  for (const t of all) {
    byKey[t.strategyKey] = (byKey[t.strategyKey] || 0) + 1;
  }
  console.log('Straddle paper trades by key:', byKey);

  const toDelete = all.filter(isAfternoonEntry);
  const keep = all.filter((t) => !isAfternoonEntry(t));
  console.log(`Keep (morning ~09:20): ${keep.length}`);
  console.log(`Delete (afternoon / strategy4 / locked 15:20): ${toDelete.length}`);

  for (const t of toDelete.slice(0, 20)) {
    const clock = getIstClock(t.entryTime || new Date());
    const locked = lockedEntryFromNotes(t.notes);
    console.log(
      `  - ${clock.dateKey} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`
        + ` key=${t.strategyKey} locked=${locked || '—'} status=${t.status || '—'}`,
    );
  }
  if (toDelete.length > 20) console.log(`  … and ${toDelete.length - 20} more`);

  if (DRY) {
    console.log('\nDry run — no deletes.');
    await mongoose.disconnect();
    return;
  }

  const ids = toDelete.map((t) => t._id);
  if (ids.length) {
    const del = await LivePaperTrade.deleteMany({ _id: { $in: ids } });
    console.log(`Deleted ${del.deletedCount} trades`);
  }

  // Also wipe any leftover strategy4-only rows (non-STRADDLE edge cases) and wallet4
  const extra = await LivePaperTrade.deleteMany({ strategyKey: STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY });
  if (extra.deletedCount) console.log(`Deleted extra strategy4 key rows: ${extra.deletedCount}`);

  const w4 = await LiveWallet.findOne({ walletKey: WALLET4 });
  if (w4) {
    await LiveWallet.deleteOne({ walletKey: WALLET4 });
    console.log('Removed paper_live_strategy4 wallet');
  }

  const wallet6 = await recalcWallet6();
  console.log('Recalculated paper_live_strategy6:', wallet6);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

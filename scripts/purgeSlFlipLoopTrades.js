/**
 * Remove bogus SL Flip loop trades (instant trail re-entry burst) and recalc wallet.
 * Keeps: OPEN trade, closed trades NOT matching loop pattern.
 * Run: node scripts/purgeSlFlipLoopTrades.js [YYYY-MM-DD] [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const { STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy11';

function minuteKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

function holdMs(t) {
  if (!t.exitTime || !t.entryTime) return null;
  const ms = new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Loop / burst duplicates — not real separate trades. */
function findLoopTradeIds(all) {
  const closed = all.filter((t) => t.exitTime && t.status === 'CLOSED');
  const toDelete = new Set();

  // 1) Fast TRAIL_STOP exits (<2 min) — same-bar re-entry poison.
  for (const t of closed) {
    const reason = String(t.reason || '').toUpperCase();
    const ms = holdMs(t);
    if (reason === 'TRAIL_STOP' && ms != null && ms < 120_000) {
      toDelete.add(String(t._id));
    }
  }

  // 2) Burst minutes (≥3 closed same entry minute): keep longest-hold trade only.
  const byMinute = new Map();
  for (const t of closed) {
    const k = minuteKey(t.entryTime);
    if (!byMinute.has(k)) byMinute.set(k, []);
    byMinute.get(k).push(t);
  }
  for (const [, rows] of byMinute.entries()) {
    if (rows.length < 3) continue;
    const sorted = [...rows].sort((a, b) => (holdMs(b) || 0) - (holdMs(a) || 0));
    for (let i = 1; i < sorted.length; i += 1) {
      toDelete.add(String(sorted[i]._id));
    }
  }

  // 3) Exact duplicates: same entry minute, premiums, reason — keep one.
  const dupGroups = new Map();
  for (const t of closed) {
    const k = [
      minuteKey(t.entryTime),
      t.optionType,
      Number(t.entryPremium).toFixed(2),
      Number(t.exitPremium).toFixed(2),
      String(t.reason || ''),
    ].join('|');
    if (!dupGroups.has(k)) dupGroups.set(k, []);
    dupGroups.get(k).push(t);
  }
  for (const rows of dupGroups.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => (holdMs(b) || 0) - (holdMs(a) || 0));
    for (let i = 1; i < sorted.length; i += 1) {
      toDelete.add(String(sorted[i]._id));
    }
  }

  return [...toDelete];
}

async function recalcWallet() {
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).lean();
  let realized = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
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
  wallet.totalTrades = closed.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return { realized, wins, losses, total: closed.length };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');

  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const dryRun = process.argv.includes('--dry-run');
  const filterDate = args[0] || null;

  await mongoose.connect(uri);

  const query = {
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
    status: 'CLOSED',
  };
  if (filterDate) query.entryDateKey = filterDate;

  const all = await LivePaperTrade.find(query).lean();

  const loopIds = findLoopTradeIds(all);
  const scope = filterDate || 'ALL_DATES';
  console.log(`Scope ${scope}: closed=${all.length}, duplicates=${loopIds.length}, dryRun=${dryRun}`);

  if (loopIds.length === 0) {
    console.log('Nothing to purge.');
    await mongoose.disconnect();
    return;
  }

  if (!dryRun) {
    const result = await LivePaperTrade.deleteMany({ _id: { $in: loopIds } });
    console.log('Deleted:', result.deletedCount);
    const wallet = await recalcWallet();
    console.log('Wallet recalc:', wallet);
  } else {
    const idSet = new Set(loopIds.map(String));
    const fakePnl = all.filter((t) => idSet.has(String(t._id))).reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    console.log('Would delete P/L sum (fake):', fakePnl.toFixed(2));
  }

  const remaining = await LivePaperTrade.countDocuments({ strategyKey: STRATEGY_KEY });
  console.log('Trades remaining (all dates):', remaining);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

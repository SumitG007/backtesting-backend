/**
 * Audit SL Flip paper-live trades — find duplicates, loop bursts, wallet mismatch.
 * Run: node scripts/auditSlFlipPaperTrades.js [YYYY-MM-DD]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const { STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY;
const WALLET_KEY = 'paper_live_strategy11';

function fmtIst(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(new Date(d));
}

function minuteKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');

  const dateKey = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  await mongoose.connect(uri);

  const trades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
  })
    .sort({ entryTime: 1 })
    .lean();

  const wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY }).lean();

  console.log('\n=== SL Flip paper-live audit ===');
  console.log('Date:', dateKey);
  console.log('Strategy key:', STRATEGY_KEY);
  console.log('Total trades:', trades.length);

  const open = trades.filter((t) => !t.exitTime && t.status !== 'CLOSED');
  const closed = trades.filter((t) => t.exitTime || t.status === 'CLOSED');
  console.log('Open:', open.length, '| Closed:', closed.length);

  // Burst detection: many trades same entry minute
  const byMinute = new Map();
  for (const t of trades) {
    const k = minuteKey(t.entryTime);
    if (!byMinute.has(k)) byMinute.set(k, []);
    byMinute.get(k).push(t);
  }

  console.log('\n--- Bursts (same entry minute) ---');
  let suspiciousCount = 0;
  for (const [min, rows] of byMinute.entries()) {
    if (rows.length < 3) continue;
    suspiciousCount += rows.length;
    const reasons = [...new Set(rows.map((r) => r.reason || 'OPEN'))].join(', ');
    console.log(`  ${min} IST → ${rows.length} trades (${reasons})`);
  }
  if (suspiciousCount === 0) console.log('  None ≥3/min');

  // Same-second duplicates
  console.log('\n--- Same entry+exit second duplicates ---');
  const dupKey = new Map();
  for (const t of closed) {
    const k = `${fmtIst(t.entryTime)}|${fmtIst(t.exitTime)}|${t.optionType}|${Number(t.entryPremium).toFixed(2)}|${Number(t.exitPremium).toFixed(2)}`;
    dupKey.set(k, (dupKey.get(k) || 0) + 1);
  }
  let dupGroups = 0;
  for (const [k, n] of dupKey.entries()) {
    if (n >= 2) {
      dupGroups += 1;
      console.log(`  ×${n}: ${k}`);
    }
  }
  if (dupGroups === 0) console.log('  None');

  // P/L from DB vs recomputed
  let sumPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
    const p = Number(t.pnl) || 0;
    sumPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  console.log('\n--- P/L (closed only, from DB) ---');
  console.log('  Sum pnl:', sumPnl.toFixed(2));
  console.log('  Wins/losses:', wins, '/', losses);
  if (wallet) {
    console.log('  Wallet realizedPnl:', wallet.realizedPnl);
    console.log('  Wallet totalTrades:', wallet.totalTrades);
    const drift = Math.abs(Number(wallet.realizedPnl || 0) - sumPnl) > 0.01;
    if (drift) console.log('  ⚠ Wallet P/L does NOT match sum of closed trades');
  }

  // Sub-second hold loop trades (entry≈exit, TRAIL_STOP)
  const loopTrades = closed.filter((t) => {
    if (String(t.reason).toUpperCase() !== 'TRAIL_STOP') return false;
    const holdMs = new Date(t.exitTime) - new Date(t.entryTime);
    return holdMs >= 0 && holdMs < 10_000;
  });
  console.log('\n--- Likely loop trades (TRAIL_STOP, held <10s) ---');
  console.log('  Count:', loopTrades.length);
  if (loopTrades.length > 0) {
    console.log('  These are almost certainly from the re-entry bug — safe to delete.');
  }

  console.log('\n--- Last 5 trades ---');
  for (const t of trades.slice(-5)) {
    console.log(
      `  ${t.optionType} entry ${fmtIst(t.entryTime)} exit ${fmtIst(t.exitTime)} pnl ${t.pnl ?? '—'} ${t.reason ?? t.status}`,
    );
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

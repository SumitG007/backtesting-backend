/**
 * Simulate OI Wall Scalp paper rule:
 * - Existing: first STOP_LOSS of the IST day → no more entries that day
 * - New: 7 consecutive profitable closes → no more entries that day
 *
 * Usage: node scripts/analyzeSevenWinRule.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const { MANUAL_OI_AUTO_LIVE_KEY } = require('../src/strategies/keys');

const STRATEGY_KEY = MANUAL_OI_AUTO_LIVE_KEY;
const CONSECUTIVE_WINS_CAP = 7;

function isWin(trade) {
  return Number(trade.pnl) > 0;
}

function isSl(trade) {
  const reason = String(trade.reason || '').toUpperCase();
  return reason === 'STOP_LOSS' || Number(trade.pnl) < 0;
}

function fmtIst(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function simulateDay(trades) {
  const taken = [];
  const skipped = [];
  let consecutiveWins = 0;
  let dailySlStop = false;
  let winCapStop = false;

  for (const t of trades) {
    let skipReason = null;
    if (dailySlStop) skipReason = 'daily_sl_stop (already hit SL today)';
    else if (winCapStop) skipReason = `win_cap (${CONSECUTIVE_WINS_CAP} consecutive wins)`;

    if (skipReason) {
      skipped.push({ trade: t, skipReason });
      continue;
    }

    taken.push(t);

    if (isSl(t)) {
      dailySlStop = true;
      consecutiveWins = 0;
    } else if (isWin(t)) {
      consecutiveWins += 1;
      if (consecutiveWins >= CONSECUTIVE_WINS_CAP) winCapStop = true;
    } else {
      consecutiveWins = 0;
    }
  }

  const actualPnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const simPnl = taken.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const skippedPnl = skipped.reduce((s, x) => s + (Number(x.trade.pnl) || 0), 0);

  return {
    taken,
    skipped,
    actualPnl,
    simPnl,
    skippedPnl,
    dailySlStop,
    winCapStop,
    tradeCount: trades.length,
    takenCount: taken.length,
    skippedCount: skipped.length,
  };
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
    const day = t.entryDateKey || (t.entryTime ? String(t.entryTime).slice(0, 10) : 'unknown');
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const days = [...byDay.keys()].sort();
  let totalActual = 0;
  let totalSim = 0;
  let totalSkipped = 0;
  let daysWinCapTriggered = 0;
  let daysSlStop = 0;

  console.log('\n=== OI Wall Scalp — 7 consecutive wins then stop (simulation) ===\n');
  console.log(`Strategy: ${STRATEGY_KEY}`);
  console.log(`Total closed trades in DB: ${trades.length}`);
  console.log(`Trading days: ${days.length}`);
  console.log(`Rules: (1) First SL stops day  (2) After ${CONSECUTIVE_WINS_CAP} wins in a row → stop day\n`);

  for (const day of days) {
    const dayTrades = byDay.get(day);
    const sim = simulateDay(dayTrades);
    totalActual += sim.actualPnl;
    totalSim += sim.simPnl;
    totalSkipped += sim.skippedPnl;
    if (sim.winCapStop) daysWinCapTriggered += 1;
    if (sim.dailySlStop) daysSlStop += 1;

    const flag = sim.skippedCount > 0 ? ' *** SKIPS ***' : '';
    console.log(`--- ${day} (${sim.takenCount}/${sim.tradeCount} taken)${flag} ---`);
    console.log(`  Actual day P/L: ₹${sim.actualPnl.toFixed(2)}  |  With rule: ₹${sim.simPnl.toFixed(2)}  |  Skipped trades P/L: ₹${sim.skippedPnl.toFixed(2)}`);
    if (sim.winCapStop) console.log(`  → Win cap hit (${CONSECUTIVE_WINS_CAP} consecutive wins)`);
    if (sim.dailySlStop) console.log(`  → Daily SL stop hit`);

    for (const t of sim.taken) {
      const pnl = Number(t.pnl) || 0;
      console.log(`  ✓ ${fmtIst(t.entryTime)} ${t.optionType} ${t.strike} | ${t.reason} | ₹${pnl.toFixed(2)}`);
    }
    for (const { trade: t, skipReason } of sim.skipped) {
      const pnl = Number(t.pnl) || 0;
      console.log(`  ✗ SKIP ${fmtIst(t.entryTime)} ${t.optionType} ${t.strike} | would be ${t.reason} ₹${pnl.toFixed(2)} | ${skipReason}`);
    }
    console.log('');
  }

  console.log('=== GRAND TOTAL ===');
  console.log(`Actual total P/L (all ${trades.length} trades):     ₹${totalActual.toFixed(2)}`);
  console.log(`Simulated P/L (with 7-win + SL rules):              ₹${totalSim.toFixed(2)}`);
  console.log(`P/L from trades that would be SKIPPED:              ₹${totalSkipped.toFixed(2)}`);
  console.log(`Difference (actual − simulated):                    ₹${(totalActual - totalSim).toFixed(2)}`);
  console.log(`Days win-cap triggered:                             ${daysWinCapTriggered}`);
  console.log(`Days SL-stop triggered:                             ${daysSlStop}`);
  console.log(`Trades taken: ${trades.length - days.reduce((n, d) => n + simulateDay(byDay.get(d)).skippedCount, 0)} / ${trades.length}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

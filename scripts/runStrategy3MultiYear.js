/**
 * Strategy 3 — Put & Call buy: 20 SL/target scenarios across all cached years.
 *
 *   npm run scenarios:s3
 *   npm run scenarios:s3 -- --api
 *   SCENARIO_IDS=S01,S05 node scripts/runStrategy3MultiYear.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runSimple920Backtest } = require('../src/strategies/strategy7/simple920Backtest');
const { STRATEGY_THREE_SCENARIOS } = require('../src/strategies/strategy7/scenarios');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades, countExits } = require('./lib/multiYearMonthlyStats');
const { getIstClock } = require('../src/utils/dateTime');
const { getLotSize, getStrikeStep } = require('../src/utils/market');

const YEARS = DEFAULT_YEARS;
const SYMBOL = 'NIFTY';
const INTERVAL = '5';

function yearFromTrade(t) {
  return getIstClock(t.entryTime).dateKey.slice(0, 4);
}

function formatExit(exits) {
  const tg = exits.TARGET || 0;
  const sl = exits.STOP_LOSS || 0;
  const eod = exits.DAY_CLOSE || 0;
  return `T${tg}/S${sl}/E${eod}`;
}

function runScenario(scenario, allRows) {
  const settings = {
    ...scenario.settings,
    symbol: SYMBOL,
    interval: INTERVAL,
    lotSize: getLotSize(SYMBOL),
    strikeStep: getStrikeStep(SYMBOL),
  };
  const out = runSimple920Backtest({ candles: allRows, settings });
  const trades = out.trades || [];
  const summary = out.summary || {};
  const totalNet = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const monthly = analyzeTrades(trades, SYMBOL);
  const exits = countExits(trades);

  const byYear = {};
  let peTrades = 0;
  let ceTrades = 0;
  for (const t of trades) {
    const y = yearFromTrade(t);
    if (!byYear[y]) byYear[y] = { net: 0, trades: 0, wins: 0, pe: 0, ce: 0 };
    byYear[y].net += Number(t.pnl) || 0;
    byYear[y].trades += 1;
    if (Number(t.pnl) > 0) byYear[y].wins += 1;
    const type = String(t.type || '').toUpperCase();
    if (type === 'PE') {
      byYear[y].pe += 1;
      peTrades += 1;
    } else if (type === 'CE') {
      byYear[y].ce += 1;
      ceTrades += 1;
    }
  }

  const tg = Number(settings.targetProfitPoints) || 0;
  const sl = Number(settings.stopLossPoints) || 0;

  return {
    id: scenario.id,
    name: scenario.name,
    sl,
    tg: tg > 0 ? tg : 'EOD',
    exitMode: tg > 0 ? 'target' : 'eod',
    minDirectionScore: settings.minDirectionScore,
    totalTrades: trades.length,
    skippedDays: summary.skippedDays ?? 0,
    putTrades: summary.putTrades ?? peTrades,
    callTrades: summary.callTrades ?? ceTrades,
    peTrades,
    ceTrades,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    monthly,
    byYear,
    exits,
    exitLabel: formatExit(exits),
  };
}

function printReport(results) {
  const ranked = [...results].sort((a, b) => {
    if (b.totalNet !== a.totalNet) return b.totalNet - a.totalNet;
    return b.winRate - a.winRate;
  });

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 3 — PUT & CALL BUY — 20 SCENARIOS — ALL YEARS');
  console.log(` Years: ${YEARS.join(', ')} | Entry 11:15 | min score 2 | 10 lots`);
  console.log(' Ranked by total net P/L (all years combined)');
  console.log('══════════════════════════════════════════════════════════════════\n');

  console.log(
    'Rank | ID  | Total Net | Trades | WR%   | PE  | CE  | SL | TG   | Exits(T/S/E) | Name'
  );
  console.log(
    '-----|-----|-----------|--------|-------|-----|-----|----|------|--------------|-----'
  );

  ranked.forEach((r, i) => {
    const mark = r.totalNet > 0 ? ' ' : '*';
    const tgCol = r.tg === 'EOD' ? ' EOD ' : String(r.tg).padStart(4);
    console.log(
      `${mark}${String(i + 1).padStart(3)} | ${r.id} | ${String(r.totalNet).padStart(9)} | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.peTrades).padStart(3)} | ${String(r.ceTrades).padStart(3)} | ${String(r.sl).padStart(2)} | ${tgCol} | ${r.exitLabel.padEnd(12)} | ${r.name}`
    );
  });

  const best = ranked[0];
  const baseline = ranked.find((r) => r.id === 'S01') || ranked[ranked.length - 1];
  const bestEod = [...ranked].filter((r) => r.exitMode === 'eod').sort((a, b) => b.totalNet - a.totalNet)[0];
  const bestTarget = [...ranked].filter((r) => r.exitMode === 'target').sort((a, b) => b.totalNet - a.totalNet)[0];

  console.log('\n── PER-YEAR NET (winner) ──');
  if (best) {
    console.log(`  ${best.id}: ${best.name}`);
    for (const y of YEARS) {
      const yr = best.byYear[String(y)] || { net: 0, trades: 0 };
      console.log(`  ${y}: net=${Number(yr.net).toFixed(0)} trades=${yr.trades}`);
    }
  }

  console.log('\n── BASELINE S01 (SL15 EOD) ──');
  if (baseline) {
    console.log(`  Total net: ${baseline.totalNet}`);
    for (const y of YEARS) {
      const yr = baseline.byYear[String(y)] || { net: 0, trades: 0 };
      console.log(`  ${y}: net=${Number(yr.net).toFixed(0)} trades=${yr.trades}`);
    }
  }

  console.log('\n── BEST OVERALL (all years) ──');
  if (best) {
    console.log(`  ${best.id}: ${best.name}`);
    console.log(`  Total net Rs ${best.totalNet} | WR ${best.winRate}% | ${best.exitLabel}`);
  }

  console.log('\n── BEST EOD-ONLY (no target) ──');
  if (bestEod) {
    console.log(`  ${bestEod.id}: ${bestEod.name} → Rs ${bestEod.totalNet}`);
  }

  console.log('\n── BEST WITH TARGET ──');
  if (bestTarget) {
    console.log(`  ${bestTarget.id}: ${bestTarget.name} → Rs ${bestTarget.totalNet}`);
  }

  return ranked;
}

async function main() {
  const preferApi = process.argv.includes('--api');
  console.log(`Loading ${SYMBOL} ${INTERVAL}m ${YEARS.join(', ')}...`);
  const { allRows, source } = await loadCandlesMultiYear({
    symbol: SYMBOL,
    interval: INTERVAL,
    years: YEARS,
    preferApi,
  });
  console.log(`Loaded ${allRows.length} bars (${source})\n`);

  const filterIds = process.env.SCENARIO_IDS
    ? process.env.SCENARIO_IDS.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const scenarioList = filterIds
    ? STRATEGY_THREE_SCENARIOS.filter((s) => filterIds.includes(s.id))
    : STRATEGY_THREE_SCENARIOS;

  const results = [];
  for (const scenario of scenarioList) {
    process.stdout.write(`  ${scenario.id}...`);
    const r = runScenario(scenario, allRows);
    results.push(r);
    console.log(` net=${r.totalNet}`);
  }

  const ranked = printReport(results);
  const jsonPath = path.join(__dirname, 'strategy3-multiyear-report.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        years: YEARS,
        symbol: SYMBOL,
        lotCount: 10,
        entryTime: '11:15',
        results,
        rankedIds: ranked.map((r) => r.id),
        bestOverallId: ranked[0]?.id || null,
        bestOverallNet: ranked[0]?.totalNet ?? null,
        bestEodId: [...ranked].filter((r) => r.exitMode === 'eod').sort((a, b) => b.totalNet - a.totalNet)[0]?.id || null,
        bestTargetId: [...ranked].filter((r) => r.exitMode === 'target').sort((a, b) => b.totalNet - a.totalNet)[0]?.id || null,
      },
      null,
      2
    )
  );
  console.log(`\nJSON: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

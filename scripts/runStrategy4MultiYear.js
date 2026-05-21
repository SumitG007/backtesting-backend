/**
 * Strategy 4 — multi-year scenarios with 2023-focused ranking.
 *
 *   npm run scenarios:s4
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runIntradayTierBacktest } = require('../src/strategies/intradayTier/backtest');
const { STRATEGY_FOUR_SCENARIOS } = require('../src/strategies/strategy4/scenarios');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades, countExits } = require('./lib/multiYearMonthlyStats');
const { getIstClock } = require('../src/utils/dateTime');

const YEARS = DEFAULT_YEARS;
const SYMBOL = 'NIFTY';
const INTERVAL = '5';

function yearFromTrade(t) {
  return getIstClock(t.entryTime).dateKey.slice(0, 4);
}

function runScenario(scenario, allRows) {
  const settings = { ...scenario.settings, symbol: SYMBOL, interval: INTERVAL };
  const out = runIntradayTierBacktest({
    candles: allRows,
    settings,
    variant: 'first_hour_pe_ce',
  });
  const trades = out.trades || [];
  const totalNet = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const monthly = analyzeTrades(trades, SYMBOL);

  const byYear = {};
  let peTrades = 0;
  let ceTrades = 0;
  for (const t of trades) {
    const y = yearFromTrade(t);
    if (!byYear[y]) byYear[y] = { net: 0, trades: 0, wins: 0, pe: 0, ce: 0 };
    byYear[y].net += Number(t.pnl) || 0;
    byYear[y].trades += 1;
    if (Number(t.pnl) > 0) byYear[y].wins += 1;
    if (String(t.type) === 'PE') {
      byYear[y].pe += 1;
      peTrades += 1;
    } else if (String(t.type) === 'CE') {
      byYear[y].ce += 1;
      ceTrades += 1;
    }
  }

  const y2023 = byYear['2023'] || { net: 0, trades: 0 };

  return {
    id: scenario.id,
    name: scenario.name,
    sl: settings.stopLossPoints,
    tg: settings.targetProfitPoints,
    tradeSide: settings.tradeSide || 'both',
    totalTrades: trades.length,
    peTrades,
    ceTrades,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    net2023: Number((y2023.net || 0).toFixed(2)),
    trades2023: y2023.trades || 0,
    monthly,
    byYear,
    exits: countExits(trades),
  };
}

function printReport(results) {
  const ranked = [...results].sort((a, b) => {
    if (b.net2023 !== a.net2023) return b.net2023 - a.net2023;
    if (b.monthly.months5k !== a.monthly.months5k) return b.monthly.months5k - a.monthly.months5k;
    return b.totalNet - a.totalNet;
  });

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 4 — FIRST HOUR OPEN BIAS — MULTI-YEAR SCENARIOS');
  console.log(' Ranked by 2023 net first (fix the weak year), then months>=5k, 5yr net');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log(
    'Rank | ID  | 2023 Net | 5yr Net  | Mo>=5k | Trades | WR%   | PE  | CE  | SL | TG  | Side'
  );
  console.log(
    '-----|-----|----------|----------|--------|--------|-------|-----|-----|----|-----|------'
  );

  ranked.forEach((r, i) => {
    const m = r.monthly;
    const mark = r.totalNet > 0 ? ' ' : '*';
    console.log(
      `${mark}${String(i + 1).padStart(3)} | ${r.id} | ${String(r.net2023).padStart(8)} | ${String(r.totalNet).padStart(8)} | ${String(m.months5k).padStart(2)}/${m.totalMonths}  | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.peTrades).padStart(3)} | ${String(r.ceTrades).padStart(3)} | ${String(r.sl).padStart(2)} | ${String(r.tg).padStart(3)} | ${String(r.tradeSide).slice(0, 6)}`
    );
  });

  const best2023 = ranked.filter((r) => r.net2023 > 0).sort((a, b) => b.net2023 - a.net2023)[0];
  const best5yr = [...ranked].sort((a, b) => b.totalNet - a.totalNet)[0];
  const baseline = ranked.find((r) => r.id === 'F01') || ranked[ranked.length - 1];

  console.log('\n── BASELINE F01 (SL18/TG80) ──');
  if (baseline) {
    console.log(`  2023: ${baseline.net2023} | 5yr: ${baseline.totalNet}`);
    for (const y of YEARS) {
      const yr = baseline.byYear[y] || { net: 0, trades: 0 };
      console.log(`  ${y}: net=${Number(yr.net).toFixed(0)} trades=${yr.trades}`);
    }
  }

  console.log('\n── BEST FOR 2023 (positive year) ──');
  if (best2023) {
    console.log(`  ${best2023.id}: ${best2023.name}`);
    console.log(`  2023 net ${best2023.net2023} | 5yr net ${best2023.totalNet}`);
  } else {
    console.log('  None — every scenario lost in 2023 on this model.');
  }

  console.log('\n── BEST 5-YEAR NET ──');
  if (best5yr) {
    console.log(`  ${best5yr.id}: ${best5yr.name} → ${best5yr.totalNet} (2023: ${best5yr.net2023})`);
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
    ? STRATEGY_FOUR_SCENARIOS.filter((s) => filterIds.includes(s.id))
    : STRATEGY_FOUR_SCENARIOS;

  const results = [];
  for (const scenario of scenarioList) {
    process.stdout.write(`  ${scenario.id}...`);
    const r = runScenario(scenario, allRows);
    results.push(r);
    console.log(` 2023=${r.net2023} 5yr=${r.totalNet}`);
  }

  const ranked = printReport(results);
  const jsonPath = path.join(__dirname, 'strategy4-multiyear-report.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        years: YEARS,
        results,
        rankedIds: ranked.map((r) => r.id),
        best2023Id: ranked.filter((r) => r.net2023 > 0).sort((a, b) => b.net2023 - a.net2023)[0]?.id || null,
        best5yrId: [...ranked].sort((a, b) => b.totalNet - a.totalNet)[0]?.id || null,
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

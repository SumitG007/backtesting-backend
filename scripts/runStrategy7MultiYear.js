/**
 * Strategy 7 — all scenarios × 2022–2026, rank by monthly performance (not per-year).
 *
 *   npm run scenarios:s7
 *   npm run scenarios:s7 -- --api
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runDailyPatternBacktest } = require('../src/strategies/strategy7/dailyPatternBacktest');
const { STRATEGY_SEVEN_SCENARIOS } = require('../src/strategies/strategy7/scenarios');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades, countExits } = require('./lib/multiYearMonthlyStats');

const YEARS = DEFAULT_YEARS;
const SYMBOL = 'NIFTY';
const INTERVAL = '5';

function pad(s, n) {
  return String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length);
}

function runScenario(scenario, allRows) {
  const settings = { ...scenario.settings, symbol: SYMBOL, interval: INTERVAL };
  const out = runDailyPatternBacktest({ execCandles: allRows, settings });
  const trades = out.trades || [];
  const totalNet = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const monthly = analyzeTrades(trades, SYMBOL);

  const byYear = {};
  for (const t of trades) {
    const y = String(t.entryTime).slice(0, 4);
    if (!byYear[y]) byYear[y] = { net: 0, trades: 0, wins: 0 };
    byYear[y].net += Number(t.pnl) || 0;
    byYear[y].trades += 1;
    if (Number(t.pnl) > 0) byYear[y].wins += 1;
  }

  return {
    id: scenario.id,
    name: scenario.name,
    patternMode: settings.patternMode || 'combined',
    sl: settings.stopLossPoints,
    tg: settings.targetProfitPoints,
    totalTrades: trades.length,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    monthly,
    byYear,
    exits: countExits(trades),
    meta: out.meta,
  };
}

function printReport(results) {
  const ranked = [...results].sort((a, b) => {
    if (b.monthly.months5k !== a.monthly.months5k) return b.monthly.months5k - a.monthly.months5k;
    if (b.monthly.positiveMonths !== a.monthly.positiveMonths) {
      return b.monthly.positiveMonths - a.monthly.positiveMonths;
    }
    return b.totalNet - a.totalNet;
  });

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 7 — MULTI-YEAR (2022–2026) — MONTHLY GOAL FOCUS');
  console.log(' Simulated CE/PE premiums · 1 trade/day · data-mined patterns');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log(
    'Rank | ID  | Mo>=5k | Mo>0  | AvgMoNet | 5yr Net  | Trades | WR%   | Tgt | Stp | Mode'
  );
  console.log(
    '-----|-----|--------|-------|----------|----------|--------|-------|-----|-----|----------'
  );

  ranked.forEach((r, i) => {
    const m = r.monthly;
    const mark = r.totalNet > 0 ? ' ' : '*';
    console.log(
      `${mark}${String(i + 1).padStart(3)} | ${r.id} | ${String(m.months5k).padStart(2)}/${m.totalMonths}  | ${String(m.positiveMonths).padStart(2)}/${m.totalMonths}  | ${String(m.avgMonthlyNet).padStart(8)} | ${String(r.totalNet).padStart(8)} | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.exits.TARGET).padStart(3)} | ${String(r.exits.STOP_LOSS).padStart(3)} | ${pad(r.patternMode, 10)}`
    );
  });

  const best = ranked[0];
  if (best) {
    console.log('\n── BEST SCENARIO ──');
    console.log(`${best.id}: ${best.name}`);
    console.log(`5yr net ${best.totalNet} | months >=5k: ${best.monthly.months5k}/${best.monthly.totalMonths}`);
    console.log('Year breakdown (info only — goal is all months):');
    for (const y of YEARS) {
      const yr = best.byYear[y] || { net: 0, trades: 0, wins: 0 };
      const wr = yr.trades ? ((yr.wins / yr.trades) * 100).toFixed(1) : '0';
      console.log(`  ${y}: net=${Number(yr.net).toFixed(0)} trades=${yr.trades} wr=${wr}%`);
    }
    console.log('\nMonths with net < 0:');
    const bad = best.monthly.months.filter((m) => m.net < 0);
    if (!bad.length) console.log('  (none)');
    else bad.forEach((m) => console.log(`  ${m.month}: ${m.net} (${m.trades} trades)`));
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

  const results = [];
  for (const scenario of STRATEGY_SEVEN_SCENARIOS) {
    process.stdout.write(`  ${scenario.id} ${scenario.name}...`);
    const r = runScenario(scenario, allRows);
    results.push(r);
    console.log(
      ` net=${r.totalNet} mo>=5k=${r.monthly.months5k}/${r.monthly.totalMonths} mo>0=${r.monthly.positiveMonths}`
    );
  }

  const ranked = printReport(results);

  const outDir = path.join(__dirname);
  const jsonPath = path.join(outDir, 'strategy7-multiyear-report.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        years: YEARS,
        symbol: SYMBOL,
        interval: INTERVAL,
        results,
        rankedIds: ranked.map((r) => r.id),
        recommendedId: ranked[0]?.id || null,
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

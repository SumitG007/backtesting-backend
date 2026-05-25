/**
 * Strategy 5 (Kukki V2) — multi-year scenario matrix (2022–2026).
 * Primary rank: calendar months with net PnL > 0 (monthly green), then >=5k/mo, then years green.
 *
 *   npm run scenarios:s5
 *   SCENARIO_IDS=E01,Z01,Z02 npm run scenarios:s5
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runKukkiV2Backtest } = require('../src/strategies/strategy7/kukkiV2Backtest');
const { STRATEGY_FIVE_KUKKI_SCENARIOS } = require('../src/strategies/strategy7/scenarios');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades, countExits } = require('./lib/multiYearMonthlyStats');
const { getIstClock } = require('../src/utils/dateTime');

const YEARS = DEFAULT_YEARS;
const SYMBOL = 'NIFTY';
const INTERVAL = '5';
const WEAK_YEARS = ['2023', '2024', '2025'];

function yearFromTrade(t) {
  return getIstClock(t.entryTime).dateKey.slice(0, 4);
}

function summarizeByYear(trades) {
  const byYear = {};
  for (const y of YEARS) {
    byYear[y] = { net: 0, trades: 0, wins: 0, ce: 0, pe: 0 };
  }
  for (const t of trades) {
    const y = yearFromTrade(t);
    if (!byYear[y]) continue;
    const pnl = Number(t.pnl) || 0;
    byYear[y].net += pnl;
    byYear[y].trades += 1;
    if (pnl > 0) byYear[y].wins += 1;
    if (String(t.type) === 'CE') byYear[y].ce += 1;
    if (String(t.type) === 'PE') byYear[y].pe += 1;
  }
  for (const y of YEARS) {
    byYear[y].net = Number(byYear[y].net.toFixed(2));
    byYear[y].winRate =
      byYear[y].trades > 0 ? Number(((byYear[y].wins / byYear[y].trades) * 100).toFixed(1)) : 0;
  }
  const greenYears = YEARS.filter((y) => (byYear[y]?.net || 0) > 0).length;
  const allYearsGreen = greenYears === YEARS.length;
  const weakNet = WEAK_YEARS.reduce((a, y) => a + (byYear[y]?.net || 0), 0);
  return { byYear, greenYears, allYearsGreen, weakNet: Number(weakNet.toFixed(2)) };
}

function runScenario(scenario, allRows) {
  const settings = { ...scenario.settings, symbol: SYMBOL, interval: INTERVAL };
  const out = runKukkiV2Backtest({ execCandles: allRows, settings });
  const trades = out.trades || [];
  const totalNet = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const monthly = analyzeTrades(trades, SYMBOL);
  const yearStats = summarizeByYear(trades);
  const ceTrades = trades.filter((t) => String(t.type) === 'CE').length;
  const peTrades = trades.filter((t) => String(t.type) === 'PE').length;
  const redMonths = monthly.months.filter((m) => m.net <= 0);

  return {
    id: scenario.id,
    name: scenario.name,
    sl: settings.stopLossPoints,
    tg: settings.targetProfitPoints,
    entryFrom: settings.entryFromTime,
    entryTo: settings.entryToTime,
    maxTradesPerDay: settings.maxTradesPerDay,
    minAdx: settings.minAdx,
    totalTrades: trades.length,
    ceTrades,
    peTrades,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    monthly,
    redMonthCount: redMonths.length,
    redMonths: redMonths.map((m) => ({ month: m.month, net: m.net })),
    exits: countExits(trades),
    ...yearStats,
  };
}

function compareResults(a, b) {
  const aAllMo = a.monthly.positiveMonths === a.monthly.totalMonths;
  const bAllMo = b.monthly.positiveMonths === b.monthly.totalMonths;
  if (aAllMo !== bAllMo) return aAllMo ? -1 : 1;
  if (b.monthly.positiveMonths !== a.monthly.positiveMonths) {
    return b.monthly.positiveMonths - a.monthly.positiveMonths;
  }
  if (b.monthly.months5k !== a.monthly.months5k) return b.monthly.months5k - a.monthly.months5k;
  if (a.allYearsGreen !== b.allYearsGreen) return a.allYearsGreen ? -1 : 1;
  if (b.greenYears !== a.greenYears) return b.greenYears - a.greenYears;
  if (b.totalNet !== a.totalNet) return b.totalNet - a.totalNet;
  return b.winRate - a.winRate;
}

function printReport(results) {
  const ranked = [...results].sort(compareResults);
  const allMonthsGreen = ranked.filter(
    (r) => r.monthly.positiveMonths === r.monthly.totalMonths && r.monthly.totalMonths > 0
  );
  const allGreenYears = ranked.filter((r) => r.allYearsGreen);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 5 — MONTHLY GREEN FIRST (net PnL > 0 each calendar month)');
  console.log(' Rank: green months → months >=5k → all years green → 5yr net');
  console.log('══════════════════════════════════════════════════════════════\n');
  console.log(`Scenarios run: ${results.length}`);
  console.log(
    `All months green: ${allMonthsGreen.length} (max possible ~${ranked[0]?.monthly.totalMonths || '?'} trading months)`
  );
  console.log(`All 5 years green: ${allGreenYears.length}\n`);

  console.log(
    'Rank | ID   | Mo+  | Mo>=5k | Yrs+ | 5yr Net  | Trades | SL | TG   | Max/d | Entry'
  );
  console.log(
    '-----|------|------|--------|------|----------|--------|----|------|-------|-------'
  );

  ranked.slice(0, 25).forEach((r, i) => {
    const m = r.monthly;
    const mark = r.monthly.positiveMonths === m.totalMonths ? '+' : ' ';
    const entry = `${r.entryFrom || '?'}-${r.entryTo || '?'}`;
    console.log(
      `${mark}${String(i + 1).padStart(3)} | ${r.id.padEnd(4)} | ${String(m.positiveMonths).padStart(2)}/${String(m.totalMonths).padEnd(2)} | ${String(m.months5k).padStart(2)}/${String(m.totalMonths).padEnd(2)}  | ${String(r.greenYears).padStart(2)}/5 | ${String(r.totalNet).padStart(8)} | ${String(r.totalTrades).padStart(6)} | ${String(r.sl).padStart(2)} | ${String(r.tg).padStart(4)} | ${String(r.maxTradesPerDay).padStart(5)} | ${entry}`
    );
  });
  if (ranked.length > 25) console.log(`  ... ${ranked.length - 25} more in JSON`);
  console.log('\n+ = every calendar month profitable\n');

  const b03 = ranked.find((r) => r.id === 'B03');
  const bestMo = ranked[0];
  console.log('── CURRENT B03 (your validation settings) ──');
  if (b03) {
    console.log(
      `  Green months ${b03.monthly.positiveMonths}/${b03.monthly.totalMonths} | 5yr ${b03.totalNet} | red months: ${b03.redMonthCount}`
    );
  }

  console.log('\n── BEST FOR MONTHLY GREEN ──');
  if (bestMo) {
    console.log(`  ${bestMo.id}: ${bestMo.name}`);
    console.log(
      `  Green months ${bestMo.monthly.positiveMonths}/${bestMo.monthly.totalMonths} | >=5k: ${bestMo.monthly.months5k} | 5yr ${bestMo.totalNet} | years ${bestMo.greenYears}/5`
    );
    console.log('  Still-red months (worst 8):');
    const worst = [...bestMo.redMonths].sort((a, b) => a.net - b.net).slice(0, 8);
    worst.forEach((m) => console.log(`    ${m.month}: Rs ${m.net}`));
  }

  const bestBoth = ranked.find((r) => r.allYearsGreen && r.monthly.positiveMonths >= (bestMo?.monthly.positiveMonths || 0));
  console.log('\n── BEST: monthly green + all years green ──');
  if (bestBoth) {
    console.log(`  ${bestBoth.id}: ${bestBoth.name} (${bestBoth.monthly.positiveMonths}/${bestBoth.monthly.totalMonths} months)`);
  }

  return { ranked, allMonthsGreen, bestMo, b03 };
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
    ? STRATEGY_FIVE_KUKKI_SCENARIOS.filter((s) => filterIds.includes(s.id))
    : STRATEGY_FIVE_KUKKI_SCENARIOS;
  if (!scenarioList.length) throw new Error('No scenarios match SCENARIO_IDS');

  console.log(`Running ${scenarioList.length} scenarios...\n`);
  const results = [];
  for (const scenario of scenarioList) {
    process.stdout.write(`  ${scenario.id}...`);
    const r = runScenario(scenario, allRows);
    results.push(r);
    console.log(` mo+${r.monthly.positiveMonths}/${r.monthly.totalMonths} 5yr=${r.totalNet}`);
  }

  const { ranked, bestMo, b03 } = printReport(results);

  const jsonPath = path.join(__dirname, 'strategy5-kukki-scenario-report.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rankingGoal: 'monthly_green_first',
        years: YEARS,
        scenarioCount: results.length,
        allMonthsGreenCount: ranked.filter(
          (r) => r.monthly.positiveMonths === r.monthly.totalMonths
        ).length,
        recommendedMonthlyId: bestMo?.id || null,
        recommendedMonthlyAndYearsId:
          ranked.find(
            (r) =>
              r.allYearsGreen &&
              r.monthly.positiveMonths === ranked[0]?.monthly.positiveMonths
          )?.id || null,
        b03MonthlyGreen: b03?.monthly.positiveMonths,
        results,
        rankedIds: ranked.map((r) => r.id),
      },
      null,
      2
    )
  );
  console.log(`\nFull JSON: ${jsonPath}`);
  if (bestMo) {
    console.log(`\nPick for monthly goal: ${bestMo.id} — SL${bestMo.sl} TG${bestMo.tg} ${bestMo.entryFrom}–${bestMo.entryTo} max${bestMo.maxTradesPerDay}/day`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

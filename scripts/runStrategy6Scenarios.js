/**
 * Run Strategy 6 scenario matrix (in-process, no DB).
 * Monthly goal: net PnL >= avg invested (1 lot) per calendar month.
 *
 * Usage (backend running for candle cache):
 *   node scripts/runStrategy6Scenarios.js
 *
 * Optional: SCENARIO_API=http://localhost:3001/api
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runRisingWedgeBacktest } = require('../src/strategies/strategy6/risingWedgeBacktest');
const { STRATEGY_SIX_SCENARIOS } = require('../src/strategies/strategy6/scenarios');
const { getLotSize } = require('../src/utils/market');

const BASE = process.env.SCENARIO_API || 'http://localhost:3001/api';
const YEARS = [2022, 2023, 2024, 2025, 2026];
const SYMBOL = 'NIFTY';
const INTERVAL = '5';

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function analyzeTrades(trades) {
  const byMonth = new Map();
  let totalInvested = 0;
  let investedCount = 0;

  for (const t of trades) {
    const mk = monthKey(t.entryTime);
    if (!byMonth.has(mk)) {
      byMonth.set(mk, { net: 0, trades: 0, invested: 0, wins: 0, targets: 0, stops: 0 });
    }
    const m = byMonth.get(mk);
    const pnl = Number(t.pnl) || 0;
    const inv = Number(t.invested ?? t.investmentAmount) || 0;
    m.net += pnl;
    m.trades += 1;
    if (inv > 0) {
      m.invested += inv;
      totalInvested += inv;
      investedCount += 1;
    }
    if (pnl > 0) m.wins += 1;
    const r = String(t.reason || '');
    if (r === 'TARGET') m.targets += 1;
    if (r === 'STOP_LOSS') m.stops += 1;
  }

  const months = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, m]) => {
      const avgInvested = m.trades > 0 ? m.invested / m.trades : 0;
      const lotThreshold = avgInvested > 0 ? avgInvested : 120 * getLotSize(SYMBOL);
      const meetsGoal = m.net >= lotThreshold;
      const meets5k = m.net >= 5000;
      const meets10k = m.net >= 10000;
      return {
        month: key,
        net: Number(m.net.toFixed(2)),
        trades: m.trades,
        avgInvested: Number(avgInvested.toFixed(2)),
        lotThreshold: Number(lotThreshold.toFixed(2)),
        meetsGoal,
        meets5k,
        meets10k,
        winRate: m.trades ? Number(((m.wins / m.trades) * 100).toFixed(1)) : 0,
        targets: m.targets,
        stops: m.stops,
      };
    });

  const greenMonths = months.filter((m) => m.meetsGoal).length;
  const months5k = months.filter((m) => m.meets5k).length;
  const months10k = months.filter((m) => m.meets10k).length;
  const avgMonthlyNet =
    months.length > 0 ? months.reduce((a, m) => a + m.net, 0) / months.length : 0;
  const worstMonth = months.length
    ? months.reduce((w, m) => (m.net < w.net ? m : w), months[0])
    : null;

  return {
    months,
    greenMonths,
    months5k,
    months10k,
    totalMonths: months.length,
    greenMonthPct: months.length ? Number(((greenMonths / months.length) * 100).toFixed(1)) : 0,
    pct5k: months.length ? Number(((months5k / months.length) * 100).toFixed(1)) : 0,
    avgMonthlyNet: Number(avgMonthlyNet.toFixed(2)),
    worstMonth,
    avgInvestedPerTrade: investedCount ? Number((totalInvested / investedCount).toFixed(2)) : 0,
  };
}

function countExits(trades) {
  const exits = { TARGET: 0, STOP_LOSS: 0, DAY_CLOSE: 0, OTHER: 0 };
  for (const t of trades) {
    const r = String(t.reason || 'OTHER');
    if (exits[r] != null) exits[r] += 1;
    else exits.OTHER += 1;
  }
  return exits;
}

async function loadYearCandles(year) {
  const pageSize = 1000;
  let page = 1;
  let totalPages = 1;
  const rows = [];
  while (page <= totalPages) {
    const { data } = await axios.get(`${BASE}/data/candles`, {
      params: { symbol: SYMBOL, interval: INTERVAL, year, page, pageSize },
      timeout: 120000,
    });
    if (!data.ok) throw new Error(data.error || `candles failed ${year}`);
    rows.push(...(data.data?.candles || []));
    totalPages = data.pagination?.totalPages || 1;
    page += 1;
  }
  return rows;
}

function runScenarioOnYears(scenario, candleByYear) {
  const yearResults = [];
  const allTrades = [];

  for (const year of YEARS) {
    const settings = { ...scenario.settings, symbol: SYMBOL, year, interval: INTERVAL };
    const out = runRisingWedgeBacktest({
      execCandles: candleByYear[year],
      settings,
    });
    yearResults.push({
      year,
      summary: out.summary,
      meta: out.meta,
      exits: countExits(out.trades),
    });
    allTrades.push(...out.trades);
  }

  const totalNet = allTrades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const monthly = analyzeTrades(allTrades);
  const totalTrades = allTrades.length;
  const wins = allTrades.filter((t) => Number(t.pnl) > 0).length;

  return {
    id: scenario.id,
    name: scenario.name,
    sl: scenario.settings.stopLossPoints,
    tg: scenario.settings.targetProfitPoints,
    signalMode: scenario.settings.signalMode || 'wedge',
    maxTradesPerDay: scenario.settings.maxTradesPerDay,
    yearResults,
    totalTrades,
    winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    monthly,
    exits: countExits(allTrades),
  };
}

function printReport(results) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 6 — HONEST SCENARIO REPORT');
  console.log(' PE premium direction fixed · 1 trade/day enforced · simulated premiums');
  console.log(' Goals: >=5k/mo | >=10k/mo | >=avg invested/mo | 5yr net (target ~3L+)');
  console.log('══════════════════════════════════════════════════════════════\n');

  const profitable = results.filter((r) => r.totalNet > 0);
  console.log(`Profitable over 5 years: ${profitable.length} / ${results.length} scenarios\n`);

  const ranked = [...results].sort((a, b) => {
    if (b.monthly.months5k !== a.monthly.months5k) return b.monthly.months5k - a.monthly.months5k;
    if (b.monthly.greenMonths !== a.monthly.greenMonths) return b.monthly.greenMonths - a.monthly.greenMonths;
    if (b.totalNet !== a.totalNet) return b.totalNet - a.totalNet;
    return b.winRate - a.winRate;
  });

  console.log(
    'Rank | ID  | >=5k | >=Inv | 5yr Net  | Trades | WR%   | Tgt | Stp | SL | TG  | Mode      | Name'
  );
  console.log(
    '-----|-----|------|-------|----------|--------|-------|-----|-----|----|-----|-----------|-----'
  );

  ranked.forEach((r, i) => {
    const m = r.monthly;
    const mark = r.totalNet > 0 ? ' ' : '*';
    console.log(
      `${mark}${String(i + 1).padStart(3)} | ${r.id} | ${String(m.months5k).padStart(2)}/${String(m.totalMonths).padEnd(2)} | ${String(m.greenMonths).padStart(2)}/${String(m.totalMonths).padEnd(2)} | ${String(r.totalNet).padStart(8)} | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.exits.TARGET).padStart(3)} | ${String(r.exits.STOP_LOSS).padStart(3)} | ${String(r.sl).padStart(2)} | ${String(r.tg).padStart(3)} | ${String(r.signalMode).padEnd(9)} | ${r.name}`
    );
  });
  console.log('* = 5-year net loss (honest)\n');

  const best = ranked[0];
  if (best) {
    console.log('\n── TOP SCENARIO DETAIL ──');
    console.log(`${best.id}: ${best.name}`);
    console.log(`Exits: TARGET=${best.exits.TARGET} STOP=${best.exits.STOP_LOSS} DAY_CLOSE=${best.exits.DAY_CLOSE}`);
    console.log('Per year:');
    for (const y of best.yearResults) {
      console.log(
        `  ${y.year}: net=${Number(y.summary.netPnl).toFixed(0)} trades=${y.summary.totalTrades} wr=${y.summary.winRate}%`
      );
    }
    console.log('Months NOT meeting 1-lot goal:');
    const bad = best.monthly.months.filter((m) => !m.meetsGoal);
    if (!bad.length) console.log('  (all months met goal)');
    else bad.forEach((m) => console.log(`  ${m.month}: net=${m.net} need>=${m.lotThreshold} (${m.trades} trades)`));
  }

  const bestProfit = ranked.filter((r) => r.totalNet > 0)[0];
  console.log('\n── BEST WITH 5-YEAR PROFIT ──');
  if (bestProfit) {
    console.log(`  ${bestProfit.id}: ${bestProfit.name}`);
    console.log(`  Net ${bestProfit.totalNet} | Green months ${bestProfit.monthly.greenMonths}/${bestProfit.monthly.totalMonths}`);
  } else {
    console.log('  None — all scenarios lost over 2022–2026 on this model. Use least-bad for tuning only.');
  }

  const bestMonthly = [...ranked].sort((a, b) => b.monthly.greenMonths - a.monthly.greenMonths)[0];
  return { ranked, best: bestMonthly, bestProfit };
}

async function main() {
  try {
    await axios.get(`${BASE}/health`, { timeout: 5000 });
  } catch {
    throw new Error(`Backend not reachable at ${BASE} — run: npm run dev`);
  }

  console.log(`Loading ${SYMBOL} ${INTERVAL}m candles for ${YEARS.join(', ')}...`);
  const candleByYear = {};
  for (const year of YEARS) {
    console.log(`  ${year}...`);
    candleByYear[year] = await loadYearCandles(year);
    console.log(`    ${candleByYear[year].length} bars`);
  }

  const filterIds = process.env.SCENARIO_IDS
    ? process.env.SCENARIO_IDS.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const scenarioList = filterIds
    ? STRATEGY_SIX_SCENARIOS.filter((s) => filterIds.includes(s.id))
    : STRATEGY_SIX_SCENARIOS;
  if (!scenarioList.length) throw new Error('No scenarios match SCENARIO_IDS');

  console.log(`\nRunning ${scenarioList.length} scenarios...`);
  const results = [];
  for (const scenario of scenarioList) {
    process.stdout.write(`  ${scenario.id} ${scenario.name}...`);
    const r = runScenarioOnYears(scenario, candleByYear);
    results.push(r);
    console.log(
      ` net=${r.totalNet} >=5k=${r.monthly.months5k}/${r.monthly.totalMonths} green=${r.monthly.greenMonths}`
    );
  }

  const { bestProfit } = printReport(results);

  const outDir = path.join(__dirname);
  const jsonPath = path.join(outDir, 'strategy6-scenario-report.json');
  const report = {
    generatedAt: new Date().toISOString(),
    modelNote: 'Simulated PE premiums; 1 trade/day; PE direction fix applied',
    results,
    recommendedId: bestProfit?.id || null,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nFull JSON: ${jsonPath}`);

  if (bestProfit) {
    const { setProductionScenarioId } = require('../src/strategies/strategy6/scenarios');
    setProductionScenarioId(bestProfit.id);
    console.log(`\nSuggested production scenario: ${bestProfit.id} (apply to catalog manually if you agree)`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

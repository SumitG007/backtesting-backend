/**
 * Matrix test via running backend (uses in-memory Dhan token + cache).
 * Usage: npm run dev  (then) node scripts/runCatalogMatrixViaApi.js
 */
const axios = require('axios');
const { getLotSize } = require('../src/utils/market');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const YEARS = [2022, 2023, 2024, 2025, 2026];
const STRATEGY_IDS = [6];

function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthlyFromTrades(trades, lotTarget) {
  const byMonth = new Map();
  for (const t of trades || []) {
    const mk = monthKey(t.entryTime);
    byMonth.set(mk, (byMonth.get(mk) || 0) + (Number(t.pnl) || 0));
  }
  let greenMonths = 0;
  const rows = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, net] of rows) {
    if (net >= lotTarget) greenMonths += 1;
  }
  return { rows, greenMonths, totalMonths: rows.length };
}

async function fetchAllTrades(strategyId, runId, totalRows) {
  const pageSize = 500;
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));
  const all = [];
  for (let page = 1; page <= pages; page += 1) {
    const { data } = await axios.get(`${BASE}/strategy${strategyId}/runs/${runId}/trades`, {
      params: { page, pageSize },
      timeout: 120000,
    });
    if (!data.ok) break;
    all.push(...(data.trades || []));
  }
  return all;
}

async function runCell(strategyId, year) {
  const { data } = await axios.post(
    `${BASE}/strategy${strategyId}/run`,
    { year, symbol: 'NIFTY' },
    { timeout: 300000 }
  );
  if (!data.ok) throw new Error(data.error || 'run failed');
  const totalRows = data.pagination?.totalRows || data.trades?.length || 0;
  const trades =
    totalRows > (data.trades?.length || 0)
      ? await fetchAllTrades(strategyId, data.runId, totalRows)
      : data.trades || [];
  return { summary: data.summary, trades, totalRows };
}

async function main() {
  try {
    await axios.get(`${BASE}/health`, { timeout: 5000 });
  } catch {
    throw new Error(`Backend not reachable at ${BASE} — start with npm run dev`);
  }

  const lotSize = getLotSize('NIFTY');
  const lotTarget = Math.round(120 * lotSize);

  const results = [];
  for (const id of STRATEGY_IDS) {
    console.log(`\n=== Strategy ${id} ===`);
    let totalNet = 0;
    let profitableYears = 0;
    let totalGreenMonths = 0;
    let totalMonths = 0;

    for (const year of YEARS) {
      try {
        const { summary: s, trades, totalRows } = await runCell(id, year);
        const net = Number(s.netPnl) || 0;
        const profitable = net > 0;
        if (profitable) profitableYears += 1;
        totalNet += net;

        const monthly = monthlyFromTrades(trades, lotTarget);
        totalGreenMonths += monthly.greenMonths;
        totalMonths += monthly.totalMonths;

        results.push({
          id,
          year,
          trades: s.totalTrades,
          winRate: s.winRate,
          netPnl: Number(net.toFixed(2)),
          profitable,
          greenMonths: monthly.greenMonths,
          months: monthly.totalMonths,
          tradeRowsReturned: trades.length,
          totalTradeRows: totalRows,
        });

        const mark = profitable ? '+' : net === 0 && s.totalTrades === 0 ? '0' : '-';
        const mo = monthly.totalMonths
          ? ` | months≥1lot: ${monthly.greenMonths}/${monthly.totalMonths}`
          : '';
        console.log(
          `  ${year}: ${mark} trades=${String(s.totalTrades).padStart(4)} wr=${String(s.winRate).padStart(5)}% net=${net.toFixed(0).padStart(8)}${mo}`
        );
      } catch (err) {
        const msg = err.response?.data?.error || err.message;
        console.log(`  ${year}: ERROR ${msg}`);
        results.push({ id, year, error: msg });
      }
    }
    console.log(
      `  5yr net: ${totalNet.toFixed(2)} | green years: ${profitableYears}/5 | months≥₹${lotTarget}: ${totalGreenMonths}/${totalMonths}`
    );
  }

  console.log(`\n(1-lot month target ≈ ₹${lotTarget} net PnL per month, from ~120 premium pts × ${lotSize} qty)`);

  console.log('\n========== RANKED BY 5-YEAR NET ==========');
  const byId = new Map();
  for (const r of results) {
    if (r.error) continue;
    if (!byId.has(r.id)) byId.set(r.id, { total: 0, prof: 0, months: 0, greenM: 0 });
    const b = byId.get(r.id);
    b.total += r.netPnl;
    if (r.profitable) b.prof += 1;
    b.months += r.months || 0;
    b.greenM += r.greenMonths || 0;
  }
  [...byId.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([id, b]) => {
      const tag = b.total > 0 ? 'PROFITABLE 5yr' : b.greenM > 0 ? 'some green months' : 'loss / flat';
      console.log(
        `S${id}: net=${b.total.toFixed(0)} | years+ ${b.prof}/5 | months≥1lot ${b.greenM}/${b.months} — ${tag}`
      );
    });

  console.log('\n========== READY FOR EXTRA CHECKS (toggle in catalog defaults) ==========');
  console.log('requireTrendFilter, requireRsiFilter, requireBbSqueeze, requireMaCross, requireHistogramExpand');
  console.log('Enable ONE at a time on strategies that are already net green.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

/**
 * Strategy 6 — sweep stack modes & SL/TG for monthly profitability (2022–2026).
 *
 *   npm run scenarios:s6
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runMorningPatternBacktest } = require('../src/strategies/strategy10/morningPatternBacktest');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades, countExits } = require('./lib/multiYearMonthlyStats');
const { getLotSize, getStrikeStep } = require('../src/utils/market');

const SYMBOL = 'NIFTY';
const INTERVAL = '5';

const STACK_MODES = [
  'full',
  'strict',
  'orb_only',
  'orb_pdl',
  'orb_high_only',
  'orb_low_only',
  'pdl_only',
];

const SL_TG_COMBOS = [
  { sl: 10, tg: 15 },
  { sl: 10, tg: 20 },
  { sl: 12, tg: 18 },
  { sl: 15, tg: 20 },
  { sl: 15, tg: 25 },
  { sl: 8, tg: 12 },
];

function buildScenarios() {
  const out = [];
  let n = 0;
  for (const stackMode of STACK_MODES) {
    for (const { sl, tg } of SL_TG_COMBOS) {
      n += 1;
      out.push({
        id: `S${String(n).padStart(2, '0')}`,
        name: `${stackMode} SL${sl}/TG${tg}`,
        settings: {
          stackMode,
          stopLossPoints: sl,
          targetProfitPoints: tg,
        },
      });
    }
  }
  return out;
}

function runOne(scenario, allRows) {
  const settings = {
    symbol: SYMBOL,
    interval: INTERVAL,
    lotSize: getLotSize(SYMBOL),
    strikeStep: getStrikeStep(SYMBOL),
    lotCount: 10,
    basePremiumPct: 0.5,
    premiumLeverage: 8,
    perTradeCost: 100,
    stackMode: scenario.settings.stackMode,
    stopLossPoints: scenario.settings.stopLossPoints,
    targetProfitPoints: scenario.settings.targetProfitPoints,
  };

  const { trades, summary } = runMorningPatternBacktest({ candles: allRows, settings });
  const monthly = analyzeTrades(trades, SYMBOL);
  const exits = countExits(trades);
  const net = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);

  return {
    id: scenario.id,
    name: scenario.name,
    stackMode: scenario.settings.stackMode,
    sl: scenario.settings.stopLossPoints,
    tg: scenario.settings.targetProfitPoints,
    totalTrades: trades.length,
    skippedDays: summary.skippedDays,
    winRate: summary.winRate,
    netPnl: Number(net.toFixed(2)),
    positiveMonths: monthly.positiveMonths,
    totalMonths: monthly.totalMonths,
    pctPositive: monthly.pctPositive,
    greenMonths: monthly.greenMonths,
    pctGreen: monthly.totalMonths
      ? Number(((monthly.greenMonths / monthly.totalMonths) * 100).toFixed(1))
      : 0,
    avgMonthlyNet: monthly.avgMonthlyNet,
    worstMonth: monthly.worstMonth,
    bestMonth: monthly.bestMonth,
    exits: formatExit(exits),
    signalCounts: summary.signalCounts,
    monthlyScore: monthly.pctPositive * 0.6 + (summary.winRate || 0) * 0.2 + Math.min(100, (trades.length / 10)) * 0.2,
  };
}

function formatExit(exits) {
  return `T${exits.TARGET || 0}/S${exits.STOP_LOSS || 0}/E${exits.DAY_CLOSE || 0}`;
}

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

async function main() {
  console.log(`Strategy 6 scenario sweep — ${SYMBOL} ${INTERVAL}m ${DEFAULT_YEARS.join(', ')}`);
  const { allRows } = await loadCandlesMultiYear({
    symbol: SYMBOL,
    interval: INTERVAL,
    years: DEFAULT_YEARS,
  });

  const scenarios = buildScenarios();
  const results = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const s = scenarios[i];
    process.stdout.write(`  [${i + 1}/${scenarios.length}] ${s.name}...`);
    const t0 = Date.now();
    results.push(runOne(s, allRows));
    console.log(` ${Date.now() - t0}ms`);
  }
  results.sort((a, b) => {
    const m = b.pctPositive - a.pctPositive;
    if (m !== 0) return m;
    return b.netPnl - a.netPnl;
  });

  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(' STRATEGY 6 SCENARIO SWEEP — ranked by % positive months');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(`Scenarios: ${results.length} | Candles: ${allRows.length}`);
  lines.push('');
  lines.push('ID  | Stack mode      | SL/TG   | Trades | Win%  | +Months | Net PnL      | Worst month');
  for (const r of results.slice(0, 20)) {
    lines.push(
      `${pad(r.id, 4)}| ${pad(r.stackMode, 16)}| ${pad(`${r.sl}/${r.tg}`, 7)}| ${pad(r.totalTrades, 6)} | ${pad(r.winRate, 5)} | ${pad(`${r.positiveMonths}/${r.totalMonths} (${r.pctPositive}%)`, 16)} | ${pad(r.netPnl, 12)} | ${r.worstMonth?.month || '-'} ${r.worstMonth?.net ?? ''}`,
    );
  }
  lines.push('');
  const best = results[0];
  lines.push('★ RECOMMENDED (best positive-month %):');
  lines.push(`  ${best.name} — ${best.pctPositive}% positive months, ${best.totalTrades} trades, net ${best.netPnl}`);
  lines.push(`  stackMode=${best.stackMode} SL=${best.sl} TG=${best.tg}`);
  lines.push('');

  const bestNet = [...results].sort((a, b) => b.netPnl - a.netPnl)[0];
  lines.push('★ BEST NET PnL:');
  lines.push(`  ${bestNet.name} — net ${bestNet.netPnl}, ${bestNet.pctPositive}% positive months`);
  lines.push('');

  const outPath = path.join(__dirname, 'strategy6-scenario-sweep.json');
  const txtPath = path.join(__dirname, 'strategy6-scenario-sweep.txt');
  fs.writeFileSync(outPath, JSON.stringify({ scenarios: results, recommended: best, bestNet }, null, 2));
  fs.writeFileSync(txtPath, lines.join('\n'));

  console.log(lines.join('\n'));
  console.log(`JSON → ${outPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

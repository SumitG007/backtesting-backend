/**
 * Scalping strategy research — compare entry patterns + SL styles on cached NIFTY 5m data.
 *
 *   npm run research:scalping
 *   node scripts/runScalpingResearch.js
 *   SCENARIO_IDS=V02,O01 node scripts/runScalpingResearch.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runIntradaySignalBacktest } = require('../src/strategies/shared/intradayBacktestRunner');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { getLotSize, getStrikeStep } = require('../src/utils/market');
const { getIstClock } = require('../src/utils/dateTime');
const { makeFindSignal } = require('./lib/scalpingSignals');

const SYMBOL = 'NIFTY';
const INTERVAL = '5';
const YEARS = DEFAULT_YEARS;
const LOT_COUNT = 10;

const ENTRY_LABELS = {
  vwap_pullback: 'VWAP pullback',
  orb: 'Opening range breakout',
  ema_cross: '9/21 EMA cross + VWAP',
  vwap_ema_trend: 'VWAP + EMA trend',
};

const EXIT_LABELS = {
  prem: 'Premium pts SL/TG',
  spot: 'Spot structure SL/TG',
  struct_sl_prem_tg: 'Structure SL + premium TG',
  eod: 'Premium SL + EOD',
};

/** @type {Array<{id:string, entry:string, exit:string, sl:number, tg:number, name?:string}>} */
const SCENARIOS = [
  { id: 'V01', entry: 'vwap_pullback', exit: 'prem', sl: 12, tg: 18 },
  { id: 'V02', entry: 'vwap_pullback', exit: 'prem', sl: 15, tg: 22 },
  { id: 'V03', entry: 'vwap_pullback', exit: 'eod', sl: 15, tg: 0 },
  { id: 'V04', entry: 'vwap_pullback', exit: 'spot', sl: 0, tg: 0 },
  { id: 'V05', entry: 'vwap_pullback', exit: 'struct_sl_prem_tg', sl: 0, tg: 22 },
  { id: 'O01', entry: 'orb', exit: 'prem', sl: 15, tg: 22, minWarmup: 3 },
  { id: 'O02', entry: 'orb', exit: 'spot', sl: 0, tg: 0, minWarmup: 3 },
  { id: 'E01', entry: 'ema_cross', exit: 'prem', sl: 15, tg: 22 },
  { id: 'E02', entry: 'ema_cross', exit: 'spot', sl: 0, tg: 0 },
  { id: 'T01', entry: 'vwap_ema_trend', exit: 'prem', sl: 15, tg: 22 },
  { id: 'T02', entry: 'vwap_ema_trend', exit: 'spot', sl: 0, tg: 0 },
  { id: 'V06', entry: 'vwap_pullback', exit: 'prem', sl: 20, tg: 30 },
];

function buildSettings(scenario) {
  const exit = scenario.exit;
  const sl = Number(scenario.sl) || 0;
  const tg = Number(scenario.tg) || 0;

  let stopLossPoints = 0;
  let targetProfitPoints = 0;
  let usePatternExits = false;

  if (exit === 'prem' || exit === 'eod') {
    stopLossPoints = sl;
    targetProfitPoints = tg;
    usePatternExits = false;
  } else if (exit === 'spot') {
    stopLossPoints = 0;
    targetProfitPoints = 0;
    usePatternExits = true;
  } else if (exit === 'struct_sl_prem_tg') {
    stopLossPoints = 0;
    targetProfitPoints = tg;
    usePatternExits = true;
  }

  return {
    symbol: SYMBOL,
    interval: INTERVAL,
    lotSize: getLotSize(SYMBOL),
    strikeStep: getStrikeStep(SYMBOL),
    lotCount: LOT_COUNT,
    basePremiumPct: 0.5,
    premiumLeverage: 8,
    strikeMode: 'ATM',
    perTradeCost: 100,
    maxTradesPerDay: 6,
    minBarsBetweenTrades: 2,
    entryFromTime: scenario.entry === 'orb' ? '09:15' : '09:30',
    entryToTime: '14:30',
    stopLossPoints,
    targetProfitPoints,
    usePatternExits,
  };
}

function scenarioName(s) {
  if (s.name) return s.name;
  const entry = ENTRY_LABELS[s.entry] || s.entry;
  const exit = EXIT_LABELS[s.exit] || s.exit;
  const slTg =
    s.exit === 'spot' || s.exit === 'struct_sl_prem_tg'
      ? s.exit === 'struct_sl_prem_tg'
        ? `struct SL / TG ${s.tg}pts`
        : 'spot SL/TG'
      : `SL ${s.sl} / TG ${s.tg > 0 ? s.tg : 'EOD'}`;
  return `${entry} · ${slTg}`;
}

function countExits(trades) {
  const m = {};
  for (const t of trades) {
    const r = String(t.reason || 'UNKNOWN').toUpperCase();
    m[r] = (m[r] || 0) + 1;
  }
  return m;
}

function profitFactor(trades) {
  let grossWin = 0;
  let grossLoss = 0;
  for (const t of trades) {
    const p = Number(t.pnl) || 0;
    if (p > 0) grossWin += p;
    else grossLoss += Math.abs(p);
  }
  if (grossLoss === 0) return grossWin > 0 ? 99 : 0;
  return Number((grossWin / grossLoss).toFixed(2));
}

function maxDrawdown(trades) {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += Number(t.pnl) || 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return Number(maxDd.toFixed(2));
}

function analyzeByYear(trades) {
  const byYear = {};
  for (const t of trades) {
    const y = getIstClock(t.entryTime).dateKey.slice(0, 4);
    if (!byYear[y]) byYear[y] = { net: 0, trades: 0, wins: 0 };
    byYear[y].net += Number(t.pnl) || 0;
    byYear[y].trades += 1;
    if (Number(t.pnl) > 0) byYear[y].wins += 1;
  }
  for (const y of Object.keys(byYear)) {
    const row = byYear[y];
    row.net = Number(row.net.toFixed(2));
    row.winRate = row.trades ? Number(((row.wins / row.trades) * 100).toFixed(1)) : 0;
  }
  return byYear;
}

function runScenario(scenario, candles) {
  const settings = buildSettings(scenario);
  const findSignal = makeFindSignal(scenario.entry);
  const { trades, summary } = runIntradaySignalBacktest({
    execCandles: candles,
    settings,
    minWarmup: scenario.minWarmup ?? 25,
    findSignal,
  });

  const totalNet = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const ce = trades.filter((t) => String(t.type).toUpperCase() === 'CE').length;
  const pe = trades.filter((t) => String(t.type).toUpperCase() === 'PE').length;
  const exits = countExits(trades);
  const tradingDays = new Set(trades.map((t) => getIstClock(t.entryTime).dateKey)).size;
  const avgTradesPerDay = tradingDays ? Number((trades.length / tradingDays).toFixed(2)) : 0;

  return {
    id: scenario.id,
    name: scenarioName(scenario),
    entry: scenario.entry,
    exit: scenario.exit,
    sl: scenario.sl,
    tg: scenario.tg,
    totalTrades: trades.length,
    ceTrades: ce,
    peTrades: pe,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    profitFactor: profitFactor(trades),
    maxDrawdown: maxDrawdown(trades),
    avgPnlPerTrade: trades.length ? Number((totalNet / trades.length).toFixed(2)) : 0,
    avgTradesPerDay,
    exits,
    exitLabel: `T${exits.TARGET || 0}/S${exits.STOP_LOSS || 0}/P${exits.PATTERN_SL || 0}/E${exits.DAY_CLOSE || 0}`,
    byYear: analyzeByYear(trades),
    summary,
  };
}

function scoreResult(r) {
  // Favor net profit, then profit factor, then lower drawdown
  const pf = Math.min(r.profitFactor, 5);
  return r.totalNet + pf * 5000 - r.maxDrawdown * 0.3;
}

function printReport(results) {
  const ranked = [...results].sort((a, b) => scoreResult(b) - scoreResult(a));

  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(' SCALPING RESEARCH — NIFTY 5m — ENTRY × SL PATTERNS');
  console.log(` Years: ${YEARS.join(', ')} | Lots: ${LOT_COUNT} | Max 6 trades/day | 09:30–14:30`);
  console.log(' Ranked by composite score (net P/L + profit factor − drawdown)');
  console.log('══════════════════════════════════════════════════════════════════════════════\n');

  console.log(
    'Rank | ID  | Total Net   | Trades | WR%   | PF   | MaxDD    | Avg/Day | Exits(T/S/P/E)   | Scenario'
  );
  console.log(
    '-----|-----|-------------|--------|-------|------|----------|---------|------------------|--------'
  );

  ranked.forEach((r, i) => {
    const mark = r.totalNet > 0 ? ' ' : '*';
    console.log(
      `${mark}${String(i + 1).padStart(3)} | ${r.id} | ${String(r.totalNet).padStart(11)} | ${String(r.totalTrades).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.profitFactor).padStart(4)} | ${String(r.maxDrawdown).padStart(8)} | ${String(r.avgTradesPerDay).padStart(7)} | ${r.exitLabel.padEnd(16)} | ${r.name}`
    );
  });

  const best = ranked[0];
  const bestProfitable = ranked.find((r) => r.totalNet > 0);

  console.log('\n── Best overall (composite) ──');
  if (best) {
    console.log(`  ${best.id}: ${best.name}`);
    console.log(`  Net ₹${best.totalNet.toLocaleString('en-IN')} | WR ${best.winRate}% | PF ${best.profitFactor} | ${best.totalTrades} trades`);
    console.log(`  By year: ${JSON.stringify(best.byYear)}`);
  }

  console.log('\n── Best by entry type (highest net) ──');
  for (const entry of Object.keys(ENTRY_LABELS)) {
    const subset = ranked.filter((r) => r.entry === entry).sort((a, b) => b.totalNet - a.totalNet);
    const top = subset[0];
    if (top) {
      console.log(`  ${ENTRY_LABELS[entry]}: ${top.id} (${top.name}) → ₹${top.totalNet}`);
    }
  }

  console.log('\n── Best by exit style (highest net) ──');
  for (const exit of Object.keys(EXIT_LABELS)) {
    const subset = ranked.filter((r) => r.exit === exit).sort((a, b) => b.totalNet - a.totalNet);
    const top = subset[0];
    if (top) {
      console.log(`  ${EXIT_LABELS[exit]}: ${top.id} → ₹${top.totalNet} (${top.name})`);
    }
  }

  if (!bestProfitable) {
    console.log('\n⚠ No scenario was net profitable on full history. Pick least-bad for tuning, or tighten filters.');
  } else {
    console.log(`\n✓ Best net profitable: ${bestProfitable.id} — ${bestProfitable.name} (₹${bestProfitable.totalNet})`);
  }

  console.log('\n── Recommendation for backtest v1 ──');
  const pick = bestProfitable || best;
  if (pick) {
    console.log(`  Entry: ${ENTRY_LABELS[pick.entry]}`);
    console.log(`  Exit:  ${EXIT_LABELS[pick.exit] || pick.exit}${pick.sl ? ` (SL ${pick.sl} / TG ${pick.tg || 'EOD'})` : ''}`);
    console.log(`  Why:   Highest risk-adjusted score in this sweep on ${YEARS.length} years of NIFTY 5m cache.`);
  }
  console.log('');
}

async function main() {
  const filterIds = process.env.SCENARIO_IDS
    ? process.env.SCENARIO_IDS.split(',').map((s) => s.trim().toUpperCase())
    : null;

  let scenarios = SCENARIOS;
  if (filterIds?.length) {
    scenarios = SCENARIOS.filter((s) => filterIds.includes(s.id.toUpperCase()));
    if (!scenarios.length) throw new Error(`No scenarios match: ${filterIds.join(', ')}`);
  }

  console.log('Loading candles from disk cache…');
  const { allRows, source } = await loadCandlesMultiYear({
    symbol: SYMBOL,
    interval: INTERVAL,
    years: YEARS,
  });
  console.log(`Loaded ${allRows.length} candles (${source})`);

  const results = [];
  for (const scenario of scenarios) {
    process.stdout.write(`Running ${scenario.id} ${scenarioName(scenario)}… `);
    const r = runScenario(scenario, allRows);
    results.push(r);
    console.log(`₹${r.totalNet} | ${r.totalTrades} trades | WR ${r.winRate}%`);
  }

  printReport(results);

  const outPath = path.join(__dirname, 'scalping-research-report.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        interval: INTERVAL,
        years: YEARS,
        lotCount: LOT_COUNT,
        results: results.sort((a, b) => scoreResult(b) - scoreResult(a)),
      },
      null,
      2
    )
  );
  console.log(`Report saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

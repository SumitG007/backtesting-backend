/**
 * Strategy 3 — trade-level probability mining + filter scenarios.
 *
 *   npm run analyze:s3
 *   node scripts/runStrategy3ProbabilityAnalysis.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runSimple920Backtest } = require('../src/strategies/strategy7/simple920Backtest');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { getIstClock } = require('../src/utils/dateTime');
const { getLotSize, getStrikeStep } = require('../src/utils/market');
const {
  buildPutBuyFilterContext,
  evaluatePutBuyDirection,
  ALL_PE_SIGNALS,
  ALL_CE_SIGNALS,
} = require('../src/strategies/strategy7/putBuyDayFilters');
const { buildIntradayByDay } = require('../src/strategies/shared/intradayOptions');
const { countExits } = require('./lib/multiYearMonthlyStats');

const YEARS = DEFAULT_YEARS;
const SYMBOL = 'NIFTY';
const INTERVAL = '5';
const ENTRY_MINUTES = 675; // 11:15

const BASE_SETTINGS = {
  symbol: SYMBOL,
  interval: INTERVAL,
  entryTime: '11:15',
  strikeMode: 'ATM',
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 10,
  perTradeCost: 100,
  minDirectionScore: 2,
  stopLossPoints: 15,
  targetProfitPoints: 0, // EOD — matches production SL15 EOD report
  lotSize: getLotSize(SYMBOL),
  strikeStep: getStrikeStep(SYMBOL),
};

function yearFromTrade(t) {
  return getIstClock(t.entryTime).dateKey.slice(0, 4);
}

function dayKeyFromTrade(t) {
  return getIstClock(t.entryTime).dateKey;
}

function enrichTrades(trades, intraByDay, filterCtx) {
  const enriched = [];
  for (const t of trades) {
    const dayKey = dayKeyFromTrade(t);
    const dayBars = intraByDay.get(dayKey) || [];
    const decision = evaluatePutBuyDirection({
      dayKey,
      dayBars,
      filterCtx,
      entryDecisionMinutes: ENTRY_MINUTES,
      minDirectionScore: 1,
      enabledPeSignals: ALL_PE_SIGNALS,
      enabledCeSignals: ALL_CE_SIGNALS,
    });
    const pnl = Number(t.pnl) || 0;
    const reason = String(t.reason || '');
    enriched.push({
      ...t,
      dayKey,
      year: yearFromTrade(t),
      pnl,
      reason,
      win: pnl > 0,
      isSl: reason === 'STOP_LOSS',
      isEod: reason === 'DAY_CLOSE',
      optionType: String(t.type || '').toUpperCase(),
      peScore: decision.peScore ?? 0,
      ceScore: decision.ceScore ?? 0,
      directionScore: Math.max(decision.peScore ?? 0, decision.ceScore ?? 0),
      signals: decision.signals || [],
      signalKey: (decision.signals || []).slice().sort().join('+') || 'none',
    });
  }
  return enriched;
}

function statsFor(trades) {
  const n = trades.length;
  if (!n) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      slHits: 0,
      slRate: 0,
      net: 0,
      avgPnl: 0,
      expectancy: 0,
    };
  }
  const wins = trades.filter((t) => t.win).length;
  const slHits = trades.filter((t) => t.isSl).length;
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const grossWin = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  return {
    trades: n,
    wins,
    losses: n - wins,
    winRate: Number(((wins / n) * 100).toFixed(2)),
    slHits,
    slRate: Number(((slHits / n) * 100).toFixed(2)),
    net: Number(net.toFixed(2)),
    avgPnl: Number((net / n).toFixed(2)),
    expectancy: Number((net / n).toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
  };
}

function bucketStats(trades, keyFn, minN = 15) {
  const buckets = new Map();
  for (const t of trades) {
    const key = keyFn(t);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const rows = [];
  for (const [key, list] of buckets) {
    if (list.length < minN) continue;
    const s = statsFor(list);
    rows.push({
      key,
      n: list.length,
      winRate: s.winRate,
      slRate: s.slRate,
      net: s.net,
      avgPnl: s.avgPnl,
      profitFactor: s.profitFactor,
    });
  }
  return rows.sort((a, b) => b.avgPnl - a.avgPnl);
}

function signalWinRates(trades, minN = 20) {
  const signalIds = [...ALL_PE_SIGNALS, ...ALL_CE_SIGNALS];
  const rows = [];
  for (const sig of signalIds) {
    const withSig = trades.filter((t) => t.signals.includes(sig));
    const without = trades.filter((t) => !t.signals.includes(sig));
    if (withSig.length < minN) continue;
    const withS = statsFor(withSig);
    const withoutS = statsFor(without);
    rows.push({
      signal: sig,
      with: withS,
      without: withoutS,
      lift: Number((withS.winRate - withoutS.winRate).toFixed(2)),
      slLift: Number((withoutS.slRate - withS.slRate).toFixed(2)),
    });
  }
  return rows.sort((a, b) => b.lift - a.lift);
}

function applyFilter(trades, predicate) {
  return trades.filter(predicate);
}

const FILTER_SCENARIOS = [
  {
    id: 'BASE',
    name: 'Baseline (min score 2, current)',
    fn: () => true,
  },
  {
    id: 'SC3',
    name: 'Min direction score >= 3',
    fn: (t) => t.directionScore >= 3,
  },
  {
    id: 'SC4',
    name: 'Min direction score >= 4',
    fn: (t) => t.directionScore >= 4,
  },
  {
    id: 'ORB',
    name: 'ORB break only (orb_high or orb_low)',
    fn: (t) => t.signals.some((s) => s === 'orb_high_break' || s === 'orb_low_break'),
  },
  {
    id: 'PDLPDH',
    name: 'PDL/PDH break required for direction',
    fn: (t) =>
      (t.optionType === 'PE' && t.signals.includes('pdl_break')) ||
      (t.optionType === 'CE' && t.signals.includes('pdh_break')),
  },
  {
    id: 'GAP_HOLD',
    name: 'Gap hold signals only (gap_up_hold / gap_down_hold)',
    fn: (t) => t.signals.some((s) => s === 'gap_up_hold' || s === 'gap_down_hold'),
  },
  {
    id: 'NO_FADE',
    name: 'Exclude gap fade signals',
    fn: (t) => !t.signals.some((s) => s === 'gap_up_fade' || s === 'gap_down_fade'),
  },
  {
    id: 'SC3_ORB',
    name: 'Score>=3 AND ORB break',
    fn: (t) =>
      t.directionScore >= 3 &&
      t.signals.some((s) => s === 'orb_high_break' || s === 'orb_low_break'),
  },
  {
    id: 'SC3_PDLPDH',
    name: 'Score>=3 AND PDL/PDH break',
    fn: (t) =>
      t.directionScore >= 3 &&
      ((t.optionType === 'PE' && t.signals.includes('pdl_break')) ||
        (t.optionType === 'CE' && t.signals.includes('pdh_break'))),
  },
  {
    id: 'CORE',
    name: 'Core: score>=3, no fade, PDL/PDH or ORB',
    fn: (t) => {
      if (t.directionScore < 3) return false;
      if (t.signals.some((s) => s === 'gap_up_fade' || s === 'gap_down_fade')) return false;
      const hasBreak =
        t.signals.includes('pdl_break') ||
        t.signals.includes('pdh_break') ||
        t.signals.includes('orb_high_break') ||
        t.signals.includes('orb_low_break');
      return hasBreak;
    },
  },
  {
    id: 'PE_PDL',
    name: 'PE only when pdl_break; CE only when pdh_break',
    fn: (t) =>
      (t.optionType === 'PE' && t.signals.includes('pdl_break')) ||
      (t.optionType === 'CE' && t.signals.includes('pdh_break')),
  },
  {
    id: 'WR55',
    name: 'Signal combo historical WR>=55% (full-sample)',
    fn: null, // filled after mining
  },
  {
    id: 'WR60',
    name: 'Signal combo historical WR>=60% (full-sample)',
    fn: null,
  },
];

function buildComboLookup(trades, minWr) {
  const combos = bucketStats(trades, (t) => `${t.optionType}|${t.signalKey}`, 8);
  const allowed = new Set(
    combos.filter((c) => c.winRate >= minWr && c.n >= 15).map((c) => c.key.split('|')[1] ? c.key : c.key),
  );
  const allowedKeys = new Set();
  for (const c of combos) {
    if (c.winRate >= minWr && c.n >= 15) {
      allowedKeys.add(c.key);
    }
  }
  return (t) => allowedKeys.has(`${t.optionType}|${t.signalKey}`);
}

function walkForwardFilter(trades, minWr = 55, minN = 12) {
  /** Prior-year only: for each trade, use signal combo stats from strictly earlier years. */
  const kept = [];
  const history = [];
  const byYear = new Map();
  for (const t of trades) {
    const y = t.year;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(t);
  }
  const sortedYears = [...byYear.keys()].sort();
  for (const y of sortedYears) {
    const comboStats = bucketStats(history, (t) => `${t.optionType}|${t.signalKey}`, minN);
    const allowed = new Set(
      comboStats.filter((c) => c.winRate >= minWr).map((c) => c.key),
    );
    for (const t of byYear.get(y)) {
      const key = `${t.optionType}|${t.signalKey}`;
      if (allowed.has(key)) kept.push(t);
    }
    history.push(...byYear.get(y));
  }
  return kept;
}

function printTable(title, rows, baselineNet) {
  console.log(`\n── ${title} ──`);
  console.log('ID   | Trades | WR%   | SL%   | SL#  | Net PnL    | %Profit | PF   | Name');
  console.log('-----|--------|-------|-------|------|------------|---------|------|-----');
  for (const r of rows) {
    const pct = baselineNet ? Number(((r.net / baselineNet) * 100).toFixed(1)) : 100;
    const pf = r.profitFactor != null ? String(r.profitFactor).padStart(4) : '  - ';
    console.log(
      `${r.id.padEnd(4)} | ${String(r.trades).padStart(6)} | ${String(r.winRate).padStart(5)} | ${String(r.slRate).padStart(5)} | ${String(r.slHits).padStart(4)} | ${String(r.net).padStart(10)} | ${String(pct).padStart(6)}% | ${pf} | ${r.name}`,
    );
  }
}

function printSignalTable(rows) {
  console.log('\n── SIGNAL WIN-RATE LIFT (with signal vs without) ──');
  console.log('Signal          | With N | WR%  | SL%  | AvgPnL | Lift WR | SL reduction');
  console.log('----------------|--------|------|------|--------|---------|-------------');
  for (const r of rows.slice(0, 16)) {
    console.log(
      `${r.signal.padEnd(15)} | ${String(r.with.trades).padStart(6)} | ${String(r.with.winRate).padStart(4)} | ${String(r.with.slRate).padStart(4)} | ${String(r.with.avgPnl).padStart(6)} | ${String(r.lift).padStart(7)} | ${String(r.slLift).padStart(7)}`,
    );
  }
}

function printTopCombos(rows) {
  console.log('\n── TOP SIGNAL COMBOS (min 15 trades) ──');
  console.log('Combo (type|signals)                    | N  | WR%  | SL%  | Net      | AvgPnL');
  console.log('----------------------------------------|----|------|------|----------|-------');
  for (const r of rows.slice(0, 20)) {
    const label = r.key.length > 38 ? `${r.key.slice(0, 35)}...` : r.key;
    console.log(
      `${label.padEnd(39)} | ${String(r.n).padStart(2)} | ${String(r.winRate).padStart(4)} | ${String(r.slRate).padStart(4)} | ${String(r.net).padStart(8)} | ${String(r.avgPnl).padStart(6)}`,
    );
  }
  console.log('\n── WORST SIGNAL COMBOS (min 15 trades) ──');
  for (const r of rows.slice(-10).reverse()) {
    const label = r.key.length > 38 ? `${r.key.slice(0, 35)}...` : r.key;
    console.log(
      `${label.padEnd(39)} | ${String(r.n).padStart(2)} | ${String(r.winRate).padStart(4)} | ${String(r.slRate).padStart(4)} | ${String(r.net).padStart(8)} | ${String(r.avgPnl).padStart(6)}`,
    );
  }
}

async function main() {
  console.log(`Loading ${SYMBOL} ${INTERVAL}m ${YEARS.join(', ')}...`);
  const { allRows, source } = await loadCandlesMultiYear({
    symbol: SYMBOL,
    interval: INTERVAL,
    years: YEARS,
  });
  console.log(`Loaded ${allRows.length} bars (${source})`);

  const out = runSimple920Backtest({ candles: allRows, settings: BASE_SETTINGS });
  const intraByDay = buildIntradayByDay(allRows);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const filterCtx = buildPutBuyFilterContext(sortedKeys, intraByDay);
  const enriched = enrichTrades(out.trades || [], intraByDay, filterCtx);
  const baseline = statsFor(enriched);
  const exits = countExits(out.trades || []);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 3 — PROBABILITY / FILTER ANALYSIS');
  console.log(' SL15 EOD | 10 lots | Entry 11:15 | min score 2');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`\nBaseline: ${baseline.trades} trades | WR ${baseline.winRate}% | SL ${baseline.slHits} (${baseline.slRate}%)`);
  console.log(`Net: Rs ${baseline.net} | PF ${baseline.profitFactor} | Exits: T${exits.TARGET || 0}/S${exits.STOP_LOSS || 0}/E${exits.DAY_CLOSE || 0}`);

  for (const y of YEARS) {
    const yt = enriched.filter((t) => t.year === String(y));
    const ys = statsFor(yt);
    console.log(`  ${y}: ${ys.trades} trades WR ${ys.winRate}% SL ${ys.slHits} net Rs ${ys.net}`);
  }

  const signalRows = signalWinRates(enriched);
  printSignalTable(signalRows);

  const scoreBuckets = bucketStats(enriched, (t) => `score_${t.directionScore}`, 10);
  console.log('\n── DIRECTION SCORE BUCKETS ──');
  for (const r of scoreBuckets) {
    console.log(`  ${r.key}: n=${r.n} WR=${r.winRate}% SL=${r.slRate}% net=${r.net} avg=${r.avgPnl}`);
  }

  const typeBuckets = bucketStats(enriched, (t) => t.optionType, 10);
  console.log('\n── CE vs PE ──');
  for (const r of typeBuckets) {
    console.log(`  ${r.key}: n=${r.n} WR=${r.winRate}% SL=${r.slRate}% net=${r.net}`);
  }

  const combos = bucketStats(enriched, (t) => `${t.optionType}|${t.signalKey}`, 15);
  printTopCombos(combos);

  FILTER_SCENARIOS.find((s) => s.id === 'WR55').fn = buildComboLookup(enriched, 55);
  FILTER_SCENARIOS.find((s) => s.id === 'WR60').fn = buildComboLookup(enriched, 60);

  const scenarioResults = FILTER_SCENARIOS.map((sc) => {
    const filtered = applyFilter(enriched, sc.fn);
    const s = statsFor(filtered);
    return { id: sc.id, name: sc.name, ...s };
  });

  const wf55 = walkForwardFilter(enriched, 55, 12);
  const wf60 = walkForwardFilter(enriched, 60, 12);
  scenarioResults.push({
    id: 'WF55',
    name: 'Walk-forward: prior-year combo WR>=55%',
    ...statsFor(wf55),
  });
  scenarioResults.push({
    id: 'WF60',
    name: 'Walk-forward: prior-year combo WR>=60%',
    ...statsFor(wf60),
  });

  scenarioResults.sort((a, b) => {
    const scoreA = a.net / Math.max(1, a.slHits);
    const scoreB = b.net / Math.max(1, b.slHits);
    return scoreB - scoreA;
  });

  printTable('FILTER SCENARIOS (sorted by net/SL efficiency)', scenarioResults, baseline.net);

  const bestProfit = [...scenarioResults].sort((a, b) => b.net - a.net)[0];
  const bestEfficiency = scenarioResults[0];
  console.log('\n── RECOMMENDATIONS ──');
  console.log(`  Best net retained: ${bestProfit.id} — Rs ${bestProfit.net} (${((bestProfit.net / baseline.net) * 100).toFixed(1)}% of baseline), ${bestProfit.slHits} SLs`);
  console.log(`  Best net/SL ratio: ${bestEfficiency.id} — Rs ${bestEfficiency.net}, ${bestEfficiency.slHits} SLs (${bestEfficiency.slRate}% SL rate)`);

  const jsonPath = path.join(__dirname, 'strategy3-probability-report.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseline,
        exits,
        signalWinRates: signalRows,
        scoreBuckets,
        typeBuckets,
        topCombos: combos.slice(0, 30),
        worstCombos: combos.slice(-15),
        scenarios: scenarioResults,
        walkForward: { wr55: statsFor(wf55), wr60: statsFor(wf60) },
      },
      null,
      2,
    ),
  );
  console.log(`\nJSON: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

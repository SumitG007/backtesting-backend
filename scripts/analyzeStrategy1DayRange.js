/**
 * Strategy 1 — multi-year day high/low & premium excursion study (2022–2026).
 *
 *   npm run analyze:s1
 *
 * Uses same engine as validation (default form: SL off, target 20, 15m exec).
 * Replays SL/target grids on each trade's intraday path.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runStrategyOneBacktest } = require('../src/strategies/strategy1/backtest');
const { getLotSize, getStrikeStep } = require('../src/utils/market');
const { getIstClock } = require('../src/utils/dateTime');
const { loadCandlesMultiYear } = require('../src/analysis/loadCandlesMultiYear');
const {
  analyzeTradeExcursion,
  replaySlTarget,
  percentile,
} = require('./lib/strategy1Excursion');

const YEARS = [2022, 2023, 2024, 2025, 2026];
const SYMBOL = 'NIFTY';
const EXEC_INTERVAL = '15';
const REPORT_PATH = path.join(__dirname, 'strategy1-dayrange-report.json');

const BASE_SETTINGS = {
  symbol: SYMBOL,
  interval: EXEC_INTERVAL,
  retestPoints: 1,
  strikeMode: 'ATM',
  stopLossPoints: 0,
  targetProfitPoints: 20,
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 1,
  lotSize: getLotSize(SYMBOL),
  strikeStep: getStrikeStep(SYMBOL),
  perTradeCost: 100,
  maxTradesPerDay: 1,
};

const SL_GRID = [0, 8, 10, 12, 15, 18, 20, 25, 30];
const TG_GRID = [10, 15, 20, 25, 30, 40, 50];

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return m;
}

function summarizeTrades(trades) {
  const net = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const losses = trades.filter((t) => Number(t.pnl) < 0).length;
  const grossWin = trades.filter((t) => Number(t.pnl) > 0).reduce((a, t) => a + Number(t.pnl), 0);
  const grossLoss = trades.filter((t) => Number(t.pnl) < 0).reduce((a, t) => a + Number(t.pnl), 0);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    netPnl: Number(net.toFixed(2)),
    avgWin: wins ? Number((grossWin / wins).toFixed(2)) : 0,
    avgLoss: losses ? Number((Math.abs(grossLoss) / losses).toFixed(2)) : 0,
    profitFactor:
      grossLoss < 0 ? Number((grossWin / Math.abs(grossLoss)).toFixed(2)) : grossWin > 0 ? 999 : 0,
  };
}

function groupByReason(trades) {
  const m = new Map();
  for (const t of trades) {
    const r = t.reason || 'OTHER';
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(t);
  }
  const out = {};
  for (const [r, list] of m) {
    out[r] = summarizeTrades(list);
  }
  return out;
}

function avg(nums) {
  const v = nums.filter(Number.isFinite);
  return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)) : 0;
}

async function main() {
  console.log('Strategy 1 day-range & SL/target analysis (2022–2026)\n');
  console.log('Settings:', JSON.stringify(BASE_SETTINGS, null, 2));

  console.log('Loading candles (disk cache → local API → Dhan)…');
  const [dailyLoad, execLoad] = await Promise.all([
    loadCandlesMultiYear({ symbol: SYMBOL, interval: '1', years: YEARS, preferApi: true }),
    loadCandlesMultiYear({ symbol: SYMBOL, interval: EXEC_INTERVAL, years: YEARS, preferApi: true }),
  ]);
  console.log(`Daily: ${dailyLoad.source}, ${dailyLoad.allRows.length} bars`);
  console.log(`Exec ${EXEC_INTERVAL}m: ${execLoad.source}, ${execLoad.allRows.length} bars`);

  const allDaily = dailyLoad.allRows;
  const allExec = execLoad.allRows;

  const { trades } = runStrategyOneBacktest({
    dailyCandles: allDaily,
    execCandles: allExec,
    settings: BASE_SETTINGS,
  });

  const intraByDay = buildIntradayByDay(allExec);
  const model = {
    premiumLeverage: BASE_SETTINGS.premiumLeverage,
    strikeStep: BASE_SETTINGS.strikeStep,
    lotSize: BASE_SETTINGS.lotSize,
    lotCount: BASE_SETTINGS.lotCount,
    perTradeCost: BASE_SETTINGS.perTradeCost,
  };

  const excursions = [];
  for (const t of trades) {
    const dk = getIstClock(t.entryTime).dateKey;
    const dayBars = intraByDay.get(dk);
    if (!dayBars) continue;
    const ex = analyzeTradeExcursion(t, dayBars, model);
    if (ex.ok) excursions.push({ ...ex, year: dk.slice(0, 4), dateKey: dk });
  }

  const winners = excursions.filter((e) => e.pnl > 0);
  const losers = excursions.filter((e) => e.pnl < 0);
  const byReason = groupByReason(trades);

  const loserAdvPts = losers.map((e) => e.maxAdvPremPts).sort((a, b) => a - b);
  const winnerLeftPts = winners.map((e) => e.leftOnTablePrem).sort((a, b) => a - b);
  const allAdvPts = excursions.map((e) => e.maxAdvPremPts).sort((a, b) => a - b);

  const slScenarios = [];
  for (const sl of SL_GRID) {
    let total = 0;
    const reasons = {};
    for (const t of trades) {
      const dk = getIstClock(t.entryTime).dateKey;
      const dayBars = intraByDay.get(dk);
      if (!dayBars) continue;
      const r = replaySlTarget(t, dayBars, model, sl, BASE_SETTINGS.targetProfitPoints);
      if (!r) continue;
      total += r.pnl;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    slScenarios.push({
      stopLossPoints: sl,
      targetProfitPoints: BASE_SETTINGS.targetProfitPoints,
      netPnl: Number(total.toFixed(2)),
      exits: reasons,
    });
  }

  const tgScenarios = [];
  for (const tg of TG_GRID) {
    let total = 0;
    const reasons = {};
    const sl = 15;
    for (const t of trades) {
      const dk = getIstClock(t.entryTime).dateKey;
      const dayBars = intraByDay.get(dk);
      if (!dayBars) continue;
      const r = replaySlTarget(t, dayBars, model, sl, tg);
      if (!r) continue;
      total += r.pnl;
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
    tgScenarios.push({
      stopLossPoints: sl,
      targetProfitPoints: tg,
      netPnl: Number(total.toFixed(2)),
      exits: reasons,
    });
  }

  const comboScenarios = [];
  for (const sl of [12, 15, 18, 20]) {
    for (const tg of [15, 20, 25, 30]) {
      let total = 0;
      for (const t of trades) {
        const dk = getIstClock(t.entryTime).dateKey;
        const dayBars = intraByDay.get(dk);
        if (!dayBars) continue;
        const r = replaySlTarget(t, dayBars, model, sl, tg);
        if (r) total += r.pnl;
      }
      comboScenarios.push({
        stopLossPoints: sl,
        targetProfitPoints: tg,
        netPnl: Number(total.toFixed(2)),
      });
    }
  }
  comboScenarios.sort((a, b) => b.netPnl - a.netPnl);

  const byYear = {};
  for (const y of YEARS) {
    const yt = trades.filter((t) => getIstClock(t.entryTime).dateKey.startsWith(String(y)));
    byYear[y] = summarizeTrades(yt);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    settings: BASE_SETTINGS,
    baseline: summarizeTrades(trades),
    byYear,
    byExitReason: byReason,
    excursionSummary: {
      analyzed: excursions.length,
      avgDayRange: avg(excursions.map((e) => e.dayRange)),
      avgMaxFavPremPts: avg(excursions.map((e) => e.maxFavPremPts)),
      avgMaxAdvPremPts: avg(excursions.map((e) => e.maxAdvPremPts)),
      avgLeftOnTableWinners: avg(winners.map((e) => e.leftOnTablePrem)),
      avgExtraPainLosers: avg(losers.map((e) => e.extraPainPrem)),
      loserAdvP50: percentile(loserAdvPts, 50),
      loserAdvP75: percentile(loserAdvPts, 75),
      loserAdvP90: percentile(loserAdvPts, 90),
      allAdvP75: percentile(allAdvPts, 75),
      winnerLeftP50: percentile(winnerLeftPts, 50),
    },
    slGridTarget20: slScenarios,
    tgGridSl15: tgScenarios,
    topCombos: comboScenarios.slice(0, 8),
    findings: [],
  };

  if (byReason.DAY_CLOSE) {
    report.findings.push(
      `Many exits are DAY_CLOSE (${byReason.DAY_CLOSE.trades} trades, net Rs ${byReason.DAY_CLOSE.netPnl}) — with SL=0 losers ride full session move.`,
    );
  }
  if (byReason.TARGET) {
    report.findings.push(
      `TARGET hits (${byReason.TARGET.trades}) avg win Rs ${byReason.TARGET.avgWin} — capped at ${BASE_SETTINGS.targetProfitPoints} premium pts.`,
    );
  }
  report.findings.push(
    `Losers had median adverse premium excursion ${report.excursionSummary.loserAdvP50} pts (P75 ${report.excursionSummary.loserAdvP75}) — SL near 15–18 pts cuts tail risk.`,
  );
  report.findings.push(
    `Winners left median Rs ${report.excursionSummary.winnerLeftP50} premium on table vs exit — target 20–30 pts balances.`,
  );
  const bestSl = [...slScenarios].sort((a, b) => b.netPnl - a.netPnl)[0];
  const bestCombo = comboScenarios[0];
  report.findings.push(
    `Best SL-only grid (target ${BASE_SETTINGS.targetProfitPoints}): SL ${bestSl.stopLossPoints} → net Rs ${bestSl.netPnl}.`,
  );
  report.findings.push(
    `Best SL+target combo replay: SL ${bestCombo.stopLossPoints} / target ${bestCombo.targetProfitPoints} → net Rs ${bestCombo.netPnl}.`,
  );

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n=== Baseline (your validation settings) ===');
  console.log(report.baseline);
  console.log('\n=== By exit reason ===');
  console.table(byReason);
  console.log('\n=== By year ===');
  console.table(byYear);
  console.log('\n=== Day / premium excursion ===');
  console.log(report.excursionSummary);
  console.log('\n=== Findings ===');
  for (const f of report.findings) console.log(`• ${f}`);
  console.log('\n=== Top SL+target combos (replay) ===');
  console.table(comboScenarios.slice(0, 6));
  console.log(`\nFull JSON: ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Liquidity multi-scenario search (~100 strategies × multi-year, 10 lots).
 *
 * Usage:
 *   node scripts/runLiquidityScenarioSearch.js
 *   node scripts/runLiquidityScenarioSearch.js --years=2022,2023,2024,2025,2026 --lots=10
 *
 * Writes: scripts/liquidity-scenario-results.json
 */

const fs = require('fs');
const path = require('path');
const { runLiquiditySweepBacktest, normalizeRows } = require('../src/services/liquiditySweepBacktest');
const { buildValidationReport } = require('../src/controllers/backtest/buildValidationReport');
const { listCachedYears, diskCachePath } = require('../src/services/liquidityBacktestData');

const LOT = 65;
const OUT_PATH = path.join(__dirname, 'liquidity-scenario-results.json');

function parseArgs() {
  const args = process.argv.slice(2);
  let years = null;
  let lots = 10;
  for (const a of args) {
    if (a.startsWith('--years=')) years = a.slice(8).split(',').map(Number);
    if (a.startsWith('--lots=')) lots = Number(a.slice(7)) || 10;
  }
  return { years, lots };
}

function loadYears(years) {
  const rows = [];
  const loaded = [];
  for (const y of years) {
    const fp = diskCachePath('NIFTY', '5', y);
    if (!fs.existsSync(fp)) {
      console.warn(`[skip] no disk cache ${fp}`);
      continue;
    }
    const part = JSON.parse(fs.readFileSync(fp, 'utf8'));
    rows.push(...part);
    loaded.push(y);
    console.log(`[load] ${y} → ${part.length} bars`);
  }
  rows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { rows, loaded };
}

function buildScenarios(lots) {
  const lotSize = LOT * lots;
  const scenarios = [];
  const push = (id, label, settings) => {
    scenarios.push({
      id,
      label,
      settings: { ...settings, lotSize },
    });
  };

  // --- Block A: Sweep reverse grids ---
  const sessions = [
    { tag: 'full', sessionStartMin: 9 * 60 + 20, sessionEndMin: 14 * 60 + 45 },
    { tag: 'am', sessionStartMin: 9 * 60 + 20, sessionEndMin: 11 * 60 + 30 },
    { tag: 'pm', sessionStartMin: 13 * 60 + 30, sessionEndMin: 14 * 60 + 45 },
  ];
  const targets = [
    { tag: 'fix25', targetMode: 'fixed', targetPts: 25 },
    { tag: 'fix40', targetMode: 'fixed', targetPts: 40 },
    { tag: 'fix60', targetMode: 'fixed', targetPts: 60 },
    { tag: 'hyb40', targetMode: 'hybrid', targetPts: 40 },
    { tag: 'chase', targetMode: 'chase', targetPts: 40 },
  ];
  let n = 1;
  for (const sess of sessions) {
    for (const tgt of targets) {
      for (const bufferPts of [3, 5, 8]) {
        for (const minVisits of [1, 2]) {
          if (scenarios.length >= 45) break;
          push(
            `S${String(n).padStart(3, '0')}`,
            `REV ${sess.tag} ${tgt.tag} buf${bufferPts} v${minVisits}`,
            {
              mode: 'sweep_reverse',
              ...sess,
              ...tgt,
              bufferPts,
              minVisits,
              maxTradesPerDay: 2,
              maxZoneLookbackDays: 5,
              length: 14,
            },
          );
          n += 1;
        }
      }
    }
  }

  // --- Block B: R:R sweep ---
  for (const rr of [1, 1.5, 2, 2.5]) {
    for (const sess of sessions) {
      for (const bufferPts of [5, 8]) {
        push(
          `S${String(n).padStart(3, '0')}`,
          `RR${rr} ${sess.tag} buf${bufferPts}`,
          {
            mode: 'sweep_rr',
            targetMode: 'rr',
            rrMultiple: rr,
            ...sess,
            bufferPts,
            minVisits: 2,
            maxTradesPerDay: 2,
            maxZoneLookbackDays: 5,
            length: 14,
          },
        );
        n += 1;
      }
    }
  }

  // --- Block C: Break & Go ---
  for (const sess of sessions) {
    for (const tgt of [
      { tag: 'fix30', targetMode: 'fixed', targetPts: 30 },
      { tag: 'fix50', targetMode: 'fixed', targetPts: 50 },
      { tag: 'rr15', targetMode: 'rr', rrMultiple: 1.5 },
      { tag: 'rr2', targetMode: 'rr', rrMultiple: 2 },
    ]) {
      push(
        `S${String(n).padStart(3, '0')}`,
        `BRK ${sess.tag} ${tgt.tag}`,
        {
          mode: 'break_go',
          ...sess,
          ...tgt,
          bufferPts: 8,
          minVisits: 2,
          maxTradesPerDay: 2,
          maxZoneLookbackDays: 5,
          length: 14,
          maxRiskPts: 100,
        },
      );
      n += 1;
    }
  }

  // --- Block D: Prior-day liquidity only (PDH/PDL style) ---
  for (const mode of ['sweep_reverse', 'break_go']) {
    for (const tgt of [
      { tag: 'fix40', targetMode: 'fixed', targetPts: 40 },
      { tag: 'rr2', targetMode: 'rr', rrMultiple: 2 },
      { tag: 'hyb40', targetMode: 'hybrid', targetPts: 40 },
    ]) {
      push(
        `S${String(n).padStart(3, '0')}`,
        `PDY ${mode === 'break_go' ? 'BRK' : 'REV'} ${tgt.tag}`,
        {
          mode: mode === 'break_go' ? 'break_go' : 'sweep_reverse',
          ...tgt,
          priorDayZonesOnly: true,
          bufferPts: 5,
          minVisits: 1,
          maxTradesPerDay: 2,
          maxZoneLookbackDays: 3,
          sessionStartMin: 9 * 60 + 20,
          sessionEndMin: 14 * 60 + 45,
          length: 14,
        },
      );
      n += 1;
    }
  }

  // --- Block E: EMA trend filter ---
  for (const emaPeriod of [20, 50, 100]) {
    for (const mode of ['sweep_reverse', 'sweep_rr']) {
      push(
        `S${String(n).padStart(3, '0')}`,
        `EMA${emaPeriod} ${mode === 'sweep_rr' ? 'RR1.5' : 'REV'}`,
        {
          mode,
          targetMode: mode === 'sweep_rr' ? 'rr' : 'fixed',
          targetPts: 40,
          rrMultiple: 1.5,
          emaPeriod,
          bufferPts: 5,
          minVisits: 2,
          maxTradesPerDay: 2,
          sessionStartMin: 9 * 60 + 20,
          sessionEndMin: 14 * 60 + 45,
          length: 14,
        },
      );
      n += 1;
    }
  }

  // --- Block F: Min sweep depth + quality ---
  for (const minSweepPts of [3, 5, 8, 12]) {
    for (const requireBullishClose of [false, true]) {
      push(
        `S${String(n).padStart(3, '0')}`,
        `QUAL sweep≥${minSweepPts}${requireBullishClose ? ' body' : ''}`,
        {
          mode: 'sweep_reverse',
          targetMode: 'fixed',
          targetPts: 35,
          minSweepPts,
          requireBullishClose,
          bufferPts: 5,
          minVisits: 2,
          maxTradesPerDay: 1,
          sessionStartMin: 9 * 60 + 25,
          sessionEndMin: 14 * 60,
          length: 14,
          maxZoneLookbackDays: 4,
        },
      );
      n += 1;
    }
  }

  // --- Block G: Side bias + morning ---
  for (const sideBias of ['long', 'short']) {
    for (const tgt of [
      { tag: 'fix40', targetMode: 'fixed', targetPts: 40 },
      { tag: 'rr2', targetMode: 'rr', rrMultiple: 2 },
    ]) {
      push(
        `S${String(n).padStart(3, '0')}`,
        `BIAS ${sideBias} am ${tgt.tag}`,
        {
          mode: 'sweep_reverse',
          ...tgt,
          sideBias,
          sessionStartMin: 9 * 60 + 20,
          sessionEndMin: 11 * 60 + 30,
          bufferPts: 5,
          minVisits: 2,
          maxTradesPerDay: 1,
          length: 14,
        },
      );
      n += 1;
    }
  }

  // --- Block H: Longer pivots / fewer trades ---
  for (const length of [10, 18, 24]) {
    push(
      `S${String(n).padStart(3, '0')}`,
      `PIV${length} REV fix40`,
      {
        mode: 'sweep_reverse',
        length,
        targetMode: 'fixed',
        targetPts: 40,
        bufferPts: 5,
        minVisits: 2,
        maxTradesPerDay: 1,
        minZoneAgeBars: length,
        sessionStartMin: 9 * 60 + 30,
        sessionEndMin: 14 * 60 + 30,
      },
    );
    n += 1;
  }

  // Cap / pad to ~100
  return scenarios.slice(0, 100);
}

function scoreScenario(trades) {
  const report = buildValidationReport(
    trades.map((t) => ({ entryTime: t.entryTime, pnl: t.pnl, reason: t.reason })),
  );
  const monthly = report.monthly || [];
  const greenMonths = monthly.filter((m) => m.pnl > 0).length;
  const redMonths = monthly.filter((m) => m.pnl < 0).length;
  const flatMonths = monthly.filter((m) => m.pnl === 0).length;
  const monthCount = monthly.length || 1;
  const monthWinPct = (greenMonths / monthCount) * 100;
  const allMonthsGreen = monthCount > 0 && redMonths === 0 && greenMonths === monthCount;

  // Prefer consistency then expectancy
  const consistencyScore =
    monthWinPct * 2 +
    (report.stats.profitFactor > 1 ? 20 : 0) +
    (report.stats.netPnl > 0 ? 15 : -30) -
    Math.min(40, Math.abs(report.stats.maxDrawdown) / 50000);

  return {
    stats: report.stats,
    monthly,
    greenMonths,
    redMonths,
    flatMonths,
    monthCount,
    monthWinPct: Number(monthWinPct.toFixed(1)),
    allMonthsGreen,
    consistencyScore: Number(consistencyScore.toFixed(2)),
  };
}

function main() {
  const { years: yearsArg, lots } = parseArgs();
  const cached = listCachedYears('NIFTY', '5');
  const years = yearsArg && yearsArg.length ? yearsArg : cached.length ? cached : [2022, 2023, 2024, 2025, 2026];
  console.log(`\n=== Liquidity scenario search · ${lots} lots (lotSize=${LOT * lots}) ===`);
  console.log(`Years: ${years.join(', ')}\n`);

  const { rows, loaded } = loadYears(years);
  if (!rows.length) {
    console.error('No candles loaded. Run npm run cache:candles first.');
    process.exit(1);
  }

  console.log('Normalizing bars once…');
  const bars = normalizeRows(rows);
  console.log(`Normalized ${bars.length} bars\n`);

  const scenarios = buildScenarios(lots);
  console.log(`\nRunning ${scenarios.length} scenarios on ${bars.length} bars…\n`);

  const results = [];
  const t0 = Date.now();
  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    const run = runLiquiditySweepBacktest(bars, sc.settings, { normalized: true });
    const scored = scoreScenario(run.trades);
    results.push({
      id: sc.id,
      label: sc.label,
      settings: sc.settings,
      trades: scored.stats.totalTrades,
      ...scored,
    });
    if ((i + 1) % 10 === 0 || i === scenarios.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  … ${i + 1}/${scenarios.length} done (${elapsed}s)`);
    }
  }

  results.sort((a, b) => b.consistencyScore - a.consistencyScore);

  const allGreen = results.filter((r) => r.allMonthsGreen && r.stats.netPnl > 0);
  const mostlyGreen = results.filter((r) => r.monthWinPct >= 70 && r.stats.netPnl > 0 && r.stats.profitFactor >= 1);
  const bestPnl = [...results].sort((a, b) => b.stats.netPnl - a.stats.netPnl);
  const bestPF = [...results].filter((r) => r.trades >= 30).sort((a, b) => b.stats.profitFactor - a.stats.profitFactor);

  const summary = {
    lots,
    lotSize: LOT * lots,
    years: loaded,
    barCount: bars.length,
    scenarioCount: results.length,
    elapsedMs: Date.now() - t0,
    allMonthsGreenCount: allGreen.length,
    mostlyGreenCount: mostlyGreen.length,
    topConsistency: results.slice(0, 15).map(compact),
    allMonthsGreen: allGreen.slice(0, 10).map(compact),
    mostlyGreenMonths: mostlyGreen.slice(0, 10).map(compact),
    topNetPnl: bestPnl.slice(0, 10).map(compact),
    topProfitFactor: bestPF.slice(0, 10).map(compact),
    worst: [...results].sort((a, b) => a.stats.netPnl - b.stats.netPnl).slice(0, 5).map(compact),
    all: results.map(compact),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  printReport(summary);
  console.log(`\nFull JSON → ${OUT_PATH}\n`);
}

function compact(r) {
  return {
    id: r.id,
    label: r.label,
    trades: r.trades,
    netPnl: r.stats.netPnl,
    winRate: r.stats.winRate,
    profitFactor: r.stats.profitFactor,
    maxDD: r.stats.maxDrawdown,
    monthWinPct: r.monthWinPct,
    greenMonths: r.greenMonths,
    redMonths: r.redMonths,
    monthCount: r.monthCount,
    allMonthsGreen: r.allMonthsGreen,
    consistencyScore: r.consistencyScore,
    settings: {
      mode: r.settings.mode,
      targetMode: r.settings.targetMode,
      targetPts: r.settings.targetPts,
      rrMultiple: r.settings.rrMultiple,
      bufferPts: r.settings.bufferPts,
      minVisits: r.settings.minVisits,
      sessionStartMin: r.settings.sessionStartMin,
      sessionEndMin: r.settings.sessionEndMin,
      priorDayZonesOnly: r.settings.priorDayZonesOnly,
      emaPeriod: r.settings.emaPeriod,
      sideBias: r.settings.sideBias,
      minSweepPts: r.settings.minSweepPts,
      maxTradesPerDay: r.settings.maxTradesPerDay,
      length: r.settings.length,
      lotSize: r.settings.lotSize,
    },
  };
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function printReport(s) {
  console.log('\n========== OVERALL ==========');
  console.log(`Scenarios: ${s.scenarioCount} · Years: ${s.years.join(', ')} · ${s.lots} lots`);
  console.log(`All-months-green profitable: ${s.allMonthsGreenCount}`);
  console.log(`≥70% months green + PF≥1: ${s.mostlyGreenCount}`);

  console.log('\n--- Best consistency (top 10) ---');
  for (const r of s.topConsistency.slice(0, 10)) {
    console.log(
      `${r.id} ${r.label.padEnd(32)} PnL ₹${fmt(r.netPnl).padStart(10)}  WR ${String(r.winRate).padStart(5)}%  PF ${String(r.profitFactor).padStart(4)}  months ${r.greenMonths}/${r.monthCount} (${r.monthWinPct}%)  DD ₹${fmt(r.maxDD)}`,
    );
  }

  if (s.allMonthsGreen.length) {
    console.log('\n--- ALL MONTHS GREEN ---');
    for (const r of s.allMonthsGreen) {
      console.log(`${r.id} ${r.label} · PnL ₹${fmt(r.netPnl)} · trades ${r.trades} · PF ${r.profitFactor}`);
      console.log('   settings:', JSON.stringify(r.settings));
    }
  } else {
    console.log('\n--- NO scenario was green in EVERY month ---');
    console.log('Closest by month win% among profitable:');
    const close = s.all
      .filter((r) => r.netPnl > 0)
      .sort((a, b) => b.monthWinPct - a.monthWinPct || b.netPnl - a.netPnl)
      .slice(0, 5);
    for (const r of close) {
      console.log(
        `${r.id} ${r.label} · months ${r.greenMonths}/${r.monthCount} (${r.monthWinPct}%) · PnL ₹${fmt(r.netPnl)} · PF ${r.profitFactor}`,
      );
      console.log('   settings:', JSON.stringify(r.settings));
    }
  }

  console.log('\n--- Top net PnL ---');
  for (const r of s.topNetPnl.slice(0, 5)) {
    console.log(`${r.id} ${r.label} · ₹${fmt(r.netPnl)} · months ${r.greenMonths}/${r.monthCount}`);
  }

  console.log('\n--- Worst (avoid) ---');
  for (const r of s.worst) {
    console.log(`${r.id} ${r.label} · ₹${fmt(r.netPnl)} · months ${r.greenMonths}/${r.monthCount}`);
  }
}

main();

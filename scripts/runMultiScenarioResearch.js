/**
 * CLI: multi-scenario pattern mining (daily + sequences, 5 SL/TG configs).
 *
 *   npm run research:multi
 *   node scripts/runMultiScenarioResearch.js NIFTY 5
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runMultiScenarioResearch } = require('../src/research/runMultiScenarioResearch');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const symbol = String(args[0] || 'NIFTY').toUpperCase();
const interval = String(args[1] || '5');
const preferApi = process.argv.includes('--api');

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

function formatReport(result) {
  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(` MULTI-SCENARIO PATTERN RESEARCH — ${result.symbol} ${result.interval}m`);
  lines.push(` Years: ${result.years.join(', ')} | Trading days: ${result.overview.tradingDays}`);
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(`Patterns scored: ${result.meta.totalPatternsScored} | Scenarios: ${result.scenarios.length}`);
  lines.push('');

  const r = result.recommendations;
  if (r.bestOverall) {
    lines.push('── ★ BEST OVERALL (win rate × trades × year stability) ──');
    lines.push(`  ${r.bestOverall.label}`);
    lines.push(
      `  ${r.bestOverall.bestSide} | WR ${r.bestOverall.bestWinRate}% | Trades ${r.bestOverall.sampleSize} | ~${r.bestOverall.occurrencesPerMonth}/mo | Years+ ${r.bestOverall.yearStabilityPct}% | Scenario ${r.bestOverall.scenarioId}`,
    );
    lines.push('');
  }
  if (r.bestHighFrequency) {
    lines.push('── ★ MOST TRADES (WR ≥ 52%) ──');
    lines.push(`  ${r.bestHighFrequency.label}`);
    lines.push(
      `  ${r.bestHighFrequency.bestSide} | WR ${r.bestHighFrequency.bestWinRate}% | Trades ${r.bestHighFrequency.sampleSize} | Scenario ${r.bestHighFrequency.scenarioId}`,
    );
    lines.push('');
  }
  if (r.bestDaily) {
    lines.push('── ★ BEST DAILY / MORNING STRUCTURE ──');
    lines.push(`  ${r.bestDaily.label}`);
    lines.push(
      `  WR ${r.bestDaily.bestWinRate}% | Trades ${r.bestDaily.sampleSize} | ~${r.bestDaily.occurrencesPerMonth}/mo`,
    );
    lines.push('');
  }

  lines.push('── TOP 15 BY SCORE (all scenarios) ──');
  lines.push('Label                                          | Side | WR%   | Trades | /mo  | Yrs% | Scenario');
  for (const p of result.topByScore.slice(0, 15)) {
    lines.push(
      `${pad(p.label, 46)} | ${pad(p.bestSide, 4)} | ${pad(p.bestWinRate, 5)} | ${pad(p.sampleSize, 6)} | ${pad(p.occurrencesPerMonth, 4)} | ${pad(p.yearStabilityPct, 4)} | ${p.scenarioId}`,
    );
  }
  lines.push('');

  lines.push('── TOP 15 BY TRADE COUNT (WR ≥ 52%) ──');
  for (const p of result.topByTrades.slice(0, 15)) {
    lines.push(
      `  [${p.sampleSize} trades, ${p.bestWinRate}%] ${p.bestSide} — ${p.label} (${p.scenarioId})`,
    );
  }
  lines.push('');

  lines.push('── PER SCENARIO BEST ──');
  for (const s of result.scenarioSummaries) {
    const b = s.bestOverall;
    if (!b) continue;
    lines.push(
      `  ${s.scenarioId} TG${s.targetPoints}/SL${s.stopPoints}: ${b.bestSide} ${b.bestWinRate}% n=${b.sampleSize} — ${b.label?.slice(0, 60)}`,
    );
  }
  lines.push('');

  lines.push('── YEAR BREAKDOWN (best overall) ──');
  if (r.bestOverall?.byYear) {
    for (const [y, st] of Object.entries(r.bestOverall.byYear).sort()) {
      const wr = r.bestOverall.bestSide === 'CE' ? st.longWinRate : st.shortWinRate;
      lines.push(`  ${y}: ${st.sampleSize} signals | win rate ${wr}%`);
    }
  }
  lines.push('');
  lines.push(result.meta.disclaimer);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  console.log(`Multi-scenario research: ${symbol} ${interval}m...`);
  const started = Date.now();

  const result = await runMultiScenarioResearch({
    symbol,
    interval,
    preferApi,
  });

  const outDir = path.join(__dirname);
  const jsonPath = path.join(outDir, 'multi-scenario-research.json');
  const txtPath = path.join(outDir, 'multi-scenario-research.txt');

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  const text = formatReport(result);
  fs.writeFileSync(txtPath, text);

  console.log(text);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`JSON → ${jsonPath}`);
  console.log(`TXT  → ${txtPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

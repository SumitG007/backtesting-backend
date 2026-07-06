/**
 * CLI: mine recurring candle patterns from historical data.
 *
 *   node scripts/runPatternResearch.js
 *   node scripts/runPatternResearch.js NIFTY 5
 *   node scripts/runPatternResearch.js NIFTY 5 --target 20 --stop 10
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runPatternResearch } = require('../src/research/runPatternResearch');
const { formatPatternResearchReport } = require('../src/research/formatReport');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2);

function flagNum(name, fallback) {
  const idx = flags.indexOf(name);
  if (idx === -1 || !flags[idx + 1]) return fallback;
  const n = Number(flags[idx + 1]);
  return Number.isFinite(n) ? n : fallback;
}

const symbol = String(args[0] || 'NIFTY').toUpperCase();
const interval = String(args[1] || '5');
const preferApi = flags.includes('--api');

async function main() {
  console.log(`Pattern research: ${symbol} ${interval}m (2022–2026)...`);
  const started = Date.now();

  const result = await runPatternResearch({
    symbol,
    interval,
    preferApi,
    minSamples: flagNum('--min-samples', 35),
    topN: flagNum('--top', 30),
    outcome: {
      targetPoints: flagNum('--target', 15),
      stopPoints: flagNum('--stop', 10),
      horizonBars: flagNum('--horizon', 6),
      barIntervalMinutes: Number(interval) || 5,
    },
  });

  const outDir = path.join(__dirname);
  const jsonPath = path.join(outDir, 'pattern-research-report.json');
  const txtPath = path.join(outDir, 'pattern-research-report.txt');

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(txtPath, formatPatternResearchReport(result));

  console.log(formatPatternResearchReport(result));
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`JSON → ${jsonPath}`);
  console.log(`TXT  → ${txtPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

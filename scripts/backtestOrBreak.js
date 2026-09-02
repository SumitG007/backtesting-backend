/** OR Break Midday — year/month report */
const fs = require('fs');
const path = require('path');
const { runOrBreakReport, runYearlyBreakdown } = require('../src/strategies/orBreakMidday/engine');

const CACHE = path.join(__dirname, 'candle-cache');

function loadAll() {
  const rows = [];
  for (const y of [2021, 2022, 2023, 2024, 2025, 2026]) {
    const fp = path.join(CACHE, `NIFTY-5-${y}.json`);
    if (!fs.existsSync(fp)) continue;
    rows.push(...JSON.parse(fs.readFileSync(fp, 'utf8')));
  }
  rows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return rows;
}

const rows = loadAll();
const years = [2021, 2022, 2023, 2024, 2025, 2026].filter((y) =>
  fs.existsSync(path.join(CACHE, `NIFTY-5-${y}.json`)),
);
const yearly = runYearlyBreakdown(rows, years);
const fmt = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

console.log('\n  OR BREAK MIDDAY CHASE · 2021–now\n');
let posM = 0;
let totM = 0;
for (const y of yearly) {
  const pm = y.monthly.filter((m) => m.netPoints > 0).length;
  posM += pm;
  totM += y.monthly.length;
  console.log(`${y.year}  tr=${y.trades}  wr=${y.winRate}%  net=${fmt(y.netPoints)}  greenMo=${pm}/${y.monthly.length}`);
}
console.log(`\n  Total green months: ${posM}/${totM}\n`);

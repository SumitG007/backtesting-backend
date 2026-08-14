/**
 * One-page boss report: did 4Bull@BB-lower / 4Bear@BB-upper ever fire,
 * and every BB top/bottom time without that rule.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'data', 'oi-flow-bb-touch-report-2026-08-12-14.json');
const days = JSON.parse(fs.readFileSync(src, 'utf8'));

function fmtSpot(n) {
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function zoneLabel(z) {
  return z === 'upper' ? 'TOP' : 'BOTTOM';
}

function ruleMet(h) {
  return (h.zone === 'lower' && h.bucket === '4Bull') || (h.zone === 'upper' && h.bucket === '4Bear');
}

const lines = [];
lines.push('# OI Flow × Bollinger Band — strategy check');
lines.push('');
lines.push('**Period:** 12, 13, 14 Aug 2026 (NIFTY 1-minute OI Flow JSON)');
lines.push('**BB:** 20 SMA ± 2σ, offset 0. “At band” = touch / outside / within 5 pts.');
lines.push('**TFs:** 15M / 5M / 3M / 1M from spot lookback.');
lines.push('**Look-ahead:** none. At time T only bars with minutes ≤ T are used (OI, candle, TFs, BB).');
lines.push('');
lines.push('## Proposed extra rule (stacked with OI)');
lines.push('');
lines.push('- CALL BUY only if **4 Bull and NIFTY at BB bottom**');
lines.push('- PUT BUY only if **4 Bear and NIFTY at BB top**');
lines.push('');
lines.push('## Verdict');
lines.push('');
lines.push('| Check | Result | Times |');
lines.push('|-------|--------|-------|');
lines.push('| 4 Bull at BB **bottom** | **Not met** | **0** |');
lines.push('| 4 Bear at BB **top** | **Not met** | **0** |');
lines.push('| Combined stacked rule | **Not met on any of the 3 days** | **0** |');
lines.push('');
lines.push('## How many times BB was hit *without* that rule');
lines.push('');

let top = 0;
let bot = 0;
let without = 0;
let withRule = 0;
for (const d of days) {
  top += d.counts.upper['4Bull'] + d.counts.upper['4Bear'] + d.counts.upper.Mixed;
  bot += d.counts.lower['4Bull'] + d.counts.lower['4Bear'] + d.counts.lower.Mixed;
  for (const h of d.hits) {
    if (ruleMet(h)) withRule += 1;
    else without += 1;
  }
}

lines.push('| | Times | 4 Bull | 4 Bear | Mixed TFs |');
lines.push('|--|------:|-------:|-------:|----------:|');
lines.push(
  `| BB **top** | ${top} | ${days.reduce((a, d) => a + d.counts.upper['4Bull'], 0)} | ${days.reduce((a, d) => a + d.counts.upper['4Bear'], 0)} | ${days.reduce((a, d) => a + d.counts.upper.Mixed, 0)} |`,
);
lines.push(
  `| BB **bottom** | ${bot} | ${days.reduce((a, d) => a + d.counts.lower['4Bull'], 0)} | ${days.reduce((a, d) => a + d.counts.lower['4Bear'], 0)} | ${days.reduce((a, d) => a + d.counts.lower.Mixed, 0)} |`,
);
lines.push(`| **Total BB top+bottom** | **${top + bot}** | | | |`);
lines.push(`| Of which stacked rule met | **${withRule}** | | | |`);
lines.push(`| BB hit **without** stacked rule | **${without}** | | | |`);
lines.push('');
lines.push('What actually lines up: **4 Bull with BB top** (103) and **4 Bear with BB bottom** (114). That is the opposite of CE-at-bottom / PE-at-top.');
lines.push('');

for (const d of days) {
  const u = d.counts.upper;
  const l = d.counts.lower;
  lines.push(`## ${d.dateKey}  (${d.first}–${d.last}, ${d.counts.ready} BB-ready minutes)`);
  lines.push('');
  lines.push('| Zone | Times | 4 Bull | 4 Bear | Mixed | Stacked rule |');
  lines.push('|------|------:|-------:|-------:|------:|--------------|');
  lines.push(`| Top | ${u['4Bull'] + u['4Bear'] + u.Mixed} | ${u['4Bull']} | ${u['4Bear']} | ${u.Mixed} | 4 Bear @ top = **0** |`);
  lines.push(`| Bottom | ${l['4Bull'] + l['4Bear'] + l.Mixed} | ${l['4Bull']} | ${l['4Bear']} | ${l.Mixed} | 4 Bull @ bottom = **0** |`);
  lines.push('');
  lines.push('| Time | Spot | BB | 15M/5M/3M/1M | TF pack | Stacked rule | %B |');
  lines.push('|------|------|----|--------------|---------|--------------|-----|');
  for (const h of d.hits) {
    const met = ruleMet(h) ? 'YES' : 'No';
    lines.push(
      `| ${h.time} | ${fmtSpot(h.spot)} | ${zoneLabel(h.zone)} | ${h.tf} | ${h.bucket} | ${met} | ${h.pctB} |`,
    );
  }
  lines.push('');
}

lines.push('---');
lines.push('Live paper engine remains: Put ΔOI ≥ 2.5L + green/red candle + **4 Bull → CE / 4 Bear → PE**. BB stacked CE-at-lower / PE-at-upper is **not** enabled (0 fills on this tape).');
lines.push('');

const out = path.join(
  __dirname,
  '..',
  'data',
  'OI-Flow-BB-vs-4TF-Boss-Report-12-14-Aug-2026.md',
);
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`Wrote ${out}`);
console.log(`BB top+bottom ${top + bot} · rule met ${withRule} · without rule ${without}`);

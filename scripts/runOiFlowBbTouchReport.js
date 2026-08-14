/**
 * Count how often NIFTY spot sits at BB(20,2) SMA upper vs lower,
 * and whether 15/5/3/1 are 4 Bull, 4 Bear, or mixed.
 *
 * Usage: node scripts/runOiFlowBbTouchReport.js
 */
const fs = require('fs');
const path = require('path');
const {
  normalizeRows,
  buildIndex,
  bbAt,
  tfsAt,
} = require('../src/services/oiFlowSignalEngine');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];

function tfBucket(tfs) {
  if (tfs.allBull) return '4Bull';
  if (tfs.allBear) return '4Bear';
  return 'Mixed';
}

function runDay(dateKey) {
  const file = path.join(__dirname, '..', 'data', `oi-flow-${dateKey}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = normalizeRows(Array.isArray(raw) ? raw : raw.rows || []);
  const counts = {
    ready: 0,
    upper: { '4Bull': 0, '4Bear': 0, Mixed: 0 },
    lower: { '4Bull': 0, '4Bear': 0, Mixed: 0 },
    mid: { '4Bull': 0, '4Bear': 0, Mixed: 0 },
  };
  const hits = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    // Hard walk-forward: no bar after T exists in this ctx.
    const ctx = buildIndex(rows.slice(0, i + 1));
    const bb = bbAt(ctx, row.minutes);
    if (!bb.ok) continue;
    counts.ready += 1;
    const tfs = tfsAt(ctx, row.minutes, row.spot);
    const bucket = tfBucket(tfs);
    const zone = bb.zone === 'upper' ? 'upper' : bb.zone === 'lower' ? 'lower' : 'mid';
    counts[zone][bucket] += 1;
    if (zone === 'mid') continue;
    hits.push({
      time: row.time,
      spot: row.spot,
      zone,
      tf: `${tfs.tf15.label}/${tfs.tf5.label}/${tfs.tf3.label}/${tfs.tf1.label}`,
      bucket,
      pctB: bb.pctB,
      lower: bb.lower,
      upper: bb.upper,
    });
  }

  return {
    dateKey,
    bars: rows.length,
    first: rows[0]?.time,
    last: rows[rows.length - 1]?.time,
    counts,
    hits,
  };
}

function sumZone(z) {
  return z['4Bull'] + z['4Bear'] + z.Mixed;
}

function main() {
  const days = DATES.map(runDay);
  const out = path.join(__dirname, '..', 'data', 'oi-flow-bb-touch-report-2026-08-12-14.json');
  fs.writeFileSync(out, `${JSON.stringify(days, null, 2)}\n`);

  const lines = [];
  lines.push('NIFTY BB(20,2) SMA · at top / bottom vs 4 Bull / 4 Bear');
  lines.push('At line = touch, outside, or within 5 pts. Each bar T uses only rows with minutes ≤ T (no future OI, candle, or BB).');
  lines.push('');

  for (const d of days) {
    const u = d.counts.upper;
    const l = d.counts.lower;
    const m = d.counts.mid;
    lines.push(`=== ${d.dateKey} · ${d.bars} bars ${d.first}–${d.last} · BB-ready ${d.counts.ready} ===`);
    lines.push(
      `TOP (upper)  ${sumZone(u)}   4Bull ${u['4Bull']}  4Bear ${u['4Bear']}  Mixed ${u.Mixed}`,
    );
    lines.push(
      `BOTTOM (lower) ${sumZone(l)}   4Bull ${l['4Bull']}  4Bear ${l['4Bear']}  Mixed ${l.Mixed}`,
    );
    lines.push(
      `MID          ${sumZone(m)}   4Bull ${m['4Bull']}  4Bear ${m['4Bear']}  Mixed ${m.Mixed}`,
    );
    lines.push('Time\tSpot\tBB\t15/5/3/1\tTF pack\t%B\tLower\tUpper');
    for (const h of d.hits) {
      lines.push(
        `${h.time}\t${h.spot}\t${h.zone}\t${h.tf}\t${h.bucket}\t${h.pctB}\t${h.lower}\t${h.upper}`,
      );
    }
    lines.push('');
  }

  const tot = { upper: { '4Bull': 0, '4Bear': 0, Mixed: 0 }, lower: { '4Bull': 0, '4Bear': 0, Mixed: 0 } };
  for (const d of days) {
    for (const k of ['4Bull', '4Bear', 'Mixed']) {
      tot.upper[k] += d.counts.upper[k];
      tot.lower[k] += d.counts.lower[k];
    }
  }
  lines.push('=== ALL 3 DAYS ===');
  lines.push(
    `TOP    ${sumZone(tot.upper)}   4Bull ${tot.upper['4Bull']}  4Bear ${tot.upper['4Bear']}  Mixed ${tot.upper.Mixed}`,
  );
  lines.push(
    `BOTTOM ${sumZone(tot.lower)}   4Bull ${tot.lower['4Bull']}  4Bear ${tot.lower['4Bear']}  Mixed ${tot.lower.Mixed}`,
  );
  lines.push(`Wrote ${out}`);
  console.log(lines.join('\n'));
}

main();

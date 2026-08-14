/**
 * Detailed boss report: BB top/bottom vs 4TF + OI, walk-forward (minutes ≤ T).
 * Writes markdown + CSV with every timestamp.
 *
 * Usage: node scripts/writeOiFlowBbDetailedReport.js
 */
const fs = require('fs');
const path = require('path');
const {
  normalizeRows,
  buildIndex,
  bbAt,
  tfsAt,
  decideRaw,
} = require('../src/services/oiFlowSignalEngine');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];

function fmtSpot(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtLakh(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v / 100000).toFixed(2)}L`;
}

function tfBucket(tfs) {
  if (tfs.allBull) return '4Bull';
  if (tfs.allBear) return '4Bear';
  return 'Mixed';
}

function stackedMet(row) {
  return (
    (row.bbZone === 'BOTTOM' && row.tfPack === '4Bull') ||
    (row.bbZone === 'TOP' && row.tfPack === '4Bear')
  );
}

function collectDay(dateKey) {
  const file = path.join(__dirname, '..', 'data', `oi-flow-${dateKey}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = normalizeRows(Array.isArray(raw) ? raw : raw.rows || []);
  const out = [];
  let ready = 0;
  let mid = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const ctx = buildIndex(rows.slice(0, i + 1));
    const bb = bbAt(ctx, row.minutes);
    if (!bb.ok) continue;
    ready += 1;
    if (bb.zone === 'mid') {
      mid += 1;
      continue;
    }
    const tfs = tfsAt(ctx, row.minutes, row.spot);
    const oi = decideRaw(ctx, row.minutes, {
      minPutOi: 250000,
      maxPutOi: 3000000,
      requireSpotAlign: true,
      requireAllTfAlign: false,
      requireBbBand: false,
    });
    const rec = {
      date: dateKey,
      time: row.time,
      minutes: row.minutes,
      spot: row.spot,
      bbZone: bb.zone === 'upper' ? 'TOP' : 'BOTTOM',
      bbLower: bb.lower,
      bbMid: bb.mid,
      bbUpper: bb.upper,
      pctB: bb.pctB,
      distLower: Number((row.spot - bb.lower).toFixed(1)),
      distUpper: Number((row.spot - bb.upper).toFixed(1)),
      tf15: tfs.tf15.label,
      tf5: tfs.tf5.label,
      tf3: tfs.tf3.label,
      tf1: tfs.tf1.label,
      tfPack: tfBucket(tfs),
      candle: oi?.candle || '—',
      spotChg1: oi?.spotChg1,
      callOiL: oi?.callChgL || fmtLakh(oi?.callChg),
      putOiL: oi?.putChgL || fmtLakh(oi?.putChg),
      callAct: oi?.callAct || '—',
      putAct: oi?.putAct || '—',
      oiDecision: oi?.decision || 'WAIT',
      oiReason: oi?.reason || '',
    };
    rec.stackedRule = stackedMet(rec) ? 'YES' : 'NO';
    rec.note =
      rec.bbZone === 'TOP' && rec.tfPack === '4Bull'
        ? 'Opposite: 4 Bull at TOP'
        : rec.bbZone === 'BOTTOM' && rec.tfPack === '4Bear'
          ? 'Opposite: 4 Bear at BOTTOM'
          : rec.tfPack === 'Mixed'
            ? 'BB hit, TFs mixed'
            : 'Other';
    out.push(rec);
  }

  return {
    dateKey,
    bars: rows.length,
    first: rows[0]?.time,
    last: rows[rows.length - 1]?.time,
    ready,
    mid,
    hits: out,
  };
}

function countPack(hits, zone, pack) {
  return hits.filter((h) => h.bbZone === zone && h.tfPack === pack).length;
}

function mdTable(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const r of rows) lines.push(`| ${r.join(' | ')} |`);
  return lines.join('\n');
}

function main() {
  const days = DATES.map(collectDay);
  const allHits = days.flatMap((d) => d.hits);
  const yes = allHits.filter((h) => h.stackedRule === 'YES');
  const no = allHits.filter((h) => h.stackedRule === 'NO');

  const tot = {
    top: allHits.filter((h) => h.bbZone === 'TOP').length,
    bot: allHits.filter((h) => h.bbZone === 'BOTTOM').length,
    top4bull: allHits.filter((h) => h.bbZone === 'TOP' && h.tfPack === '4Bull').length,
    top4bear: allHits.filter((h) => h.bbZone === 'TOP' && h.tfPack === '4Bear').length,
    topMix: allHits.filter((h) => h.bbZone === 'TOP' && h.tfPack === 'Mixed').length,
    bot4bull: allHits.filter((h) => h.bbZone === 'BOTTOM' && h.tfPack === '4Bull').length,
    bot4bear: allHits.filter((h) => h.bbZone === 'BOTTOM' && h.tfPack === '4Bear').length,
    botMix: allHits.filter((h) => h.bbZone === 'BOTTOM' && h.tfPack === 'Mixed').length,
  };

  const md = [];
  md.push('# OI Flow × Bollinger Band — detailed strategy report');
  md.push('');
  md.push('**Prepared for:** strategy review (NIFTY OI Flow Tracker)');
  md.push('**Dates:** 12 Aug, 13 Aug, 14 Aug 2026 (IST)');
  md.push('**Data:** minute JSON tapes (`oi-flow-YYYY-MM-DD.json`). 13 Aug tape ends 11:50.');
  md.push('');
  md.push('## 1. What was tested');
  md.push('');
  md.push('**Live OI rules (already in engine)**');
  md.push('- PUT BUY: Put buying ≥ 2.5L + red candle (spot down) + 15/5/3/1 all Bear → PE');
  md.push('- CALL BUY: Put writing ≥ 2.5L + green candle (spot up) + 15/5/3/1 all Bull → CE');
  md.push('- Skip Put ΔOI > 30L · window 09:30–14:30');
  md.push('');
  md.push('**Proposed BB stack (this report)**');
  md.push('- Extra CE filter: NIFTY spot at **BB bottom** (lower band)');
  md.push('- Extra PE filter: NIFTY spot at **BB top** (upper band)');
  md.push('- BB = 20-period SMA ± 2σ, offset 0, on 1-minute spot');
  md.push('- “At band” = touch, outside, or within 5 index points');
  md.push('');
  md.push('**No look-ahead.** At minute T the script only uses rows with minutes ≤ T for spot, candle, TFs, OI Δ, and BB.');
  md.push('');
  md.push('## 2. Verdict');
  md.push('');
  md.push(mdTable(
    ['Question', 'Answer', 'Times'],
    [
      ['Did **4 Bull + BB bottom** ever occur? (needed for stacked CE)', '**No**', String(tot.bot4bull)],
      ['Did **4 Bear + BB top** ever occur? (needed for stacked PE)', '**No**', String(tot.top4bear)],
      ['Did the **stacked BB rule** ever meet?', '**No — 0 fills**', String(yes.length)],
      ['How many times was BB top or bottom **without** that rule?', '**All BB hits**', String(no.length)],
    ],
  ));
  md.push('');
  md.push('## 3. BB hits vs 4TF (all 3 days)');
  md.push('');
  md.push(mdTable(
    ['BB zone', 'Times', '4 Bull', '4 Bear', 'Mixed TFs', 'Stacked rule'],
    [
      ['TOP (upper)', String(tot.top), String(tot.top4bull), String(tot.top4bear), String(tot.topMix), '4 Bear @ top = **0**'],
      ['BOTTOM (lower)', String(tot.bot), String(tot.bot4bull), String(tot.bot4bear), String(tot.botMix), '4 Bull @ bottom = **0**'],
      ['**Total**', `**${tot.top + tot.bot}**`, String(tot.top4bull + tot.bot4bull), String(tot.top4bear + tot.bot4bear), String(tot.topMix + tot.botMix), '**0**'],
    ],
  ));
  md.push('');
  md.push('**What actually lines up (opposite of the proposed stack):**');
  md.push(`- 4 Bull at BB **TOP**: **${tot.top4bull}** times`);
  md.push(`- 4 Bear at BB **BOTTOM**: **${tot.bot4bear}** times`);
  md.push('');
  md.push('On 1-minute BB(20), the upper band is a bull event and the lower band is a bear event. That fights “buy CE at the bottom / PE at the top” when 4TF must also agree.');
  md.push('');

  for (const d of days) {
    md.push(`## 4. ${d.dateKey} summary (${d.first}–${d.last})`);
    md.push('');
    md.push(`Tape bars: ${d.bars} · BB-ready (20+ spots): ${d.ready} · Mid-band (not at line): ${d.mid} · At top or bottom: ${d.hits.length}`);
    md.push('');
    md.push(mdTable(
      ['Zone', 'Times', '4 Bull', '4 Bear', 'Mixed', 'Stacked YES'],
      [
        [
          'TOP',
          String(countPack(d.hits, 'TOP', '4Bull') + countPack(d.hits, 'TOP', '4Bear') + countPack(d.hits, 'TOP', 'Mixed')),
          String(countPack(d.hits, 'TOP', '4Bull')),
          String(countPack(d.hits, 'TOP', '4Bear')),
          String(countPack(d.hits, 'TOP', 'Mixed')),
          String(d.hits.filter((h) => h.bbZone === 'TOP' && h.stackedRule === 'YES').length),
        ],
        [
          'BOTTOM',
          String(countPack(d.hits, 'BOTTOM', '4Bull') + countPack(d.hits, 'BOTTOM', '4Bear') + countPack(d.hits, 'BOTTOM', 'Mixed')),
          String(countPack(d.hits, 'BOTTOM', '4Bull')),
          String(countPack(d.hits, 'BOTTOM', '4Bear')),
          String(countPack(d.hits, 'BOTTOM', 'Mixed')),
          String(d.hits.filter((h) => h.bbZone === 'BOTTOM' && h.stackedRule === 'YES').length),
        ],
      ],
    ));
    md.push('');
    md.push('### Minute log');
    md.push('');
    md.push(mdTable(
      [
        'Time',
        'Spot',
        'BB',
        'Lower',
        'Mid',
        'Upper',
        '%B',
        '15M',
        '5M',
        '3M',
        '1M',
        'TF pack',
        'Candle',
        'Call ΔOI',
        'Put ΔOI',
        'OI (no 4TF/BB)',
        'Stacked 4TF+BB',
        'Note',
      ],
      d.hits.map((h) => [
        h.time,
        fmtSpot(h.spot),
        h.bbZone,
        fmtSpot(h.bbLower),
        fmtSpot(h.bbMid),
        fmtSpot(h.bbUpper),
        String(h.pctB),
        h.tf15,
        h.tf5,
        h.tf3,
        h.tf1,
        h.tfPack,
        h.candle,
        h.callOiL,
        h.putOiL,
        h.oiDecision,
        h.stackedRule,
        h.note,
      ]),
    ));
    md.push('');
  }

  md.push('## 5. Method notes');
  md.push('');
  md.push('- 13 Aug JSON is incomplete (09:15–11:50 only). Afternoon BB hits that day are not in this file.');
  md.push('- OI (no 4TF/BB) is the raw Put-ΔOI + candle decision on that same bar, for context only. It is not a live fill.');
  md.push('- Live paper engine today still uses OI + 4 Bull CE / 4 Bear PE. BB stack is **not** live, because it never met on this tape.');
  md.push('');

  const mdPath = path.join(
    __dirname,
    '..',
    'data',
    'OI-Flow-BB-vs-4TF-Detailed-Report-12-14-Aug-2026.md',
  );
  fs.writeFileSync(mdPath, `${md.join('\n')}\n`);

  const csvHeaders = [
    'date',
    'time',
    'spot',
    'bbZone',
    'bbLower',
    'bbMid',
    'bbUpper',
    'pctB',
    'distLower',
    'distUpper',
    'tf15',
    'tf5',
    'tf3',
    'tf1',
    'tfPack',
    'candle',
    'spotChg1',
    'callOiL',
    'putOiL',
    'callAct',
    'putAct',
    'oiDecision',
    'stackedRule',
    'note',
  ];
  const csvLines = [csvHeaders.join(',')];
  for (const h of allHits) {
    csvLines.push(
      csvHeaders
        .map((k) => {
          const v = h[k];
          const s = v == null ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    );
  }
  const csvPath = path.join(
    __dirname,
    '..',
    'data',
    'OI-Flow-BB-vs-4TF-Detailed-12-14-Aug-2026.csv',
  );
  fs.writeFileSync(csvPath, `${csvLines.join('\n')}\n`);

  const jsonPath = path.join(
    __dirname,
    '..',
    'data',
    'OI-Flow-BB-vs-4TF-Detailed-12-14-Aug-2026.json',
  );
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify({ verdict: { stackedMet: yes.length, bbWithoutRule: no.length, ...tot }, days }, null, 2)}\n`,
  );

  console.log(JSON.stringify({
    stackedMet: yes.length,
    bbWithoutRule: no.length,
    totalBbHits: allHits.length,
    mdPath,
    csvPath,
    jsonPath,
  }, null, 2));
}

main();

/**
 * Advanced BB bounce: many entries × OI gates × SL × TP. Walk-forward.
 * Usage: node scripts/runOiFlowBbAdvancedGrid.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { normalizeRows, buildIndex, bbAt, TRADE_FROM, TRADE_TO } = require('../src/services/oiFlowSignalEngine');
const { loadDayRows } = require('../src/services/oiFlowBbBounceEngine');
const { intervalOiFromRows } = require('../src/utils/oiFlowIntervalOi');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
const PREMIUM = 0.5;
const COOLDOWN = 30;

const STRONG4 = new Set(['long build|writing', 'long build|long unwind', 'writing|buying', 'long unwind|buying']);
const STRONGEST = new Set(['long build|writing', 'writing|buying']);
const ALL5 = new Set([...STRONG4, 'short cover|long unwind']);

function actTail(s) {
  return String(s || '')
    .replace(/^Call /i, '')
    .replace(/^Put /i, '')
    .trim()
    .toLowerCase();
}
function pairKey(c, p) {
  return `${actTail(c)}|${actTail(p)}`;
}
function colorOf(d) {
  if (!Number.isFinite(d) || Math.abs(d) <= 0.5) return 'flat';
  return d > 0 ? 'green' : 'red';
}
function callAction(d, c) {
  if (d > 0 && c > 0) return 'Call long build';
  if (d < 0 && c > 0) return 'Call writing';
  if (d > 0 && c < 0) return 'Call short cover';
  if (d < 0 && c < 0) return 'Call long unwind';
  return 'Call flat';
}
function putAction(d, p) {
  if (d > 0 && p > 0) return 'Put writing';
  if (d < 0 && p > 0) return 'Put buying';
  if (d > 0 && p < 0) return 'Put long unwind';
  if (d < 0 && p < 0) return 'Put short cover';
  return 'Put flat';
}

function flowAt(ctx, minute) {
  const i = ctx.idxOf.get(minute);
  const cur = ctx.byMin.get(minute);
  if (i == null || i < 1 || !cur) return null;
  const prev = ctx.byMin.get(ctx.mins[i - 1]);
  const dSpot = Number(cur.spot) - Number(prev.spot);
  const hasStrikes =
    Array.isArray(cur.strikes) &&
    cur.strikes.length > 0 &&
    Array.isArray(prev.strikes) &&
    prev.strikes.length > 0;
  const interval = intervalOiFromRows(cur, prev);
  const c =
    Number(
      hasStrikes
        ? interval.callsChgOi
        : Number.isFinite(Number(cur.callsChgOi))
          ? cur.callsChgOi
          : interval.callsChgOi,
    ) || 0;
  const p =
    Number(
      hasStrikes
        ? interval.putsChgOi
        : Number.isFinite(Number(cur.putsChgOi))
          ? cur.putsChgOi
          : interval.putsChgOi,
    ) || 0;
  return { d1: dSpot, c, p, callAct: callAction(dSpot, c), putAct: putAction(dSpot, p) };
}

function lookbackSpot(ctx, minutes, ago) {
  const target = minutes - ago;
  if (ctx.byMin.has(target)) return Number(ctx.byMin.get(target).spot);
  for (let m = target; m >= target - 3; m -= 1) {
    if (m < minutes && ctx.byMin.has(m)) return Number(ctx.byMin.get(m).spot);
  }
  return null;
}

function swing(rows, i, n) {
  let hi = -Infinity;
  let lo = Infinity;
  const from = Math.max(0, i - n + 1);
  for (let k = from; k <= i; k += 1) {
    const s = Number(rows[k].spot);
    if (!Number.isFinite(s)) continue;
    if (s > hi) hi = s;
    if (s < lo) lo = s;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { hi, lo, range: hi - lo };
}

function simulate(rows, entryIdx, entrySpot, side, slSpot, tpPts) {
  const minutes = rows[entryIdx].minutes;
  for (let j = entryIdx + 1; j < rows.length; j += 1) {
    const later = rows[j];
    const laterSpot = Number(later.spot);
    const pts = (side === 'PE' ? -(laterSpot - entrySpot) : laterSpot - entrySpot) * PREMIUM;
    if (!Number.isFinite(pts)) continue;
    const hitSl =
      Number.isFinite(slSpot) && (side === 'PE' ? laterSpot >= slSpot : laterSpot <= slSpot);
    if (hitSl) {
      return {
        exitReason: 'SL',
        favorPts: Number(pts.toFixed(1)),
        exitMinutes: later.minutes,
        exitTime: later.time,
        grade: 'Bad',
      };
    }
    if (Number.isFinite(tpPts) && pts >= tpPts) {
      return {
        exitReason: 'TP',
        favorPts: tpPts,
        exitMinutes: later.minutes,
        exitTime: later.time,
        grade: 'Excellent',
      };
    }
  }
  const last = rows[rows.length - 1];
  const pts = (side === 'PE' ? -(Number(last.spot) - entrySpot) : Number(last.spot) - entrySpot) * PREMIUM;
  const favorPts = Number((Number.isFinite(pts) ? pts : 0).toFixed(1));
  return {
    exitReason: 'EOD',
    favorPts,
    exitMinutes: last.minutes,
    exitTime: last.time,
    grade: favorPts >= 0 ? 'Good' : 'Bad',
  };
}

function paperBook(fills, dayRows, slKind, tpPts) {
  const byDate = new Map();
  for (const f of fills) {
    if (!byDate.has(f.dateKey)) byDate.set(f.dateKey, []);
    byDate.get(f.dateKey).push(f);
  }
  const taken = [];
  for (const [dateKey, list] of byDate) {
    const rows = dayRows.get(dateKey);
    list.sort((a, b) => a.entryI - b.entryI);
    let openUntil = null;
    let cooldownUntil = null;
    let last = null;
    for (const f of list) {
      const minutes = rows[f.entryI].minutes;
      if (openUntil != null && minutes < openUntil) continue;
      if (openUntil != null && minutes >= openUntil) {
        cooldownUntil = openUntil + COOLDOWN;
        openUntil = null;
      }
      if (cooldownUntil != null && minutes < cooldownUntil) continue;
      if (last != null && minutes <= last) continue;
      const slSpot = resolveSl(rows, f, slKind);
      if (slKind !== 'none' && !Number.isFinite(slSpot)) continue;
      if (slKind !== 'none') {
        const width = f.side === 'CE' ? f.entrySpot - slSpot : slSpot - f.entrySpot;
        if (!(width > 0.5)) continue;
      }
      const exit = simulate(rows, f.entryI, f.entrySpot, f.side, slKind === 'none' ? null : slSpot, tpPts);
      taken.push({ ...f, ...exit, slSpot, slKind, tpPts });
      last = minutes;
      openUntil = exit.exitMinutes;
    }
  }
  const sum = taken.reduce((a, t) => a + (Number(t.favorPts) || 0), 0);
  const wins = taken.filter((t) => Number(t.favorPts) > 0).length;
  return {
    trades: taken.length,
    wins,
    hitPct: taken.length ? Number(((wins / taken.length) * 100).toFixed(1)) : null,
    sumPts: Number(sum.toFixed(1)),
    tp: taken.filter((t) => t.exitReason === 'TP').length,
    sl: taken.filter((t) => t.exitReason === 'SL').length,
    eod: taken.filter((t) => t.exitReason === 'EOD').length,
    samples: taken.slice(0, 16).map((t) => ({
      dateKey: t.dateKey,
      signal: t.signalTime,
      entry: t.entryTime,
      side: t.side,
      pts: t.favorPts,
      exit: t.exitReason,
    })),
  };
}

function resolveSl(rows, f, kind) {
  const i = f.entryI;
  const entry = f.entrySpot;
  const side = f.side;
  const sw = (n) => swing(rows, Math.max(0, i - 1), n);
  if (kind === 'none') return null;
  if (kind === 'prev1') {
    const s = swing(rows, i - 1, 2);
    return side === 'CE' ? s?.lo : s?.hi;
  }
  if (kind === 'signalBar') {
    const s = swing(rows, f.signalI, 2);
    return side === 'CE' ? s?.lo : s?.hi;
  }
  if (kind === 'swing3') {
    const s = sw(3);
    return side === 'CE' ? s?.lo : s?.hi;
  }
  if (kind === 'swing5') {
    const s = sw(5);
    return side === 'CE' ? s?.lo : s?.hi;
  }
  if (kind === 'swing15') {
    const s = sw(15);
    return side === 'CE' ? s?.lo : s?.hi;
  }
  if (kind === 'bbMid') return f.bbMid;
  if (kind === 'band') return side === 'CE' ? f.bbLower : f.bbUpper;
  if (kind === 'spot8') return side === 'CE' ? entry - 8 : entry + 8;
  if (kind === 'spot16') return side === 'CE' ? entry - 16 : entry + 16;
  if (kind === 'spot25') return side === 'CE' ? entry - 25 : entry + 25;
  if (kind === 'range5x1') {
    const s = sw(5);
    const r = Math.max(8, s?.range || 8);
    return side === 'CE' ? entry - r : entry + r;
  }
  if (kind === 'range5x1_5') {
    const s = sw(5);
    const r = Math.max(10, (s?.range || 10) * 1.5);
    return side === 'CE' ? entry - r : entry + r;
  }
  return null;
}

function oiSetOk(key, setName, side) {
  const set = setName === 'strongest' ? STRONGEST : setName === 'all5' ? ALL5 : STRONG4;
  if (!set.has(key)) return false;
  if (side === 'CE') return key.startsWith('long build') || key.startsWith('short cover');
  return key.startsWith('writing') || key.startsWith('long unwind');
}

function minOiOk(c, p, minL) {
  if (!minL) return true;
  return Math.max(Math.abs(c), Math.abs(p)) >= minL * 100000;
}

async function main() {
  if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
  const dayRows = new Map();
  const bars = [];

  for (const dateKey of DATES) {
    const loaded = await loadDayRows(dateKey);
    const rows = loaded.rows.map((r) => ({ ...r, dateKey }));
    dayRows.set(dateKey, rows);
    console.log(`${dateKey} ${loaded.source} ${rows.length}`);
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.minutes < TRADE_FROM || row.minutes > TRADE_TO) continue;
      const ctx = buildIndex(rows.slice(0, i + 1));
      const flow = flowAt(ctx, row.minutes);
      if (!flow) continue;
      const bb = bbAt(ctx, row.minutes);
      const d5 = Number(row.spot) - lookbackSpot(ctx, row.minutes, 5);
      bars.push({
        dateKey,
        i,
        minutes: row.minutes,
        time: row.time,
        spot: Number(row.spot),
        candle1: colorOf(flow.d1),
        candle5: colorOf(d5),
        pairKey: pairKey(flow.callAct, flow.putAct),
        callChg: flow.c,
        putChg: flow.p,
        bbOk: Boolean(bb?.ok),
        atLower: Boolean(bb?.atLower),
        atUpper: Boolean(bb?.atUpper),
        pierceLower: Boolean(bb?.ok && Number(row.spot) < bb.lower),
        pierceUpper: Boolean(bb?.ok && Number(row.spot) > bb.upper),
        bbMid: bb?.mid,
        bbLower: bb?.lower,
        bbUpper: bb?.upper,
      });
    }
  }

  const byKey = new Map();
  for (const b of bars) byKey.set(`${b.dateKey}:${b.i}`, b);

  function nextBar(b) {
    return byKey.get(`${b.dateKey}:${b.i + 1}`) || null;
  }
  function next2(b) {
    return byKey.get(`${b.dateKey}:${b.i + 2}`) || null;
  }

  const entries = [
    { id: 'next|strong4|oi0', confirm: 'next', oi: 'strong4', minL: 0, extra: 'none' },
    { id: 'next|strong4|oi1L', confirm: 'next', oi: 'strong4', minL: 1, extra: 'none' },
    { id: 'next|strong4|oi2L', confirm: 'next', oi: 'strong4', minL: 2, extra: 'none' },
    { id: 'next|strongest|oi1L', confirm: 'next', oi: 'strongest', minL: 1, extra: 'none' },
    { id: 'next|all5|oi1L', confirm: 'next', oi: 'all5', minL: 1, extra: 'none' },
    { id: 'same|strong4|oi1L', confirm: 'same', oi: 'strong4', minL: 1, extra: 'none' },
    { id: 'next|strong4|oi1L|5m', confirm: 'next', oi: 'strong4', minL: 1, extra: '5m' },
    { id: 'next2|strong4|oi1L', confirm: 'next2', oi: 'strong4', minL: 1, extra: 'none' },
    { id: 'reclaim|strong4|oi1L', confirm: 'same', oi: 'strong4', minL: 1, extra: 'reclaim' },
    { id: 'next|strong4|oi1L|pierce', confirm: 'next', oi: 'strong4', minL: 1, extra: 'pierce' },
  ];

  const sls = [
    'prev1',
    'signalBar',
    'swing3',
    'swing5',
    'swing15',
    'bbMid',
    'band',
    'spot8',
    'spot16',
    'spot25',
    'range5x1',
    'range5x1_5',
    'none',
  ];
  const tps = [10, 15];

  function collectFills(ent) {
    const fills = [];
    for (const b of bars) {
      if (!b.bbOk) continue;
      const trySide = (side) => {
        const need = side === 'CE' ? 'green' : 'red';
        const atBand = side === 'CE' ? b.atLower : b.atUpper;
        const pierce = side === 'CE' ? b.pierceLower : b.pierceUpper;
        if (ent.extra === 'pierce' && !pierce) return;
        if (ent.extra !== 'pierce' && ent.extra !== 'reclaim' && !atBand) return;
        if (ent.extra === 'reclaim') {
          const prev = byKey.get(`${b.dateKey}:${b.i - 1}`);
          if (!prev) return;
          const was = side === 'CE' ? prev.atLower || prev.pierceLower : prev.atUpper || prev.pierceUpper;
          const nowIn = side === 'CE' ? !b.atLower : !b.atUpper;
          if (!was || !nowIn) return;
        }
        if (b.candle1 !== need) return;
        if (!oiSetOk(b.pairKey, ent.oi, side)) return;
        if (!minOiOk(b.callChg, b.putChg, ent.minL)) return;
        if (ent.extra === '5m' && b.candle5 !== need) return;

        let fill = b;
        if (ent.confirm === 'next') {
          fill = nextBar(b);
          if (!fill || fill.candle1 !== need) return;
        } else if (ent.confirm === 'next2') {
          const n1 = nextBar(b);
          const n2 = next2(b);
          if (!n1 || n1.candle1 !== need) return;
          if (!n2 || n2.candle1 !== need) return;
          fill = n2;
        }
        fills.push({
          dateKey: b.dateKey,
          signalI: b.i,
          signalTime: b.time,
          entryI: fill.i,
          entryTime: fill.time,
          entrySpot: fill.spot,
          side,
          bbMid: b.bbMid,
          bbLower: b.bbLower,
          bbUpper: b.bbUpper,
        });
      };
      trySide('CE');
      trySide('PE');
    }
    return fills;
  }

  const ranked = [];
  for (const ent of entries) {
    const fills = collectFills(ent);
    for (const slKind of sls) {
      for (const tpPts of tps) {
        const book = paperBook(fills, dayRows, slKind, tpPts);
        if (book.trades < 4) continue;
        const score =
          book.sumPts * 1.2 +
          (book.hitPct || 0) * 0.35 +
          book.tp * 2 -
          book.sl * 0.4 +
          Math.min(book.trades, 12);
        ranked.push({
          entry: ent.id,
          slKind,
          tpPts,
          rawFills: fills.length,
          trades: book.trades,
          wins: book.wins,
          hitPct: book.hitPct,
          sumPts: book.sumPts,
          tpN: book.tp,
          slN: book.sl,
          eodN: book.eod,
          samples: book.samples,
          score,
        });
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score || b.sumPts - a.sumPts);
  const bestPts = [...ranked].sort((a, b) => b.sumPts - a.sumPts || (b.hitPct || 0) - (a.hitPct || 0));
  const bestHit = [...ranked]
    .filter((r) => r.trades >= 6)
    .sort((a, b) => (b.hitPct || 0) - (a.hitPct || 0) || b.sumPts - a.sumPts);

  const out = {
    generatedAt: new Date().toISOString(),
    lookAhead: 'Signal and fill use bars up to that minute only. Later bars score exits.',
    dates: DATES,
    bars: bars.length,
    combosKept: ranked.length,
    bestBalanced: ranked.slice(0, 15).map(stripSamples),
    bestSumPts: bestPts.slice(0, 12).map(stripSamples),
    bestHit: bestHit.slice(0, 10).map(stripSamples),
    winner: ranked[0] || null,
  };
  function stripSamples(r) {
    const { samples, score, ...rest } = r;
    return rest;
  }

  const file = path.join(__dirname, '..', 'data', 'oi-flow-bb-advanced-grid-2026-08-12-14.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\nKept ${ranked.length} combos (trades≥4)`);
  console.log('\n=== Best balanced ===');
  for (const r of ranked.slice(0, 10)) {
    console.log(
      `${r.entry}  SL=${r.slKind} TP=${r.tpPts}  n=${r.trades} hit=${r.hitPct}% pts=${r.sumPts} TP/SL/EOD ${r.tpN}/${r.slN}/${r.eodN}`,
    );
  }
  console.log('\n=== Best sum pts ===');
  for (const r of bestPts.slice(0, 8)) {
    console.log(
      `${r.entry}  SL=${r.slKind} TP=${r.tpPts}  n=${r.trades} hit=${r.hitPct}% pts=${r.sumPts} TP/SL ${r.tpN}/${r.slN}`,
    );
  }
  console.log(`\nWrote ${file}`);
  if (mongoose.connection.readyState) await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

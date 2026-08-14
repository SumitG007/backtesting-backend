/**
 * Walk-forward multi-scenario research: BB × OI pairs × 1m/5m/15m candle × TF.
 * Entry uses current + past bars only. Forward bars used only to score.
 *
 * Usage: node scripts/runOiFlowBbOiLoopResearch.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { normalizeRows, buildIndex, bbAt, tfsAt, TRADE_FROM, TRADE_TO } = require('../src/services/oiFlowSignalEngine');
const {
  loadDayRows,
  pairFavours,
  prevCandleRange,
  simulateExit,
} = require('../src/services/oiFlowBbBounceEngine');
const { intervalOiFromRows } = require('../src/utils/oiFlowIntervalOi');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
const PREMIUM = 0.5;
const BIG_MOVE = 15;

const STRONG4 = new Set(['long build|writing', 'long build|long unwind', 'writing|buying', 'long unwind|buying']);
const ALL5 = new Set([...STRONG4, 'short cover|long unwind']);
const STRONGEST = new Set(['long build|writing', 'writing|buying']);

function actTail(label) {
  return String(label || '')
    .replace(/^Call /i, '')
    .replace(/^Put /i, '')
    .trim()
    .toLowerCase();
}

function pairKey(callAct, putAct) {
  return `${actTail(callAct)}|${actTail(putAct)}`;
}

function callAction(dSpot, c) {
  if (dSpot > 0 && c > 0) return 'Call long build';
  if (dSpot < 0 && c > 0) return 'Call writing';
  if (dSpot > 0 && c < 0) return 'Call short cover';
  if (dSpot < 0 && c < 0) return 'Call long unwind';
  return 'Call flat';
}

function putAction(dSpot, p) {
  if (dSpot > 0 && p > 0) return 'Put writing';
  if (dSpot < 0 && p > 0) return 'Put buying';
  if (dSpot > 0 && p < 0) return 'Put long unwind';
  if (dSpot < 0 && p < 0) return 'Put short cover';
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
  return {
    d1: dSpot,
    callChg: c,
    putChg: p,
    callAct: callAction(dSpot, c),
    putAct: putAction(dSpot, p),
  };
}

function colorOf(d) {
  if (!Number.isFinite(d) || Math.abs(d) <= 0.5) return 'flat';
  return d > 0 ? 'green' : 'red';
}

function lookbackSpot(ctx, minutes, ago) {
  const target = minutes - ago;
  if (ctx.byMin.has(target)) return Number(ctx.byMin.get(target).spot);
  for (let m = target; m >= target - 3; m -= 1) {
    if (m < minutes && ctx.byMin.has(m)) return Number(ctx.byMin.get(m).spot);
  }
  return null;
}

function forwardSpot(rows, i, ahead) {
  const want = rows[i].minutes + ahead;
  for (let j = i + 1; j < rows.length; j += 1) {
    if (rows[j].minutes >= want) return Number(rows[j].spot);
  }
  return null;
}

function favorPts(side, dSpot) {
  if (!Number.isFinite(dSpot)) return null;
  return Number(((side === 'PE' ? -dSpot : dSpot) * PREMIUM).toFixed(2));
}

function extractBar(rows, i) {
  const row = rows[i];
  const minutes = row.minutes;
  if (minutes < TRADE_FROM || minutes > TRADE_TO) return null;
  const ctx = buildIndex(rows.slice(0, i + 1));
  const flow = flowAt(ctx, minutes);
  if (!flow) return null;
  const bb = bbAt(ctx, minutes);
  const tfs = tfsAt(ctx, minutes, row.spot);
  const d5 = Number(row.spot) - lookbackSpot(ctx, minutes, 5);
  const d15 = Number(row.spot) - lookbackSpot(ctx, minutes, 15);
  const key = pairKey(flow.callAct, flow.putAct);
  const sideHint = pairFavours(flow.callAct, flow.putAct);
  const fwd5s = forwardSpot(rows, i, 5);
  const fwd15s = forwardSpot(rows, i, 15);
  const fwd30s = forwardSpot(rows, i, 30);
  const dFwd5 = Number.isFinite(fwd5s) ? fwd5s - Number(row.spot) : null;
  const dFwd15 = Number.isFinite(fwd15s) ? fwd15s - Number(row.spot) : null;
  const dFwd30 = Number.isFinite(fwd30s) ? fwd30s - Number(row.spot) : null;
  return {
    dateKey: row.dateKey,
    i,
    minutes,
    time: row.time,
    spot: Number(row.spot),
    bbOk: Boolean(bb?.ok),
    bbZone: bb?.zone || 'na',
    atLower: Boolean(bb?.atLower),
    atUpper: Boolean(bb?.atUpper),
    pierceLower: Boolean(bb?.ok && Number(row.spot) < bb.lower),
    pierceUpper: Boolean(bb?.ok && Number(row.spot) > bb.upper),
    candle1: colorOf(flow.d1),
    candle5: colorOf(d5),
    candle15: colorOf(d15),
    tf1: tfs.tf1.label,
    tf5: tfs.tf5.label,
    tf15: tfs.tf15.label,
    tf3: tfs.tf3.label,
    allBull: tfs.allBull,
    allBear: tfs.allBear,
    pair: `${actTail(flow.callAct)} / ${actTail(flow.putAct)}`,
    pairKey: key,
    oiSide: sideHint,
    callChg: flow.callChg,
    putChg: flow.putChg,
    dFwd5,
    dFwd15,
    dFwd30,
  };
}

function tfOk(feat, spec, want) {
  if (spec === 'none') return true;
  const need = want === 'CE' ? 'Bull' : 'Bear';
  const parts = spec.split('+');
  const map = { '1': feat.tf1, '5': feat.tf5, '15': feat.tf15, '3': feat.tf3 };
  return parts.every((p) => map[p] === need);
}

function candleOk(feat, spec, want) {
  const need = want === 'CE' ? 'green' : 'red';
  if (spec === '1m') return feat.candle1 === need;
  if (spec === '5m') return feat.candle5 === need;
  if (spec === '15m') return feat.candle15 === need;
  if (spec === '1m+5m') return feat.candle1 === need && feat.candle5 === need;
  if (spec === '1m+15m') return feat.candle1 === need && feat.candle15 === need;
  if (spec === '5m+15m') return feat.candle5 === need && feat.candle15 === need;
  if (spec === '1m+5m+15m') {
    return feat.candle1 === need && feat.candle5 === need && feat.candle15 === need;
  }
  return false;
}

function oiOk(feat, spec, want) {
  if (spec === 'none') return true;
  const side = want === 'CE' ? 'CALL' : 'PUT';
  if (feat.oiSide !== side) return false;
  if (spec === 'all5') return ALL5.has(feat.pairKey);
  if (spec === 'strong4') return STRONG4.has(feat.pairKey);
  if (spec === 'strongest') return STRONGEST.has(feat.pairKey);
  return false;
}

function bbOk(feat, spec, want) {
  if (!feat.bbOk) return false;
  if (spec === 'touch') return want === 'CE' ? feat.atLower : feat.atUpper;
  if (spec === 'pierce') return want === 'CE' ? feat.pierceLower : feat.pierceUpper;
  return false;
}

function buildScenarios() {
  const list = [];
  for (const bb of ['touch', 'pierce']) {
    for (const oi of ['none', 'all5', 'strong4', 'strongest']) {
      for (const candle of ['1m', '5m', '1m+5m', '15m', '1m+15m', '5m+15m', '1m+5m+15m']) {
        for (const tf of ['none', '1', '5', '15', '1+5', '5+15', '1+5+15']) {
          for (const confirm of [false, true]) {
            list.push({
              id: `${bb}|${oi}|${candle}|tf${tf}|${confirm ? 'next' : 'same'}`,
              bb,
              oi,
              candle,
              tf,
              confirm,
            });
          }
        }
      }
    }
  }
  return list;
}

function matchSide(feat, sc, want) {
  return bbOk(feat, sc.bb, want) && oiOk(feat, sc.oi, want) && candleOk(feat, sc.candle, want) && tfOk(feat, sc.tf, want);
}

function scoreHits(hits) {
  const n = hits.length;
  if (!n) {
    return { n: 0, hit5: null, hit15: null, hit30: null, mean15: null, mean30: null, ce: 0, pe: 0 };
  }
  const take = (key) => hits.map((h) => h[key]).filter((v) => v != null);
  const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null);
  const hitPct = (arr) =>
    arr.length ? Number(((arr.filter((v) => v > 0).length / arr.length) * 100).toFixed(1)) : null;
  const a5 = take('p5');
  const a15 = take('p15');
  const a30 = take('p30');
  return {
    n,
    ce: hits.filter((h) => h.side === 'CE').length,
    pe: hits.filter((h) => h.side === 'PE').length,
    hit5: hitPct(a5),
    hit15: hitPct(a15),
    hit30: hitPct(a30),
    mean5: avg(a5),
    mean15: avg(a15),
    mean30: avg(a30),
  };
}

function paperBook(hits, dayRows) {
  const byDate = new Map();
  for (const h of hits) {
    if (!byDate.has(h.dateKey)) byDate.set(h.dateKey, []);
    byDate.get(h.dateKey).push(h);
  }
  const taken = [];
  for (const [dateKey, list] of byDate) {
    const rows = dayRows.get(dateKey);
    list.sort((a, b) => a.minutes - b.minutes);
    let openUntil = null;
    let cooldownUntil = null;
    let last = null;
    for (const h of list) {
      if (openUntil != null && h.minutes < openUntil) continue;
      if (openUntil != null && h.minutes >= openUntil) {
        cooldownUntil = openUntil + 30;
        openUntil = null;
      }
      if (cooldownUntil != null && h.minutes < cooldownUntil) continue;
      if (last != null && h.minutes <= last) continue;
      const exit = simulateExit(rows, h.i, h.spot, h.side, h.slSpot);
      taken.push({
        dateKey,
        time: h.time,
        side: h.side,
        favorPts: exit.favorPts,
        exitReason: exit.exitReason,
        grade: exit.grade,
      });
      last = h.minutes;
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
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function topMap(map, n = 8) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, c]) => ({ k, c }));
}

async function main() {
  if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);

  const dayRows = new Map();
  const feats = [];
  for (const dateKey of DATES) {
    const loaded = await loadDayRows(dateKey);
    const rows = loaded.rows.map((r) => ({ ...r, dateKey }));
    dayRows.set(dateKey, rows);
    console.log(`${dateKey} ${loaded.source} ${rows.length} bars ${rows[0]?.time}–${rows[rows.length - 1]?.time}`);
    for (let i = 1; i < rows.length; i += 1) {
      const f = extractBar(rows, i);
      if (!f) continue;
      const prev = prevCandleRange(rows, i);
      f.slCe = prev ? prev.low : null;
      f.slPe = prev ? prev.high : null;
      const next = rows[i + 1];
      f.nextCandle1 = next ? colorOf(Number(next.spot) - Number(rows[i].spot)) : null;
      f.nextI = i + 1 < rows.length ? i + 1 : null;
      f.nextSpot = next ? Number(next.spot) : null;
      f.nextMinutes = next ? next.minutes : null;
      f.nextTime = next ? next.time : null;
      feats.push(f);
    }
  }

  const upBig = feats.filter((f) => Number(f.dFwd15) >= BIG_MOVE);
  const dnBig = feats.filter((f) => Number(f.dFwd15) <= -BIG_MOVE);
  const loopUp = new Map();
  const loopDn = new Map();
  for (const f of upBig) {
    bump(loopUp, `bb:${f.bbZone}|oi:${f.pair}|1m:${f.candle1}|5m:${f.candle5}|15m:${f.candle15}|tf5:${f.tf5}|tf15:${f.tf15}`);
  }
  for (const f of dnBig) {
    bump(loopDn, `bb:${f.bbZone}|oi:${f.pair}|1m:${f.candle1}|5m:${f.candle5}|15m:${f.candle15}|tf5:${f.tf5}|tf15:${f.tf15}`);
  }

  function share(arr, pred) {
    if (!arr.length) return null;
    return Number(((arr.filter(pred).length / arr.length) * 100).toFixed(1));
  }

  const moveCensus = {
    up15: {
      n: upBig.length,
      atLower: share(upBig, (f) => f.atLower),
      atUpper: share(upBig, (f) => f.atUpper),
      mid: share(upBig, (f) => f.bbZone === 'mid'),
      green1: share(upBig, (f) => f.candle1 === 'green'),
      green5: share(upBig, (f) => f.candle5 === 'green'),
      green15: share(upBig, (f) => f.candle15 === 'green'),
      tf5Bull: share(upBig, (f) => f.tf5 === 'Bull'),
      tf15Bull: share(upBig, (f) => f.tf15 === 'Bull'),
      oiCall: share(upBig, (f) => f.oiSide === 'CALL'),
      topCombos: topMap(loopUp, 10),
    },
    down15: {
      n: dnBig.length,
      atLower: share(dnBig, (f) => f.atLower),
      atUpper: share(dnBig, (f) => f.atUpper),
      mid: share(dnBig, (f) => f.bbZone === 'mid'),
      red1: share(dnBig, (f) => f.candle1 === 'red'),
      red5: share(dnBig, (f) => f.candle5 === 'red'),
      red15: share(dnBig, (f) => f.candle15 === 'red'),
      tf5Bear: share(dnBig, (f) => f.tf5 === 'Bear'),
      tf15Bear: share(dnBig, (f) => f.tf15 === 'Bear'),
      oiPut: share(dnBig, (f) => f.oiSide === 'PUT'),
      topCombos: topMap(loopDn, 10),
    },
  };

  const scenarios = buildScenarios();
  const ranked = [];
  for (const sc of scenarios) {
    const hits = [];
    for (const f of feats) {
      const trySide = (want) => {
        if (!matchSide(f, sc, want)) return;
        if (sc.confirm) {
          const need = want === 'CE' ? 'green' : 'red';
          if (f.nextCandle1 !== need || f.nextI == null) return;
        }
        const side = want;
        const entrySpot = sc.confirm ? f.nextSpot : f.spot;
        const entryI = sc.confirm ? f.nextI : f.i;
        if (entrySpot == null) return;
        const d5 = f.dFwd5;
        const d15 = f.dFwd15;
        const d30 = f.dFwd30;
        const adj = sc.confirm && Number.isFinite(f.spot) ? entrySpot - f.spot : 0;
        const p5 = favorPts(side, d5 != null ? d5 - adj : null);
        const p15 = favorPts(side, d15 != null ? d15 - adj : null);
        const p30 = favorPts(side, d30 != null ? d30 - adj : null);
        hits.push({
          dateKey: f.dateKey,
          i: entryI,
          minutes: sc.confirm ? f.nextMinutes : f.minutes,
          time: sc.confirm ? f.nextTime : f.time,
          spot: entrySpot,
          side,
          slSpot: side === 'CE' ? f.slCe : f.slPe,
          p5,
          p15,
          p30,
        });
      };
      trySide('CE');
      trySide('PE');
    }
    const raw = scoreHits(hits);
    if (raw.n < 5) continue;
    const book = paperBook(hits, dayRows);
    ranked.push({
      id: sc.id,
      bb: sc.bb,
      oi: sc.oi,
      candle: sc.candle,
      tf: sc.tf,
      confirm: sc.confirm,
      raw,
      book,
      score:
        (raw.hit15 || 0) * 0.45 +
        (raw.mean15 || 0) * 4 +
        (book.hitPct || 0) * 0.25 +
        (book.sumPts || 0) * 0.4 +
        Math.min(raw.n, 40) * 0.15,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  const minN = ranked.filter((r) => r.raw.n >= 8);
  const bestRaw = [...minN].sort((a, b) => (b.raw.hit15 || 0) - (a.raw.hit15 || 0) || (b.raw.mean15 || 0) - (a.raw.mean15 || 0));
  const bestBook = [...ranked]
    .filter((r) => r.book.trades >= 5)
    .sort((a, b) => b.book.sumPts - a.book.sumPts || (b.book.hitPct || 0) - (a.book.hitPct || 0));
  const bestBalanced = minN.slice(0, 12);

  const out = {
    generatedAt: new Date().toISOString(),
    lookAhead: 'Entry = current+past only. Forward 5/15/30m and paper TP/SL use later bars for scoring only.',
    dates: DATES,
    barsScored: feats.length,
    scenariosTried: scenarios.length,
    scenariosWithNge5: ranked.length,
    moveCensus,
    bestBalanced,
    bestHit15: bestRaw.slice(0, 10),
    bestBook: bestBook.slice(0, 10),
  };

  const file = path.join(__dirname, '..', 'data', 'oi-flow-bb-oi-loop-research-2026-08-12-14.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);

  console.log(`\nScored ${feats.length} bars × ${scenarios.length} scenarios · ${ranked.length} with n≥5`);
  console.log(
    `Big +15m up ${moveCensus.up15.n} · lowerBB ${moveCensus.up15.atLower}% · OI CALL ${moveCensus.up15.oiCall}% · 5m green ${moveCensus.up15.green5}% · tf5 Bull ${moveCensus.up15.tf5Bull}%`,
  );
  console.log(
    `Big +15m down ${moveCensus.down15.n} · upperBB ${moveCensus.down15.atUpper}% · OI PUT ${moveCensus.down15.oiPut}% · 5m red ${moveCensus.down15.red5}% · tf5 Bear ${moveCensus.down15.tf5Bear}%`,
  );
  console.log('\n=== Best balanced (n≥8) ===');
  for (const r of bestBalanced.slice(0, 8)) {
    console.log(
      `${r.id}  n=${r.raw.n} CE/PE ${r.raw.ce}/${r.raw.pe}  hit15=${r.raw.hit15}% mean15=${r.raw.mean15}  book ${r.book.trades} hit ${r.book.hitPct}% pts ${r.book.sumPts} TP/SL ${r.book.tp}/${r.book.sl}`,
    );
  }
  console.log('\n=== Best paper book sum pts (trades≥5) ===');
  for (const r of bestBook.slice(0, 8)) {
    console.log(
      `${r.id}  book ${r.book.trades} hit ${r.book.hitPct}% pts ${r.book.sumPts} TP/SL ${r.book.tp}/${r.book.sl}  raw n=${r.raw.n} hit15=${r.raw.hit15}%`,
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

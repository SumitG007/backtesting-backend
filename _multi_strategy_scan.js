/**
 * Future-blind multi-strategy scan on Aug 12 (full day) + Aug 13 (partial).
 * Goal: find which patterns grab points — not assume 30/15/5/3/1 is right.
 *
 * Usage: node _multi_strategy_scan.js
 */
const fs = require('fs');
const path = require('path');

const DAYS = [
  { key: '2026-08-12', file: 'oi-flow-2026-08-12.json', label: 'YDAY (full)' },
  { key: '2026-08-13', file: 'oi-flow-2026-08-13.json', label: 'TODAY (to ~11:50)' },
];

const TRADE_FROM = 9 * 60 + 30;
const TRADE_TO = 14 * 60 + 30;
const MIN_HOLD = 30; // minutes between entries (shared per strategy)
const HORIZONS = [5, 15, 30, 60];

function loadDay(file) {
  const p = path.join(__dirname, 'data', file);
  const rows = JSON.parse(fs.readFileSync(p, 'utf8'))
    .map((r) => ({
      time: r.time,
      minutes: Number(r.minutes),
      spot: Number(r.spot),
      dayCallChgOi: Number(r.dayCallChgOi) || 0,
      dayPutChgOi: Number(r.dayPutChgOi) || 0,
      callsChgOi: Number(r.callsChgOi) || 0,
      putsChgOi: Number(r.putsChgOi) || 0,
      diffInOi: Number(r.diffInOi) || 0,
      chngInDir: Number(r.chngInDir) || 0,
      sentiment: r.sentiment,
    }))
    .filter((r) => Number.isFinite(r.minutes))
    .sort((a, b) => a.minutes - b.minutes);
  const byMin = new Map(rows.map((r) => [r.minutes, r]));
  const mins = rows.map((r) => r.minutes);
  const idxOf = new Map(mins.map((m, i) => [m, i]));
  return { rows, byMin, mins, idxOf };
}

function rowAt(ctx, m) {
  return ctx.byMin.get(m) || null;
}

function forwardRow(ctx, minute, ahead) {
  const target = minute + ahead;
  if (ctx.byMin.has(target)) return ctx.byMin.get(target);
  for (let m = target; m <= target + 3; m++) {
    if (ctx.byMin.has(m)) return ctx.byMin.get(m);
  }
  return null;
}

function prevRow(ctx, minute) {
  const i = ctx.idxOf.get(minute);
  if (i == null || i < 1) return null;
  return rowAt(ctx, ctx.mins[i - 1]);
}

function dSpot(ctx, minute) {
  const cur = rowAt(ctx, minute);
  const prev = prevRow(ctx, minute);
  if (!cur || !prev) return 0;
  return Number(cur.spot) - Number(prev.spot);
}

function spotN(ctx, minute, n) {
  const i = ctx.idxOf.get(minute);
  if (i == null || i < n) return null;
  const cur = rowAt(ctx, minute);
  const past = rowAt(ctx, ctx.mins[i - n]);
  if (!cur || !past) return null;
  return Number(cur.spot) - Number(past.spot);
}

function minuteScore(cur, prev) {
  if (!cur || !prev) return 0;
  const ds = Number(cur.spot) - Number(prev.spot);
  const c = Number(cur.callsChgOi) || 0;
  const p = Number(cur.putsChgOi) || 0;
  let s = 0;
  if (ds > 0) s += 1;
  else if (ds < 0) s -= 1;
  if (ds > 0 && c > 0) s += 1;
  if (ds < 0 && c > 0) s -= 1;
  if (ds > 0 && c < 0) s += 1;
  if (ds < 0 && c < 0) s -= 1;
  if (ds > 0 && p > 0) s += 1;
  if (ds < 0 && p > 0) s -= 1;
  if (ds > 0 && p < 0) s += 1;
  if (ds < 0 && p < 0) s -= 1;
  if (Number(cur.chngInDir) > 0) s += 1;
  else if (Number(cur.chngInDir) < 0) s -= 1;
  return s;
}

function labelFromScore(s) {
  if (s > 0) return 'Bull';
  if (s < 0) return 'Bear';
  return 'WAIT';
}

function tfBias(ctx, minute, W, needBull, needBear) {
  const i = ctx.idxOf.get(minute);
  if (i == null || i < W) return 'WAIT';
  let bull = 0;
  let bear = 0;
  for (let k = i - W + 1; k <= i; k++) {
    const cur = rowAt(ctx, ctx.mins[k]);
    const prev = k > 0 ? rowAt(ctx, ctx.mins[k - 1]) : null;
    const lab = labelFromScore(minuteScore(cur, prev));
    if (lab === 'Bull') bull += 1;
    else if (lab === 'Bear') bear += 1;
  }
  let bias = 'WAIT';
  if (bull >= needBull) bias = 'Bull';
  else if (bear >= needBear) bias = 'Bear';
  if (W >= 5 && bias !== 'WAIT') {
    const cur = rowAt(ctx, minute);
    const past = rowAt(ctx, ctx.mins[i - W + 1]);
    if (cur && past) {
      const ds = Number(cur.spot) - Number(past.spot);
      if (bias === 'Bull' && ds < 0) bias = 'WAIT';
      if (bias === 'Bear' && ds > 0) bias = 'WAIT';
    }
  }
  return bias;
}

function callAct(ds, c) {
  if (ds > 0 && c > 0) return 'long_build';
  if (ds < 0 && c > 0) return 'writing';
  if (ds > 0 && c < 0) return 'short_cover';
  if (ds < 0 && c < 0) return 'long_unwind';
  return 'flat';
}

function putAct(ds, p) {
  if (ds > 0 && p > 0) return 'writing';
  if (ds < 0 && p > 0) return 'buying';
  if (ds > 0 && p < 0) return 'long_unwind';
  if (ds < 0 && p < 0) return 'short_cover';
  return 'flat';
}

function actsAt(ctx, minute) {
  const cur = rowAt(ctx, minute);
  const prev = prevRow(ctx, minute);
  if (!cur || !prev) return { ca: 'flat', pa: 'flat', ds: 0, c: 0, p: 0 };
  const ds = Number(cur.spot) - Number(prev.spot);
  const c = Number(cur.callsChgOi) || 0;
  const p = Number(cur.putsChgOi) || 0;
  return { ca: callAct(ds, c), pa: putAct(ds, p), ds, c, p, cur };
}

function grade(decision, entrySpot, futureSpot) {
  if (!Number.isFinite(futureSpot) || !Number.isFinite(entrySpot)) return null;
  const move = futureSpot - entrySpot;
  const signed = decision === 'CALL BUY' ? move : -move;
  return { move, signed, hit: signed > 0 };
}

function accuracyBucket(signed15, signed30, signed60) {
  const vals = [signed15, signed30, signed60].filter((v) => v != null);
  if (!vals.length) return null;
  const hits = vals.filter((v) => v > 0).length;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (hits === vals.length && avg >= 8) return 'Excellent';
  if (hits >= Math.ceil(vals.length * 0.66) && avg > 0) return 'Good';
  if (avg > 0) return 'Ok';
  return 'Bad';
}

/** Run one strategy: decide(ctx, minute) -> 'CALL BUY'|'PUT BUY'|null */
function runStrategy(ctx, name, decide, opts = {}) {
  const hold = opts.hold ?? MIN_HOLD;
  const entries = [];
  let lastEntryMin = -Infinity;

  for (const minute of ctx.mins) {
    if (minute < TRADE_FROM || minute > TRADE_TO) continue;
    if (minute - lastEntryMin < hold) continue;
    const cur = rowAt(ctx, minute);
    if (!cur || !Number.isFinite(cur.spot)) continue;

    const decision = decide(ctx, minute);
    if (decision !== 'CALL BUY' && decision !== 'PUT BUY') continue;

    const fwd = {};
    for (const h of HORIZONS) {
      const fr = forwardRow(ctx, minute, h);
      fwd[h] = fr ? grade(decision, cur.spot, fr.spot) : null;
    }
    const s15 = fwd[15]?.signed ?? null;
    const s30 = fwd[30]?.signed ?? null;
    const s60 = fwd[60]?.signed ?? null;
    const bucket = accuracyBucket(s15, s30, s60);

    entries.push({
      time: cur.time,
      minutes: minute,
      spot: cur.spot,
      decision,
      plus5: fwd[5],
      plus15: fwd[15],
      plus30: fwd[30],
      plus60: fwd[60],
      bucket,
    });
    lastEntryMin = minute;
  }

  return summarize(name, entries);
}

function summarize(name, entries) {
  const with15 = entries.filter((e) => e.plus15);
  const with30 = entries.filter((e) => e.plus30);
  const with60 = entries.filter((e) => e.plus60);
  const hit15 = with15.filter((e) => e.plus15.hit).length;
  const hit30 = with30.filter((e) => e.plus30.hit).length;
  const hit60 = with60.filter((e) => e.plus60.hit).length;
  const avg15 = with15.length
    ? with15.reduce((a, e) => a + e.plus15.signed, 0) / with15.length
    : null;
  const avg30 = with30.length
    ? with30.reduce((a, e) => a + e.plus30.signed, 0) / with30.length
    : null;
  const avg60 = with60.length
    ? with60.reduce((a, e) => a + e.plus60.signed, 0) / with60.length
    : null;
  const buckets = { Excellent: 0, Good: 0, Ok: 0, Bad: 0, pending: 0 };
  for (const e of entries) {
    if (!e.bucket) buckets.pending += 1;
    else buckets[e.bucket] += 1;
  }
  const graded = entries.filter((e) => e.bucket && e.bucket !== 'pending');
  const nonBad = graded.filter((e) => e.bucket !== 'Bad').length;

  return {
    name,
    n: entries.length,
    hit15: with15.length ? +(100 * hit15 / with15.length).toFixed(1) : null,
    hit30: with30.length ? +(100 * hit30 / with30.length).toFixed(1) : null,
    hit60: with60.length ? +(100 * hit60 / with60.length).toFixed(1) : null,
    avg15: avg15 != null ? +avg15.toFixed(2) : null,
    avg30: avg30 != null ? +avg30.toFixed(2) : null,
    avg60: avg60 != null ? +avg60.toFixed(2) : null,
    buckets,
    nonBadPct: graded.length ? +(100 * nonBad / graded.length).toFixed(1) : null,
    sample: entries.slice(0, 8).map((e) => ({
      time: e.time,
      decision: e.decision,
      s15: e.plus15?.signed ?? null,
      s30: e.plus30?.signed ?? null,
      bucket: e.bucket,
    })),
  };
}

function strategies() {
  const list = [];

  // --- A. Current / TF stacks ---
  list.push({
    name: 'A1_full_30_15_5_3_1',
    decide: (ctx, m) => {
      const m30 = tfBias(ctx, m, 30, 18, 18);
      const m15 = tfBias(ctx, m, 15, 9, 9);
      const m5 = tfBias(ctx, m, 5, 3, 3);
      const m3 = tfBias(ctx, m, 3, 2, 2);
      const m1 = tfBias(ctx, m, 1, 1, 1);
      const s15 = spotN(ctx, m, 15);
      if ([m30, m15, m5, m3, m1].every((x) => x === 'Bull') && s15 != null && s15 >= 15) {
        return 'CALL BUY';
      }
      if ([m30, m15, m5, m3, m1].every((x) => x === 'Bear') && s15 != null && s15 <= -15) {
        return 'PUT BUY';
      }
      return null;
    },
  });

  list.push({
    name: 'A2_15_only_spot15',
    decide: (ctx, m) => {
      const m15 = tfBias(ctx, m, 15, 9, 9);
      const s15 = spotN(ctx, m, 15);
      if (m15 === 'Bull' && s15 != null && s15 >= 15) return 'CALL BUY';
      if (m15 === 'Bear' && s15 != null && s15 <= -15) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'A3_15_plus_5',
    decide: (ctx, m) => {
      const m15 = tfBias(ctx, m, 15, 9, 9);
      const m5 = tfBias(ctx, m, 5, 3, 3);
      const s15 = spotN(ctx, m, 15);
      if (m15 === 'Bull' && m5 === 'Bull' && s15 != null && s15 >= 10) return 'CALL BUY';
      if (m15 === 'Bear' && m5 === 'Bear' && s15 != null && s15 <= -10) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'A4_5_3_1_short',
    decide: (ctx, m) => {
      const m5 = tfBias(ctx, m, 5, 3, 3);
      const m3 = tfBias(ctx, m, 3, 2, 2);
      const m1 = tfBias(ctx, m, 1, 1, 1);
      if (m5 === 'Bull' && m3 === 'Bull' && m1 === 'Bull') return 'CALL BUY';
      if (m5 === 'Bear' && m3 === 'Bear' && m1 === 'Bear') return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'A5_relaxed_15_5_oiAct',
    decide: (ctx, m) => {
      const m15 = tfBias(ctx, m, 15, 8, 8);
      const m5 = tfBias(ctx, m, 5, 3, 3);
      const { ca, pa } = actsAt(ctx, m);
      if (m15 === 'Bull' && m5 === 'Bull' && (pa === 'writing' || ca === 'short_cover')) {
        return 'CALL BUY';
      }
      if (m15 === 'Bear' && m5 === 'Bear' && (ca === 'writing' || pa === 'buying')) {
        return 'PUT BUY';
      }
      return null;
    },
  });

  // --- B. Pure OI act patterns (manipulation-aware) ---
  list.push({
    name: 'B1_call_writing_PUT',
    decide: (ctx, m) => {
      const { ca, c } = actsAt(ctx, m);
      if (ca === 'writing' && c >= 80000) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'B2_put_buying_PUT',
    decide: (ctx, m) => {
      const { pa, p } = actsAt(ctx, m);
      if (pa === 'buying' && p >= 80000) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'B3_put_writing_CALL',
    decide: (ctx, m) => {
      const { pa, p } = actsAt(ctx, m);
      if (pa === 'writing' && p >= 80000) return 'CALL BUY';
      return null;
    },
  });

  list.push({
    name: 'B4_call_short_cover_CALL',
    decide: (ctx, m) => {
      const { ca, c } = actsAt(ctx, m);
      if (ca === 'short_cover' && Math.abs(c) >= 80000) return 'CALL BUY';
      return null;
    },
  });

  list.push({
    name: 'B5_dual_sellers_PUT',
    decide: (ctx, m) => {
      const { ca, pa, c, p } = actsAt(ctx, m);
      // Call writing + Put buying = strong sellers
      if (ca === 'writing' && pa === 'buying' && c + p >= 150000) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'B6_dual_buyers_CALL',
    decide: (ctx, m) => {
      const { ca, pa, c, p } = actsAt(ctx, m);
      if (pa === 'writing' && ca === 'short_cover' && Math.abs(c) + p >= 150000) {
        return 'CALL BUY';
      }
      return null;
    },
  });

  list.push({
    name: 'B7_sellers_mask_PUT',
    // Call writing + Put short cover (looks mixed but call write dominates) — fade put cover
    decide: (ctx, m) => {
      const { ca, pa, c, p } = actsAt(ctx, m);
      if (ca === 'writing' && pa === 'short_cover' && c >= 100000 && Math.abs(p) < c) {
        return 'PUT BUY';
      }
      return null;
    },
  });

  // --- C. Big OI impulse ---
  for (const thr of [200000, 400000, 800000, 1500000]) {
    list.push({
      name: `C1_bigChngDir_align_${thr / 1000}k`,
      decide: (ctx, m) => {
        const cur = rowAt(ctx, m);
        const ch = Number(cur.chngInDir) || 0;
        const ds = dSpot(ctx, m);
        if (Math.abs(ch) < thr) return null;
        // chngInDir = putΔ − callΔ > 0 often bullish flow; align with spot
        if (ch > 0 && ds > 0) return 'CALL BUY';
        if (ch < 0 && ds < 0) return 'PUT BUY';
        return null;
      },
    });

    list.push({
      name: `C2_bigChngDir_fade_${thr / 1000}k`,
      decide: (ctx, m) => {
        const cur = rowAt(ctx, m);
        const ch = Number(cur.chngInDir) || 0;
        if (Math.abs(ch) < thr) return null;
        // fade extreme OI spike
        if (ch > thr) return 'PUT BUY';
        if (ch < -thr) return 'CALL BUY';
        return null;
      },
    });

    list.push({
      name: `C3_bigAbsOi_side_${thr / 1000}k`,
      decide: (ctx, m) => {
        const { ca, pa, c, p, ds } = actsAt(ctx, m);
        const absC = Math.abs(c);
        const absP = Math.abs(p);
        if (absC < thr && absP < thr) return null;
        if (absC >= absP) {
          if (ca === 'writing') return 'PUT BUY';
          if (ca === 'short_cover' || ca === 'long_build') return 'CALL BUY';
        } else {
          if (pa === 'buying') return 'PUT BUY';
          if (pa === 'writing' || pa === 'short_cover') return 'CALL BUY';
        }
        if (ds > 0) return 'CALL BUY';
        if (ds < 0) return 'PUT BUY';
        return null;
      },
    });
  }

  // --- D. Day Diff structure ---
  list.push({
    name: 'D1_dayDiff_turn_bull',
    decide: (ctx, m) => {
      const i = ctx.idxOf.get(m);
      if (i == null || i < 10) return null;
      const cur = rowAt(ctx, m);
      const past = rowAt(ctx, ctx.mins[i - 10]);
      const dNow = Number(cur.diffInOi);
      const dPast = Number(past.diffInOi);
      const s15 = spotN(ctx, m, 5);
      // Diff improving (puts building more vs calls) + spot lifting
      if (dNow - dPast >= 300000 && s15 != null && s15 > 0) return 'CALL BUY';
      if (dPast - dNow >= 300000 && s15 != null && s15 < 0) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'D2_dayDiff_extreme',
    decide: (ctx, m) => {
      const cur = rowAt(ctx, m);
      const d = Number(cur.diffInOi);
      const s15 = spotN(ctx, m, 15);
      // Very put-heavy dayDiff + spot still weak → PUT; call-heavy + strong → CALL
      if (d >= 800000 && s15 != null && s15 >= 10) return 'CALL BUY';
      if (d <= -800000 && s15 != null && s15 <= -10) return 'PUT BUY';
      return null;
    },
  });

  // --- E. Spot momentum only (control) ---
  list.push({
    name: 'E1_spot15_only_20',
    decide: (ctx, m) => {
      const s15 = spotN(ctx, m, 15);
      if (s15 != null && s15 >= 20) return 'CALL BUY';
      if (s15 != null && s15 <= -20) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'E2_spot5_burst_8',
    decide: (ctx, m) => {
      const s5 = spotN(ctx, m, 5);
      if (s5 != null && s5 >= 8) return 'CALL BUY';
      if (s5 != null && s5 <= -8) return 'PUT BUY';
      return null;
    },
  });

  // --- F. Combos that often work in OI manip days ---
  list.push({
    name: 'F1_write_plus_spotDown_PUT',
    decide: (ctx, m) => {
      const { ca, c } = actsAt(ctx, m);
      const s5 = spotN(ctx, m, 5);
      if (ca === 'writing' && c >= 100000 && s5 != null && s5 <= -3) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'F2_putBuy_plus_spotDown_PUT',
    decide: (ctx, m) => {
      const { pa, p } = actsAt(ctx, m);
      const s5 = spotN(ctx, m, 5);
      if (pa === 'buying' && p >= 100000 && s5 != null && s5 <= -3) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'F3_putWrite_plus_spotUp_CALL',
    decide: (ctx, m) => {
      const { pa, p } = actsAt(ctx, m);
      const s5 = spotN(ctx, m, 5);
      if (pa === 'writing' && p >= 100000 && s5 != null && s5 >= 3) return 'CALL BUY';
      return null;
    },
  });

  list.push({
    name: 'F4_bigOi_confirm_15m',
    decide: (ctx, m) => {
      const { ca, pa, c, p } = actsAt(ctx, m);
      const m15 = tfBias(ctx, m, 15, 8, 8);
      const big = Math.abs(c) >= 250000 || Math.abs(p) >= 250000;
      if (!big) return null;
      if (m15 === 'Bull' && (pa === 'writing' || ca === 'short_cover')) return 'CALL BUY';
      if (m15 === 'Bear' && (ca === 'writing' || pa === 'buying')) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'F5_ignoreNoise_bigOnly_500k',
    decide: (ctx, m) => {
      const { ca, pa, c, p, ds } = actsAt(ctx, m);
      const bigC = Math.abs(c) >= 500000;
      const bigP = Math.abs(p) >= 500000;
      if (!bigC && !bigP) return null;
      if (bigC && ca === 'writing') return 'PUT BUY';
      if (bigC && (ca === 'short_cover' || ca === 'long_build')) return 'CALL BUY';
      if (bigP && pa === 'buying') return 'PUT BUY';
      if (bigP && pa === 'writing') return 'CALL BUY';
      if (ds > 0) return 'CALL BUY';
      if (ds < 0) return 'PUT BUY';
      return null;
    },
  });

  list.push({
    name: 'F6_rolling3_oiDominance',
    decide: (ctx, m) => {
      const i = ctx.idxOf.get(m);
      if (i == null || i < 3) return null;
      let cSum = 0;
      let pSum = 0;
      let dsSum = 0;
      for (let k = i - 2; k <= i; k++) {
        const cur = rowAt(ctx, ctx.mins[k]);
        const prev = k > 0 ? rowAt(ctx, ctx.mins[k - 1]) : null;
        if (!cur || !prev) continue;
        cSum += Number(cur.callsChgOi) || 0;
        pSum += Number(cur.putsChgOi) || 0;
        dsSum += Number(cur.spot) - Number(prev.spot);
      }
      // 3m net: put buying pressure + spot down
      if (pSum >= 250000 && cSum <= 50000 && dsSum <= -2) return 'PUT BUY';
      if (pSum >= 250000 && dsSum > 0 && cSum <= 0) return 'CALL BUY'; // put writing support
      if (cSum >= 250000 && pSum <= 50000 && dsSum <= -2) return 'PUT BUY'; // call writing
      if (cSum <= -200000 && dsSum >= 2) return 'CALL BUY'; // call short cover
      return null;
    },
  });

  return list;
}

function scoreCard(r) {
  // Prefer: positive avg30, decent hit30, enough trades, not all Bad
  if (!r.n) return -999;
  const avg = r.avg30 ?? r.avg15 ?? -50;
  const hit = r.hit30 ?? r.hit15 ?? 0;
  const nBonus = Math.min(r.n, 8) * 0.5;
  const badPen = (r.buckets.Bad || 0) * 2;
  return avg * 2 + hit * 0.15 + nBonus - badPen + (r.nonBadPct || 0) * 0.05;
}

function main() {
  const allStrats = strategies();
  const report = { generatedAt: new Date().toISOString(), days: {}, ranking: [] };

  for (const day of DAYS) {
    const ctx = loadDay(day.file);
    const results = allStrats.map((s) => runStrategy(ctx, s.name, s.decide));
    report.days[day.key] = {
      label: day.label,
      rows: ctx.rows.length,
      from: ctx.rows[0]?.time,
      to: ctx.rows[ctx.rows.length - 1]?.time,
      results: results.sort((a, b) => scoreCard(b) - scoreCard(a)),
    };
  }

  // Combined rank: require appearing decent on BOTH days when today has enough horizon
  const byName = new Map();
  for (const day of DAYS) {
    for (const r of report.days[day.key].results) {
      if (!byName.has(r.name)) byName.set(r.name, {});
      byName.get(r.name)[day.key] = r;
    }
  }

  const combined = [];
  for (const [name, byDay] of byName) {
    const y = byDay['2026-08-12'];
    const t = byDay['2026-08-13'];
    const yScore = scoreCard(y);
    const tScore = scoreCard(t);
    // today is partial — weight yesterday more, but punish strategies that fail today hard
    const combinedScore = yScore * 0.65 + tScore * 0.35;
    combined.push({
      name,
      combinedScore: +combinedScore.toFixed(2),
      yday: {
        n: y.n,
        hit30: y.hit30,
        avg30: y.avg30,
        hit15: y.hit15,
        avg15: y.avg15,
        buckets: y.buckets,
      },
      today: {
        n: t.n,
        hit30: t.hit30,
        avg30: t.avg30,
        hit15: t.hit15,
        avg15: t.avg15,
        buckets: t.buckets,
        sample: t.sample,
      },
    });
  }
  combined.sort((a, b) => b.combinedScore - a.combinedScore);
  report.ranking = combined;

  const out = path.join(__dirname, 'data', 'oi-multi-strategy-scan.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log('\n=== MULTI-STRATEGY SCAN (future-blind) ===');
  console.log('Hold=30m between entries | Grade +5/+15/+30/+60 | Window 09:30–14:30\n');

  for (const day of DAYS) {
    const block = report.days[day.key];
    console.log(`--- ${block.label} ${day.key} (${block.from}→${block.to}, n=${block.rows}) TOP 10 ---`);
    console.log(
      'rank  strategy                              n  hit15  avg15  hit30  avg30  Exc/Good/Bad',
    );
    block.results.slice(0, 10).forEach((r, i) => {
      const b = r.buckets;
      console.log(
        `${String(i + 1).padStart(2)}  ${r.name.padEnd(38)} ${String(r.n).padStart(2)}  ${String(r.hit15 ?? '—').padStart(5)}  ${String(r.avg15 ?? '—').padStart(6)}  ${String(r.hit30 ?? '—').padStart(5)}  ${String(r.avg30 ?? '—').padStart(6)}  ${b.Excellent}/${b.Good}/${b.Bad}`,
      );
    });
    console.log('');
  }

  console.log('=== COMBINED RANK (65% yday + 35% today) TOP 15 ===');
  console.log(
    'rank  strategy                              score   Y n/hit30/avg30     T n/hit15/avg15',
  );
  combined.slice(0, 15).forEach((r, i) => {
    const y = r.yday;
    const t = r.today;
    console.log(
      `${String(i + 1).padStart(2)}  ${r.name.padEnd(38)} ${String(r.combinedScore).padStart(7)}  ${y.n}/${y.hit30 ?? '—'}/${y.avg30 ?? '—'}   ${t.n}/${t.hit15 ?? '—'}/${t.avg15 ?? '—'}`,
    );
  });

  console.log('\n=== WORST (avoid) ===');
  combined.slice(-8).reverse().forEach((r) => {
    console.log(
      `  ${r.name}  score=${r.combinedScore}  Y:${r.yday.n}/${r.yday.avg30}  T:${r.today.n}/${r.today.avg15}`,
    );
  });

  console.log(`\nFull JSON → ${out}`);
}

main();

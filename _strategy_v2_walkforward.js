/**
 * Full hierarchy walk-forward — NIFTY 2026-08-12
 * 30M env → 15M bias → 5M setup → 3M confirm → 1M entry
 * OI × price = control. Future used ONLY for accuracy.
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data', 'oi-flow-2026-08-12.json');
const OUT = path.join(__dirname, 'data', 'oi-strategy-v2-2026-08-12.json');

const rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const byMin = new Map(rows.map((r) => [r.minutes, r]));
const mins = rows.map((r) => r.minutes).sort((a, b) => a - b);
const idxOf = new Map(mins.map((m, i) => [m, i]));

function rowAt(m) {
  return byMin.get(m) || null;
}

function forwardRow(minute, ahead) {
  const target = minute + ahead;
  if (byMin.has(target)) return byMin.get(target);
  for (let m = target; m <= target + 3; m++) if (byMin.has(m)) return byMin.get(m);
  return null;
}

/** Classify one minute using Price × CallΔOI × PutΔOI (strategy §3). */
function minuteScore(cur, prev) {
  if (!cur || !prev) return 0;
  const dSpot = Number(cur.spot) - Number(prev.spot);
  const c = Number(cur.callsChgOi) || 0;
  const p = Number(cur.putsChgOi) || 0;
  let s = 0;

  if (dSpot > 0) s += 1;
  else if (dSpot < 0) s -= 1;

  // Call side
  if (dSpot > 0 && c > 0) s += 1; // participation
  if (dSpot < 0 && c > 0) s -= 1; // writing / resistance
  if (dSpot > 0 && c < 0) s += 1; // short covering
  if (dSpot < 0 && c < 0) s -= 1; // long unwind

  // Put side
  if (dSpot > 0 && p > 0) s += 1; // put writing support
  if (dSpot < 0 && p > 0) s -= 1; // put buying
  if (dSpot > 0 && p < 0) s += 1; // put long unwind
  if (dSpot < 0 && p < 0) s -= 1; // put short covering

  // Diff / sentiment
  if (Number(cur.chngInDir) > 0) s += 1;
  else if (Number(cur.chngInDir) < 0) s -= 1;

  return s;
}

function labelFromScore(s) {
  if (s > 0) return 'Bull';
  if (s < 0) return 'Bear';
  return 'WAIT';
}

/** TF bias from last W classified minutes. */
function tfBias(minute, W, needBull, needBear) {
  const i = idxOf.get(minute);
  if (i == null || i < W) return { bias: 'WAIT', bull: 0, bear: 0, n: 0 };

  let bull = 0;
  let bear = 0;
  let n = 0;
  for (let k = i - W + 1; k <= i; k++) {
    const cur = rowAt(mins[k]);
    const prev = k > 0 ? rowAt(mins[k - 1]) : null;
    if (!cur || !prev) continue;
    const lab = labelFromScore(minuteScore(cur, prev));
    n += 1;
    if (lab === 'Bull') bull += 1;
    else if (lab === 'Bear') bear += 1;
  }

  let bias = 'WAIT';
  if (bull >= needBull) bias = 'Bull';
  else if (bear >= needBear) bias = 'Bear';

  // also require net spot direction for 5/15/30
  if (W >= 5 && bias !== 'WAIT') {
    const cur = rowAt(minute);
    const past = rowAt(mins[i - W + 1]);
    if (cur && past) {
      const dSpot = Number(cur.spot) - Number(past.spot);
      if (bias === 'Bull' && dSpot < 0) bias = 'WAIT';
      if (bias === 'Bear' && dSpot > 0) bias = 'WAIT';
    }
  }

  return { bias, bull, bear, n };
}

function oneMinBias(minute) {
  const i = idxOf.get(minute);
  if (i == null || i < 1) return 'WAIT';
  const cur = rowAt(mins[i]);
  const prev = rowAt(mins[i - 1]);
  return labelFromScore(minuteScore(cur, prev));
}

function oiControl(minute) {
  const i = idxOf.get(minute);
  if (i == null || i < 1) return 'Mixed';
  const cur = rowAt(mins[i]);
  const prev = rowAt(mins[i - 1]);
  const dSpot = Number(cur.spot) - Number(prev.spot);
  const c = Number(cur.callsChgOi) || 0;
  const p = Number(cur.putsChgOi) || 0;

  // Buyers control
  if (dSpot > 0 && p > 0 && c <= 0) return 'Buyers';
  if (dSpot > 0 && p > 0) return 'Buyers';
  if (dSpot > 0 && c < 0) return 'Buyers';
  // Sellers control
  if (dSpot < 0 && c > 0) return 'Sellers';
  if (dSpot < 0 && p > 0 && c > 0) return 'Sellers';
  if (dSpot < 0 && Number(cur.chngInDir) < 0) return 'Sellers';
  return 'Mixed';
}

/** Price × Call ΔOI label (strategy §3). */
function callAction(dSpot, c) {
  if (dSpot > 0 && c > 0) return 'Call long build';
  if (dSpot < 0 && c > 0) return 'Call writing';
  if (dSpot > 0 && c < 0) return 'Call short cover';
  if (dSpot < 0 && c < 0) return 'Call long unwind';
  return 'Call flat';
}

/** Price × Put ΔOI label (strategy §3). */
function putAction(dSpot, p) {
  if (dSpot > 0 && p > 0) return 'Put writing';
  if (dSpot < 0 && p > 0) return 'Put buying';
  if (dSpot > 0 && p < 0) return 'Put long unwind';
  if (dSpot < 0 && p < 0) return 'Put short cover';
  return 'Put flat';
}

function fmtLakh(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${(n / 100000).toFixed(2)}L`;
}

function flowSnapshot(minute) {
  const i = idxOf.get(minute);
  if (i == null || i < 1) {
    return {
      priceDir: '→',
      spotChg1: 0,
      callChg: 0,
      putChg: 0,
      callAct: 'Call flat',
      putAct: 'Put flat',
      spotChg15: null,
      diffChg15: null,
    };
  }
  const cur = rowAt(mins[i]);
  const prev = rowAt(mins[i - 1]);
  const dSpot = Number(cur.spot) - Number(prev.spot);
  const c = Number(cur.callsChgOi) || 0;
  const p = Number(cur.putsChgOi) || 0;
  const past15 = i >= 15 ? rowAt(mins[i - 15]) : null;
  return {
    priceDir: dSpot > 0 ? '↑' : dSpot < 0 ? '↓' : '→',
    spotChg1: Number(dSpot.toFixed(2)),
    callChg: c,
    putChg: p,
    callAct: callAction(dSpot, c),
    putAct: putAction(dSpot, p),
    spotChg15: past15
      ? Number((Number(cur.spot) - Number(past15.spot)).toFixed(2))
      : null,
    diffChg15: past15
      ? Number(cur.diffInOi) - Number(past15.diffInOi)
      : null,
  };
}

/** Trade window: 09:30–14:30 IST inclusive (no new entries outside). */
const TRADE_FROM = 9 * 60 + 30; // 09:30
const TRADE_TO = 14 * 60 + 30; // 14:30

function inTradeWindow(minute) {
  return minute >= TRADE_FROM && minute <= TRADE_TO;
}

function decideAt(minute) {
  const cur = rowAt(minute);
  if (!cur) return null;

  // Thresholds from strategy: 15M prefer 10/15, 5M 3–5, 3M majority, 30M majority
  const t30 = tfBias(minute, 30, 18, 18);
  const t15 = tfBias(minute, 15, 10, 10);
  const t5 = tfBias(minute, 5, 3, 3);
  const t3 = tfBias(minute, 3, 2, 2);
  const m1 = oneMinBias(minute);
  const control = oiControl(minute);
  const flow = flowSnapshot(minute);

  const m30 = t30.bias;
  const m15 = t15.bias;
  const m5 = t5.bias;
  const m3 = t3.bias;

  let decision = 'WAIT';
  let reason = 'no full stack alignment';

  const base = {
    time: cur.time,
    minutes: minute,
    spot: cur.spot,
    m30,
    m15,
    m5,
    m3,
    m1,
    control,
    priceDir: flow.priceDir,
    spotChg1: flow.spotChg1,
    callChg: flow.callChg,
    putChg: flow.putChg,
    callChgL: fmtLakh(flow.callChg),
    putChgL: fmtLakh(flow.putChg),
    callAct: flow.callAct,
    putAct: flow.putAct,
    spotChg15: flow.spotChg15,
    diffChg15: flow.diffChg15,
    t15bull: t15.bull,
    t15bear: t15.bear,
  };

  // Hard gate: no CALL/PUT outside 09:30–14:30
  if (!inTradeWindow(minute)) {
    return {
      ...base,
      decision: 'WAIT',
      reason: 'outside trade window 09:30–14:30',
    };
  }

  // 30M soft filter: block if strongly opposite
  const envOkCall = m30 !== 'Bear';
  const envOkPut = m30 !== 'Bull';

  if (
    envOkCall &&
    m15 === 'Bull' &&
    m5 === 'Bull' &&
    m3 === 'Bull' &&
    m1 === 'Bull' &&
    (control === 'Buyers' || control === 'Mixed')
  ) {
    decision = 'CALL BUY';
    reason = `30 ${m30} · 15 ${t15.bull}/15 bull · 5 ${t5.bull}/5 · 3 ${t3.bull}/3 · 1 Bull · control ${control}`;
  } else if (
    envOkPut &&
    m15 === 'Bear' &&
    m5 === 'Bear' &&
    m3 === 'Bear' &&
    m1 === 'Bear' &&
    (control === 'Sellers' || control === 'Mixed')
  ) {
    decision = 'PUT BUY';
    reason = `30 ${m30} · 15 ${t15.bear}/15 bear · 5 ${t5.bear}/5 · 3 ${t3.bear}/3 · 1 Bear · control ${control}`;
  } else if (m15 === 'Bull' && m1 === 'Bear') {
    reason = '1M bear vs 15M bull → WAIT (pullback)';
  } else if (m15 === 'Bear' && m1 === 'Bull') {
    reason = '1M bull vs 15M bear → WAIT (bounce)';
  } else if (m15 === 'Bull' && (m5 !== 'Bull' || m3 !== 'Bull')) {
    reason = '15M bull but 5/3 not ready';
  } else if (m15 === 'Bear' && (m5 !== 'Bear' || m3 !== 'Bear')) {
    reason = '15M bear but 5/3 not ready';
  }

  return {
    ...base,
    decision,
    reason,
  };
}

// ── PHASE 1: every minute ──────────────────────────────────────────────────
const every = [];
for (const m of mins) {
  const d = decideAt(m);
  if (d) every.push(d);
}

// Hold entries: one position, flip on opposite
const entries = [];
let pos = 'FLAT';
for (const p of every) {
  if (p.decision === 'WAIT') continue;
  if (pos === 'FLAT') {
    entries.push({ ...p, note: '' });
    pos = p.decision === 'CALL BUY' ? 'CALL' : 'PUT';
  } else if (pos === 'CALL' && p.decision === 'PUT BUY') {
    entries.push({ ...p, note: 'FLIP' });
    pos = 'PUT';
  } else if (pos === 'PUT' && p.decision === 'CALL BUY') {
    entries.push({ ...p, note: 'FLIP' });
    pos = 'CALL';
  }
}

// ── PHASE 2: accuracy ──────────────────────────────────────────────────────
function grade(decision, moves) {
  const vals = [moves.plus15, moves.plus30, moves.plus45, moves.plus60].filter((v) => v != null);
  if (!vals.length) return 'Bad';
  if (decision === 'CALL BUY') {
    const best = Math.max(...vals);
    if (best >= 40) return 'Excellent';
    if (best >= 15) return 'Good';
    return 'Bad';
  }
  const best = Math.min(...vals);
  if (best <= -40) return 'Excellent';
  if (best <= -15) return 'Good';
  return 'Bad';
}

function movesFrom(minute, spot0) {
  const out = {};
  for (const h of [15, 30, 45, 60]) {
    const f = forwardRow(minute, h);
    out[`plus${h}`] = f ? Number((f.spot - spot0).toFixed(2)) : null;
  }
  return out;
}

const scored = entries.map((e) => {
  const mv = movesFrom(e.minutes, e.spot);
  return {
    ...e,
    plus15: mv.plus15,
    plus30: mv.plus30,
    plus45: mv.plus45,
    plus60: mv.plus60,
    accuracy: grade(e.decision, mv),
  };
});

function countGrade(list) {
  return {
    total: list.length,
    Excellent: list.filter((s) => s.accuracy === 'Excellent').length,
    Good: list.filter((s) => s.accuracy === 'Good').length,
    Bad: list.filter((s) => s.accuracy === 'Bad').length,
  };
}

const buyMinutes = every.filter((e) => e.decision !== 'WAIT');
const summary = {
  dateKey: '2026-08-12',
  tradeWindow: '09:30–14:30 IST',
  rows: rows.length,
  waitMinutes: every.filter((e) => e.decision === 'WAIT').length,
  signalMinutes: buyMinutes.length,
  holdEntries: scored.length,
  overall: countGrade(scored),
  hitRatePct: scored.length
    ? Number(
        (
          ((countGrade(scored).Excellent + countGrade(scored).Good) / scored.length) *
          100
        ).toFixed(1),
      )
    : 0,
};

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      summary,
      holdEntries: scored,
      // compact every-minute for UI (decision + TFs)
      everyMinute: every.map((e) => ({
        time: e.time,
        spot: e.spot,
        m30: e.m30,
        m15: e.m15,
        m5: e.m5,
        m3: e.m3,
        m1: e.m1,
        control: e.control,
        priceDir: e.priceDir,
        callAct: e.callAct,
        putAct: e.putAct,
        callChgL: e.callChgL,
        putChgL: e.putChgL,
        decision: e.decision,
      })),
    },
    null,
    2,
  ),
);

console.log(JSON.stringify(summary, null, 2));
console.log('\nHOLD ENTRIES:');
for (const s of scored) {
  console.log(
    `${s.time} 30=${s.m30} 15=${s.m15} 5=${s.m5} 3=${s.m3} 1=${s.m1} → ${s.decision} | +15=${s.plus15} +30=${s.plus30} +60=${s.plus60} | ${s.accuracy} ${s.note}`,
  );
}
console.log('\nSample aligned minutes (first 20 non-WAIT):');
buyMinutes.slice(0, 20).forEach((e) => {
  console.log(`${e.time} 30=${e.m30} 15=${e.m15} 5=${e.m5} 3=${e.m3} 1=${e.m1} ctrl=${e.control} → ${e.decision}`);
});

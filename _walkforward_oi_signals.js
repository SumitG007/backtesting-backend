/**
 * Walk-forward OI signal engine — NIFTY 2026-08-12 (HOLD mode)
 *
 * PHASE 1 (no future): at each minute T, use only rows with minutes <= T
 * PHASE 2 (after): score each entry with future spot → Bad | Good | Excellent
 *
 * Position model (hold, not scalp):
 *   FLAT → CALL BUY / PUT BUY enters
 *   Same-side signal while in position → HOLD (no new row)
 *   Opposite signal → FLIP (close + reverse counted as new entry)
 *   Sustained WAIT (5m) → stay in position (no exit signal here; scoring uses forward path)
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data', 'oi-flow-2026-08-12.json');
const OUT_SIGNALS = path.join(__dirname, 'data', 'oi-walkforward-signals-2026-08-12.json');
const OUT_SUMMARY = path.join(__dirname, 'data', 'oi-walkforward-summary-2026-08-12.json');

const rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const byMin = new Map(rows.map((r) => [r.minutes, r]));
const mins = rows.map((r) => r.minutes).sort((a, b) => a - b);

function rowAt(minute) {
  return byMin.get(minute) || null;
}

function pastRow(minute, lookback) {
  const target = minute - lookback;
  if (byMin.has(target)) return byMin.get(target);
  for (let m = target; m >= mins[0]; m -= 1) {
    if (byMin.has(m)) return byMin.get(m);
  }
  return null;
}

function forwardRow(minute, ahead) {
  const target = minute + ahead;
  if (byMin.has(target)) return byMin.get(target);
  for (let m = target; m <= target + 3; m++) {
    if (byMin.has(m)) return byMin.get(m);
  }
  return null;
}

function tfBias(cur, past) {
  if (!cur || !past) return 'WAIT';
  const dDiff = Number(cur.diffInOi) - Number(past.diffInOi);
  const dSpot = Number(cur.spot) - Number(past.spot);
  if (dDiff > 0 && dSpot >= 0) return 'Bull';
  if (dDiff < 0 && dSpot <= 0) return 'Bear';
  return 'WAIT';
}

function oneMinBias(cur) {
  if (!cur) return 'WAIT';
  if (cur.sentiment === 'Bull' || Number(cur.chngInDir) > 0) return 'Bull';
  if (cur.sentiment === 'Bear' || Number(cur.chngInDir) < 0) return 'Bear';
  return 'WAIT';
}

function oiSupport(cur, side) {
  const c = Number(cur.callsChgOi) || 0;
  const p = Number(cur.putsChgOi) || 0;
  if (side === 'CALL') return c <= 0 || p > 0;
  return c > 0 || p <= 0;
}

function decideAt(minute) {
  const cur = rowAt(minute);
  if (!cur) return null;

  const p3 = pastRow(minute, 3);
  const p5 = pastRow(minute, 5);
  const p15 = pastRow(minute, 15);

  if (!p15 || !p5 || !p3) {
    return {
      time: cur.time,
      minutes: minute,
      spot: cur.spot,
      m1: 'WAIT',
      m3: 'WAIT',
      m5: 'WAIT',
      m15: 'WAIT',
      prediction: 'WAIT',
      reason: 'insufficient history (<15m)',
    };
  }

  const m1 = oneMinBias(cur);
  const m3 = tfBias(cur, p3);
  const m5 = tfBias(cur, p5);
  const m15 = tfBias(cur, p15);
  const spot15 = Number(cur.spot) - Number(p15.spot);
  const diff15 = Number(cur.diffInOi) - Number(p15.diffInOi);

  let prediction = 'WAIT';
  let reason = 'no full alignment';

  const allBull = m15 === 'Bull' && m5 === 'Bull' && m3 === 'Bull' && m1 === 'Bull';
  const allBear = m15 === 'Bear' && m5 === 'Bear' && m3 === 'Bear' && m1 === 'Bear';

  if (allBull && spot15 > 0 && diff15 > 0 && oiSupport(cur, 'CALL')) {
    prediction = 'CALL BUY';
    reason = '15/5/3/1 Bull + spot↑15 + diff↑15 + OI supports CE';
  } else if (allBear && spot15 < 0 && diff15 < 0 && oiSupport(cur, 'PUT')) {
    prediction = 'PUT BUY';
    reason = '15/5/3/1 Bear + spot↓15 + diff↓15 + OI supports PE';
  } else if (m15 === 'WAIT' || m5 === 'WAIT' || m3 === 'WAIT') {
    reason = `TF conflict/wait (15=${m15} 5=${m5} 3=${m3} 1=${m1})`;
  } else if (m15 !== m1) {
    reason = `15m ${m15} vs 1m ${m1}`;
  }

  return {
    time: cur.time,
    minutes: minute,
    spot: cur.spot,
    m1,
    m3,
    m5,
    m15,
    spotChg15: Number(spot15.toFixed(2)),
    diffChg15: diff15,
    prediction,
    reason,
  };
}

// PHASE 1
const allPredictions = mins.map((m) => decideAt(m)).filter(Boolean);

// Hold position machine
const entries = [];
let position = 'FLAT'; // FLAT | CALL | PUT

for (const p of allPredictions) {
  if (p.prediction === 'WAIT') continue;

  if (position === 'FLAT') {
    entries.push({ ...p, action: p.prediction });
    position = p.prediction === 'CALL BUY' ? 'CALL' : 'PUT';
    continue;
  }

  if (position === 'CALL' && p.prediction === 'PUT BUY') {
    entries.push({ ...p, action: 'PUT BUY', note: 'FLIP from CALL' });
    position = 'PUT';
    continue;
  }

  if (position === 'PUT' && p.prediction === 'CALL BUY') {
    entries.push({ ...p, action: 'CALL BUY', note: 'FLIP from PUT' });
    position = 'CALL';
    continue;
  }
  // same-side while in position → ignore (HOLD)
}

// PHASE 2 — future scoring only
function futureMoves(entryMin, spot0) {
  const out = {};
  for (const h of [15, 30, 45, 60]) {
    const found = forwardRow(entryMin, h);
    out[`plus${h}`] = found ? Number((found.spot - spot0).toFixed(2)) : null;
  }
  return out;
}

function grade(prediction, moves) {
  const vals = [moves.plus15, moves.plus30, moves.plus45, moves.plus60].filter(
    (v) => v != null,
  );
  if (!vals.length) return 'Bad';

  if (prediction === 'CALL BUY') {
    const best = Math.max(...vals);
    if (best >= 40) return 'Excellent';
    if (best >= 15) return 'Good';
    return 'Bad';
  }
  // PUT
  const best = Math.min(...vals);
  if (best <= -40) return 'Excellent';
  if (best <= -15) return 'Good';
  return 'Bad';
}

const scored = entries.map((e) => {
  const moves = futureMoves(e.minutes, e.spot);
  return {
    signalTime: e.time,
    spot: e.spot,
    m1: e.m1,
    m3: e.m3,
    m5: e.m5,
    m15: e.m15,
    spotChg15: e.spotChg15,
    prediction: e.action || e.prediction,
    note: e.note || '',
    reason: e.reason,
    plus15: moves.plus15,
    plus30: moves.plus30,
    plus45: moves.plus45,
    plus60: moves.plus60,
    accuracy: grade(e.action || e.prediction, moves),
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

const calls = scored.filter((s) => s.prediction === 'CALL BUY');
const puts = scored.filter((s) => s.prediction === 'PUT BUY');
const hitRate =
  scored.length === 0
    ? 0
    : Number(
        (
          ((countGrade(scored).Excellent + countGrade(scored).Good) / scored.length) *
          100
        ).toFixed(1),
      );

const summary = {
  dateKey: '2026-08-12',
  symbol: 'NIFTY',
  rowsUsed: rows.length,
  dataFile: 'data/oi-flow-2026-08-12.json',
  method:
    'Walk-forward hold: predict with <=T only (1/3/5/15 align + spot15 + diff15 + OI). One position at a time; same-side ignored; opposite = flip. Future used ONLY for accuracy column.',
  gradeRule:
    'CALL best of +15/+30/+45/+60: >=40 Excellent, >=15 Good, else Bad. PUT same on downside.',
  freshEntries: scored.length,
  callStats: countGrade(calls),
  putStats: countGrade(puts),
  overall: countGrade(scored),
  hitRatePct_GoodOrExcellent: hitRate,
};

fs.writeFileSync(OUT_SIGNALS, JSON.stringify({ summary, signals: scored }, null, 2));
fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log('\nHOLD ENTRIES (future-blind prediction → later accuracy):');
for (const s of scored) {
  console.log(
    `${s.signalTime} ${s.prediction.padEnd(9)} spot=${s.spot} | 1/3/5/15=${s.m1}/${s.m3}/${s.m5}/${s.m15} | +15=${s.plus15} +30=${s.plus30} +60=${s.plus60} | ${s.accuracy}${s.note ? ' [' + s.note + ']' : ''}`,
  );
}

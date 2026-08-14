/**
 * OI Flow paper signals — ROBUST B defaults:
 *   Put buying  + Put ΔOI ≥ 2.5L + spot ↓ → PUT BUY
 *   Put writing + Put ΔOI ≥ 2.5L + spot ↑ → CALL BUY
 *   Skip mega spike Put ΔOI > 30L
 * Window 09:30–14:30. Future used ONLY for +1/+5/+15 accuracy (research), never for entry.
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { getIstClock } = require('../utils/dateTime');
const { intervalOiFromRows } = require('../utils/oiFlowIntervalOi');

const TRADE_FROM = 9 * 60 + 30;
const TRADE_TO = 14 * 60 + 30;
const MIN_HOLD_MIN = 30;
const MIN_PUT_OI = 250000; // 2.5L (ROBUST B)
const MAX_PUT_OI = 3000000; // 30L spike cap
const PUT_BUY_MIN_OI = MIN_PUT_OI; // export alias

function normalizeRows(raw) {
  const rows = (Array.isArray(raw) ? raw : [])
    .map((r) => ({
      time: r.time,
      minutes: Number(r.minutes),
      spot: Number(r.spotPrice ?? r.spot),
      dayCallChgOi: Number(r.dayCallChgOi),
      dayPutChgOi: Number(r.dayPutChgOi),
      callsChgOi: Number(r.callsChgOi),
      putsChgOi: Number(r.putsChgOi),
      strikes: Array.isArray(r.strikes) ? r.strikes : [],
      diffInOi: Number(r.diffInOi),
      chngInDir: Number(r.chngInDir),
      dirOfChng: r.dirOfChng,
      sentiment: r.sentiment,
    }))
    .filter((r) => Number.isFinite(r.minutes))
    .sort((a, b) => a.minutes - b.minutes);

  const byMin = new Map();
  for (const r of rows) byMin.set(r.minutes, r);
  return [...byMin.values()].sort((a, b) => a.minutes - b.minutes);
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

function fmtLakh(n) {
  if (!Number.isFinite(n)) return null;
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${(n / 100000).toFixed(2)}L`;
}

function buildIndex(rows) {
  const mins = rows.map((r) => r.minutes);
  const byMin = new Map(rows.map((r) => [r.minutes, r]));
  const idxOf = new Map(mins.map((m, i) => [m, i]));
  return { rows, mins, byMin, idxOf };
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

function flowAt(ctx, minute) {
  const i = ctx.idxOf.get(minute);
  const cur = rowAt(ctx, minute);
  if (i == null || i < 1 || !cur) {
    return {
      priceDir: '→',
      spotChg1: null,
      spotChg5: null,
      callChg: null,
      putChg: null,
      callAct: 'Call flat',
      putAct: 'Put flat',
    };
  }
  const prev = rowAt(ctx, ctx.mins[i - 1]);
  const dSpot = Number(cur.spot) - Number(prev.spot);
  const interval = intervalOiFromRows(cur, prev);
  const c = Number(interval.callsChgOi) || 0;
  const p = Number(interval.putsChgOi) || 0;
  const past5 = i >= 5 ? rowAt(ctx, ctx.mins[i - 5]) : null;
  return {
    priceDir: dSpot > 0 ? '↑' : dSpot < 0 ? '↓' : '→',
    spotChg1: Number(dSpot.toFixed(2)),
    spotChg5: past5
      ? Number((Number(cur.spot) - Number(past5.spot)).toFixed(2))
      : null,
    callChg: c,
    putChg: p,
    callAct: callAction(dSpot, c),
    putAct: putAction(dSpot, p),
  };
}

function decideRaw(ctx, minute, opts = {}) {
  const cur = rowAt(ctx, minute);
  if (!cur) return null;

  const minPutOi = Math.max(10000, Number(opts.minPutOi) || MIN_PUT_OI);
  const maxPutOiRaw = opts.maxPutOi;
  const maxPutOi =
    maxPutOiRaw == null || maxPutOiRaw === '' || Number(maxPutOiRaw) <= 0
      ? MAX_PUT_OI
      : Math.max(minPutOi, Number(maxPutOiRaw));
  const requireSpotAlign =
    opts.requireSpotAlign == null ? true : Boolean(opts.requireSpotAlign);

  const flow = flowAt(ctx, minute);
  const base = {
    time: cur.time,
    minutes: minute,
    spot: cur.spot,
    priceDir: flow.priceDir,
    spotChg1: flow.spotChg1,
    spotChg5: flow.spotChg5,
    callChg: flow.callChg,
    putChg: flow.putChg,
    callChgL: fmtLakh(flow.callChg),
    putChgL: fmtLakh(flow.putChg),
    callAct: flow.callAct,
    putAct: flow.putAct,
    minPutOi,
    maxPutOi,
    requireSpotAlign,
  };

  if (minute < TRADE_FROM || minute > TRADE_TO) {
    return { ...base, decision: 'WAIT', reason: 'outside 09:30–14:30' };
  }

  const putChg = Number(flow.putChg) || 0;
  const spotChg1 = Number(flow.spotChg1);

  if (putChg > maxPutOi) {
    return {
      ...base,
      decision: 'WAIT',
      reason: `mega spike Put ΔOI ${putChg} > ${maxPutOi} (skip)`,
    };
  }

  if (flow.putAct === 'Put buying' && putChg >= minPutOi) {
    if (requireSpotAlign && !(spotChg1 < 0)) {
      return {
        ...base,
        decision: 'WAIT',
        reason: `Put buying ≥ ${minPutOi} but spot not down (d1=${spotChg1})`,
      };
    }
    return {
      ...base,
      decision: 'PUT BUY',
      matchedRule: `Put buying + Put ΔOI ≥ ${minPutOi} + spot ↓ → PUT BUY (LONG PE)`,
      reason: `Put buying ≥ ${minPutOi} (got ${putChg}) · spot ↓`,
    };
  }

  if (flow.putAct === 'Put writing' && putChg >= minPutOi) {
    if (requireSpotAlign && !(spotChg1 > 0)) {
      return {
        ...base,
        decision: 'WAIT',
        reason: `Put writing ≥ ${minPutOi} but spot not up (d1=${spotChg1})`,
      };
    }
    return {
      ...base,
      decision: 'CALL BUY',
      matchedRule: `Put writing + Put ΔOI ≥ ${minPutOi} + spot ↑ → CALL BUY (LONG CE)`,
      reason: `Put writing ≥ ${minPutOi} (got ${putChg}) · spot ↑`,
    };
  }

  let reason = 'no big put buying/writing';
  if (flow.putAct === 'Put buying' && putChg < minPutOi) {
    reason = `Put buying but ΔOI ${putChg} < ${minPutOi}`;
  } else if (flow.putAct === 'Put writing' && putChg < minPutOi) {
    reason = `Put writing but ΔOI ${putChg} < ${minPutOi}`;
  } else if (flow.putAct !== 'Put flat') {
    reason = `Put act ${flow.putAct}`;
  }

  return { ...base, decision: 'WAIT', reason };
}

function grade(decision, moves) {
  const vals = [moves.plus1, moves.plus5, moves.plus15].filter((v) => v != null);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  // Small-point goal: favor = points in trade direction
  const favor = decision === 'PUT BUY' ? -avg : decision === 'CALL BUY' ? avg : 0;
  if (favor >= 8) return 'Excellent';
  if (favor >= 3) return 'Good';
  return 'Bad';
}

function futureMoves(ctx, entryMin, spot0) {
  const out = {};
  const toPct = (pts) =>
    pts != null && Number.isFinite(spot0) && spot0 !== 0
      ? Number(((pts / spot0) * 100).toFixed(3))
      : null;

  for (const h of [1, 5, 15]) {
    const f = forwardRow(ctx, entryMin, h);
    const pts = f ? Number((f.spot - spot0).toFixed(2)) : null;
    out[`plus${h}`] = pts;
    out[`plus${h}Pct`] = toPct(pts);
  }
  const present = [out.plus1, out.plus5, out.plus15].filter((v) => v != null);
  out.avg =
    present.length > 0
      ? Number((present.reduce((a, b) => a + b, 0) / present.length).toFixed(2))
      : null;
  out.avgPct = toPct(out.avg);
  return out;
}

/**
 * @param {object[]} rawRows OI flow minute docs for today
 */
function computeSignals(rawRows) {
  const rows = normalizeRows(rawRows);
  const ctx = buildIndex(rows);
  const clock = getIstClock(new Date());

  const every = [];
  for (const m of ctx.mins) {
    const d = decideRaw(ctx, m);
    if (d) every.push(d);
  }

  // Space entries by MIN_HOLD_MIN (CALL or PUT)
  const entries = [];
  let lastEntryMin = null;
  let lastSide = null;

  for (const p of every) {
    if (p.decision !== 'PUT BUY' && p.decision !== 'CALL BUY') continue;
    if (lastEntryMin != null && p.minutes - lastEntryMin < MIN_HOLD_MIN) continue;
    const note =
      lastEntryMin == null
        ? ''
        : lastSide && lastSide !== p.decision
          ? 'FLIP'
          : 'NEXT';
    entries.push({ ...p, note });
    lastEntryMin = p.minutes;
    lastSide = p.decision;
  }

  const signals = entries.map((e) => {
    const mv = futureMoves(ctx, e.minutes, e.spot);
    const accuracy = grade(e.decision, mv);
    const favorPts =
      mv.avg == null
        ? null
        : e.decision === 'PUT BUY'
          ? Number((-mv.avg).toFixed(2))
          : e.decision === 'CALL BUY'
            ? Number(mv.avg.toFixed(2))
            : null;
    const favorPct =
      mv.avgPct == null
        ? null
        : e.decision === 'PUT BUY'
          ? Number((-mv.avgPct).toFixed(3))
          : e.decision === 'CALL BUY'
            ? Number(mv.avgPct.toFixed(3))
            : null;
    return {
      time: e.time,
      minutes: e.minutes,
      spot: e.spot,
      px1m: e.spotChg1,
      priceDir: e.priceDir,
      spotChg5: e.spotChg5,
      callChg: e.callChg,
      putChg: e.putChg,
      callChgL: e.callChgL,
      putChgL: e.putChgL,
      callAct: e.callAct,
      putAct: e.putAct,
      decision: e.decision,
      note: e.note || '',
      reason: e.reason,
      plus1: mv.plus1,
      plus5: mv.plus5,
      plus15: mv.plus15,
      plus1Pct: mv.plus1Pct,
      plus5Pct: mv.plus5Pct,
      plus15Pct: mv.plus15Pct,
      avg: mv.avg,
      avgPct: mv.avgPct,
      favorPts,
      favorPct,
      accuracy,
    };
  });

  const scored = signals.filter((s) => s.accuracy);
  const excellent = scored.filter((s) => s.accuracy === 'Excellent').length;
  const good = scored.filter((s) => s.accuracy === 'Good').length;
  const bad = scored.filter((s) => s.accuracy === 'Bad').length;
  const withFavor = signals.filter((s) => s.favorPts != null);
  const avgFavor =
    withFavor.length > 0
      ? Number((withFavor.reduce((a, s) => a + s.favorPts, 0) / withFavor.length).toFixed(2))
      : null;
  const withFavorPct = signals.filter((s) => s.favorPct != null);
  const avgFavorPct =
    withFavorPct.length > 0
      ? Number(
          (withFavorPct.reduce((a, s) => a + s.favorPct, 0) / withFavorPct.length).toFixed(3),
        )
      : null;
  const callN = signals.filter((s) => s.decision === 'CALL BUY').length;
  const putN = signals.filter((s) => s.decision === 'PUT BUY').length;

  return {
    dateKey: clock.dateKey,
    nowTime: clock.hhmm,
    tradeWindow: '09:30–14:30',
    mode: 'paper-signals',
    strategy: 'put-oi-both-ways',
    strategyLabel: 'Put writing → CALL · Put buying → PUT',
    rowsUsed: rows.length,
    position: lastSide === 'CALL BUY' ? 'CALL' : lastSide === 'PUT BUY' ? 'PUT' : 'FLAT',
    filters: {
      minHoldMin: MIN_HOLD_MIN,
      minPutOi: MIN_PUT_OI,
      putBuyMinOi: MIN_PUT_OI,
      horizons: [1, 5, 15],
      gradeExcellentFavor: 8,
      gradeGoodFavor: 3,
    },
    summary: {
      entries: signals.length,
      callEntries: callN,
      putEntries: putN,
      scored: scored.length,
      excellent,
      good,
      bad,
      avgFavorPts: avgFavor,
      avgFavorPct,
      hitRatePct:
        scored.length > 0
          ? Number((((excellent + good) / scored.length) * 100).toFixed(1))
          : null,
    },
    signals,
  };
}

async function getTodaySignals() {
  const clock = getIstClock(new Date());
  const rows = await OiFlowMinuteRow.find({
    symbol: 'NIFTY',
    dateKey: clock.dateKey,
  })
    .sort({ minutes: 1 })
    .lean();
  return computeSignals(rows);
}

module.exports = {
  computeSignals,
  getTodaySignals,
  decideRaw,
  normalizeRows,
  buildIndex,
  TRADE_FROM,
  TRADE_TO,
  MIN_HOLD_MIN,
  MIN_PUT_OI,
  MAX_PUT_OI,
  PUT_BUY_MIN_OI,
};

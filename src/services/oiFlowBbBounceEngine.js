/**
 * OI Flow BB Bounce — mean-reversion at Bollinger bands + 1-min OI pairs.
 *
 * Reclaim: previous bar at the band, this bar closes back inside + strong OI ≥ 1L.
 * SL = 1.5 × last 5-min spot range (min 10 pts). TP +10 synth + 4 pt gap. No 15m time exit.
 */
const fs = require('fs');
const path = require('path');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { normalizeRows, buildIndex, bbAt, TRADE_FROM, TRADE_TO } = require('./oiFlowSignalEngine');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
const COOLDOWN_MIN = 30;
const TARGET_PTS = 10;
/** Extra NIFTY synth pts required beyond base TP (closer to real option +10). */
const TARGET_GAP = 4;
const TP_TRIGGER_PTS = TARGET_PTS + TARGET_GAP;
const PREMIUM_DELTA = 0.5;
const MIN_OI_ABS = 100000;
const SL_RANGE_BARS = 5;
const SL_RANGE_MULT = 1.5;
const SL_RANGE_MIN_SPOT = 10;

const CALL_PAIRS = new Set(['long build|writing', 'long build|long unwind']);
const PUT_PAIRS = new Set(['writing|buying', 'long unwind|buying']);

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

function pairFavours(callAct, putAct) {
  const key = pairKey(callAct, putAct);
  if (CALL_PAIRS.has(key)) return 'CALL';
  if (PUT_PAIRS.has(key)) return 'PUT';
  return null;
}

function decideBbBounce(ctx, minute, prevBb = null, opts = {}) {
  const i = ctx.idxOf.get(minute);
  const cur = ctx.byMin.get(minute);
  if (i == null || i < 1 || !cur) return null;

  const f = flowAtLocal(ctx, minute);
  const bb = bbAt(ctx, minute);
  const candle = Number(f.spotChg1) > 0 ? 'green' : Number(f.spotChg1) < 0 ? 'red' : 'doji';
  const favour = pairFavours(f.callAct, f.putAct);
  const oiMag = Math.max(Math.abs(Number(f.callChg) || 0), Math.abs(Number(f.putChg) || 0));
  const minOi = Math.max(10000, Number(opts.minOiAbs) || MIN_OI_ABS);
  const base = {
    time: cur.time,
    minutes: minute,
    spot: cur.spot,
    candle,
    callAct: f.callAct,
    putAct: f.putAct,
    callChg: f.callChg,
    putChg: f.putChg,
    callChgL: fmtLakh(f.callChg),
    putChgL: fmtLakh(f.putChg),
    bb,
    favour,
    pair: `${actTail(f.callAct)} / ${actTail(f.putAct)}`,
  };

  if (minute < TRADE_FROM || minute > TRADE_TO) {
    return { ...base, decision: 'WAIT', reason: 'outside 09:30–14:30' };
  }
  if (!bb?.ok) {
    return { ...base, decision: 'WAIT', reason: bb?.reason || 'BB not ready' };
  }
  if (oiMag < minOi) {
    return { ...base, decision: 'WAIT', reason: `OI mag ${oiMag} < ${minOi}` };
  }

  const reclaimLower = Boolean(prevBb?.atLower) && !bb.atLower;
  const reclaimUpper = Boolean(prevBb?.atUpper) && !bb.atUpper;

  if (reclaimLower && candle === 'green' && favour === 'CALL') {
    return {
      ...base,
      decision: 'CALL BUY',
      matchedRule: `Reclaim lower BB + green + ${base.pair} ≥1L → CALL BUY`,
      reason: `Reclaim lower · ${base.pair}`,
    };
  }
  if (reclaimUpper && candle === 'red' && favour === 'PUT') {
    return {
      ...base,
      decision: 'PUT BUY',
      matchedRule: `Reclaim upper BB + red + ${base.pair} ≥1L → PUT BUY`,
      reason: `Reclaim upper · ${base.pair}`,
    };
  }

  return { ...base, decision: 'WAIT', reason: 'no BB reclaim + strong OI' };
}

function fmtLakh(n) {
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '' : '';
  return `${sign}${(n / 100000).toFixed(2)}L`;
}

const { intervalOiFromRows } = require('../utils/oiFlowIntervalOi');

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

function rowAt(ctx, m) {
  return ctx.byMin.get(m) || null;
}

function flowAtLocal(ctx, minute) {
  const i = ctx.idxOf.get(minute);
  const cur = rowAt(ctx, minute);
  if (i == null || i < 1 || !cur) {
    return {
      spotChg1: null,
      callChg: 0,
      putChg: 0,
      callAct: 'Call flat',
      putAct: 'Put flat',
    };
  }
  const prev = rowAt(ctx, ctx.mins[i - 1]);
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
    spotChg1: Number(dSpot.toFixed(2)),
    callChg: c,
    putChg: p,
    callAct: callAction(dSpot, c),
    putAct: putAction(dSpot, p),
  };
}

function swingSpot(rows, endIdx, n) {
  let hi = -Infinity;
  let lo = Infinity;
  const from = Math.max(0, endIdx - n + 1);
  for (let k = from; k <= endIdx; k += 1) {
    const s = Number(rows[k]?.spot);
    if (!Number.isFinite(s)) continue;
    if (s > hi) hi = s;
    if (s < lo) lo = s;
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return { hi, lo, range: hi - lo };
}

function slFromSwing(rows, entryIdx, entrySpot, side) {
  const s = swingSpot(rows, Math.max(0, entryIdx - 1), SL_RANGE_BARS);
  const r = Math.max(SL_RANGE_MIN_SPOT, (s?.range || SL_RANGE_MIN_SPOT) * SL_RANGE_MULT);
  return side === 'CE' ? entrySpot - r : entrySpot + r;
}

function simulateExit(rows, entryIdx, entrySpot, side, slSpot) {
  const minutes = rows[entryIdx].minutes;
  for (let j = entryIdx + 1; j < rows.length; j += 1) {
    const later = rows[j];
    const held = later.minutes - minutes;
    const laterSpot = Number(later.spot);
    const dSpot = laterSpot - entrySpot;
    const pts = side === 'PE' ? -(dSpot * PREMIUM_DELTA) : dSpot * PREMIUM_DELTA;
    if (!Number.isFinite(pts)) continue;

    const hitSl =
      Number.isFinite(slSpot) &&
      (side === 'PE' ? laterSpot >= slSpot : laterSpot <= slSpot);
    if (hitSl) {
      return {
        exitReason: 'SL',
        favorPts: Number(pts.toFixed(1)),
        hold: held,
        exitTime: later.time,
        exitMinutes: later.minutes,
        grade: 'Bad',
        exitSpot: laterSpot,
      };
    }
    if (pts >= TP_TRIGGER_PTS) {
      return {
        exitReason: 'TP',
        favorPts: Number(pts.toFixed(1)),
        hold: held,
        exitTime: later.time,
        exitMinutes: later.minutes,
        grade: 'Excellent',
        exitSpot: laterSpot,
      };
    }
  }
  const last = rows[rows.length - 1];
  const held = last.minutes - minutes;
  const dSpot = Number(last.spot) - entrySpot;
  const pts = side === 'PE' ? -(dSpot * PREMIUM_DELTA) : dSpot * PREMIUM_DELTA;
  const favorPts = Number((Number.isFinite(pts) ? pts : 0).toFixed(1));
  return {
    exitReason: 'EOD',
    favorPts,
    hold: held,
    exitTime: last.time,
    exitMinutes: last.minutes,
    grade: favorPts >= 0 ? 'Good' : 'Bad',
    exitSpot: Number(last.spot),
  };
}

async function loadDayRows(dateKey) {
  let mongo = [];
  try {
    mongo = await OiFlowMinuteRow.find({ symbol: 'NIFTY', dateKey }).sort({ minutes: 1 }).lean();
  } catch {
    mongo = [];
  }
  if (mongo.length >= 50) {
    return { source: 'mongo', rows: normalizeRows(mongo) };
  }
  const file = path.join(__dirname, '../../data', `oi-flow-${dateKey}.json`);
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.rows || [];
    return { source: 'json', file: `data/oi-flow-${dateKey}.json`, rows: normalizeRows(list) };
  }
  return { source: 'none', rows: [] };
}

function runDay(dateKey, rows, source) {
  const taken = [];
  const rawSetups = [];
  let openUntil = null;
  let cooldownUntil = null;
  let lastEntryMin = null;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const minutes = row.minutes;
    const ctx = buildIndex(rows.filter((r) => r.minutes <= minutes));

    if (openUntil != null && minutes < openUntil) continue;
    if (openUntil != null && minutes >= openUntil) {
      cooldownUntil = openUntil + COOLDOWN_MIN;
      openUntil = null;
    }

    const prev = rows[i - 1];
    const ctxPrev = prev ? buildIndex(rows.filter((r) => r.minutes <= prev.minutes)) : null;
    const prevBb = ctxPrev && prev ? bbAt(ctxPrev, prev.minutes) : null;
    const decision = decideBbBounce(ctx, minutes, prevBb);
    if (!decision) continue;
    if (decision.decision !== 'PUT BUY' && decision.decision !== 'CALL BUY') continue;

    rawSetups.push({
      time: decision.time,
      minutes,
      decision: decision.decision,
      pair: decision.pair,
      bbZone: decision.bb?.zone,
    });

    const inCooldown = cooldownUntil != null && minutes < cooldownUntil;
    if (openUntil != null || inCooldown) continue;
    if (lastEntryMin != null && minutes <= lastEntryMin) continue;

    const spotNow = Number(row.spot);
    const strike = Number.isFinite(spotNow) ? Math.round(spotNow / 50) * 50 : null;
    const optionType = decision.decision === 'PUT BUY' ? 'PE' : 'CE';
    const slSpot = slFromSwing(rows, i, spotNow, optionType);
    const exit = simulateExit(rows, i, spotNow, optionType, slSpot);
    taken.push({
      dateKey,
      time: row.time,
      minutes,
      signalTime: prev?.time || null,
      signalMinutes: prev?.minutes || null,
      spot: spotNow,
      strike,
      strikeLabel: strike ? `BUY NIFTY ${strike} ${optionType}` : null,
      optionType,
      decision: decision.decision,
      tone: optionType === 'CE' ? 'call' : 'put',
      callAct: actTail(decision.callAct),
      putAct: actTail(decision.putAct),
      pair: decision.pair,
      callOiL: decision.callChgL,
      putOiL: decision.putChgL,
      callChg: decision.callChg,
      putChg: decision.putChg,
      bbZone: decision.bb?.zone,
      bbLower: decision.bb?.lower,
      bbMid: decision.bb?.mid,
      bbUpper: decision.bb?.upper,
      candle: decision.candle,
      matchedRule: decision.matchedRule,
      slSpot,
      slOn: '1.5× 5m range',
      favorPts: exit.favorPts,
      hold: exit.hold,
      exitTime: exit.exitTime,
      exitReason: exit.exitReason,
      grade: exit.grade,
    });
    lastEntryMin = minutes;
    openUntil = exit.exitMinutes;
  }

  const excellent = taken.filter((s) => s.grade === 'Excellent').length;
  const good = taken.filter((s) => s.grade === 'Good').length;
  const bad = taken.filter((s) => s.grade === 'Bad').length;
  const favorSum = taken.reduce((a, s) => a + (Number(s.favorPts) || 0), 0);

  return {
    dateKey,
    source,
    rowsUsed: rows.length,
    first: rows[0]?.time || null,
    last: rows[rows.length - 1]?.time || null,
    rawSetups: rawSetups.length,
    summary: {
      entries: taken.length,
      call: taken.filter((s) => s.decision === 'CALL BUY').length,
      put: taken.filter((s) => s.decision === 'PUT BUY').length,
      excellent,
      good,
      bad,
      hitRatePct:
        taken.length > 0 ? Number((((excellent + good) / taken.length) * 100).toFixed(1)) : null,
      sumFavorPts: Number(favorSum.toFixed(1)),
    },
    signals: taken,
  };
}

async function runBbBounceBacktest(dateKeys = DATES) {
  const days = [];
  for (const dateKey of dateKeys) {
    const loaded = await loadDayRows(dateKey);
    days.push(runDay(dateKey, loaded.rows, loaded.source));
  }
  const overall = days.reduce(
    (acc, r) => {
      acc.entries += r.summary.entries;
      acc.call += r.summary.call;
      acc.put += r.summary.put;
      acc.excellent += r.summary.excellent;
      acc.good += r.summary.good;
      acc.bad += r.summary.bad;
      acc.sumFavorPts += r.summary.sumFavorPts;
      acc.rawSetups += r.rawSetups;
      return acc;
    },
    {
      entries: 0,
      call: 0,
      put: 0,
      excellent: 0,
      good: 0,
      bad: 0,
      sumFavorPts: 0,
      rawSetups: 0,
    },
  );
  overall.sumFavorPts = Number(overall.sumFavorPts.toFixed(1));
  overall.hitRatePct =
    overall.entries > 0
      ? Number((((overall.excellent + overall.good) / overall.entries) * 100).toFixed(1))
      : null;

  return {
    generatedAt: new Date().toISOString(),
    strategy: 'OI Flow BB Bounce',
    rules: {
      bb: 'BB(20, 2) SMA · touch within 5 pts',
      callBuy: 'Prev bar at lower BB, this bar closes back inside + green + strong4 OI ≥ 1L',
      putBuy: 'Prev bar at upper BB, this bar closes back inside + red + strong4 OI ≥ 1L',
      skippedPair: 'short cover / long unwind · writing / short cover · OI mag < 1L',
      window: '09:30–14:30',
      book: `1 open · 30m cooldown · TP +${TARGET_PTS} + ${TARGET_GAP} gap synth pts · SL = 1.5× last 5-min spot range (min 10 pts) · hold until TP/SL/EOD`,
      ptsNote:
        `NIFTY synth only (0.5× spot). TP fires at +${TP_TRIGGER_PTS} synth pts (~${TP_TRIGGER_PTS * 2} spot pts). Do not buy the touch — buy the reclaim.`,
    },
    dates: dateKeys,
    days,
    overall,
  };
}

module.exports = {
  DATES,
  decideBbBounce,
  runBbBounceBacktest,
  pairFavours,
  loadDayRows,
  prevCandleRange: slFromSwing,
  slFromSwing,
  simulateExit,
};

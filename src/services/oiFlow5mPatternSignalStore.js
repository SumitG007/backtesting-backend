/**
 * Detect + persist closed 5m CALL BUY / PUT BUY pattern signals.
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const OiFlow5mPatternSignal = require('../models/oiFlow5mPatternSignal');
const { getIstClock } = require('../utils/dateTime');
const {
  STEP_5M,
  LIVE_PATTERNS,
  build5mBars,
  matchLivePattern,
  isClosed5mMinutes,
} = require('../utils/oiFlow5mPatterns');

function toClient(row) {
  return {
    time: row.time,
    minutes: row.minutes,
    decision: row.decision,
    tone: row.tone,
    patternId: row.patternId,
    patternName: row.patternName,
    shortName: row.shortName || null,
    spot: row.spot,
    spotDelta: row.spotDelta,
    atm: row.atm,
    strength: row.strength,
    strengthScore: row.strengthScore,
    streak: row.streak,
    act: row.act,
    flowBias: row.flowBias,
    callAct: row.callAct,
    putAct: row.putAct,
    source: row.source || 'live',
  };
}

function docFromMatch(bar, match, source) {
  return {
    symbol: bar.symbol || 'NIFTY',
    dateKey: bar.dateKey,
    minutes: bar.minutes,
    time: bar.time,
    decision: match.decision,
    tone: match.tone,
    patternId: match.patternId,
    patternName: match.patternName,
    shortName: match.shortName,
    spot: Number.isFinite(Number(bar.spot)) ? Number(bar.spot) : null,
    spotDelta: Number.isFinite(Number(bar.spotDelta)) ? Number(bar.spotDelta) : null,
    atm: Number.isFinite(Number(bar.atm)) ? Number(bar.atm) : null,
    strength: bar.strength?.label || null,
    strengthScore: Number.isFinite(Number(bar.strength?.score))
      ? Number(bar.strength.score)
      : null,
    streak: Number.isFinite(Number(bar.streak)) ? Number(bar.streak) : null,
    act: bar.act || null,
    flowBias: bar.flowBias || null,
    callAct: bar.callAct || null,
    putAct: bar.putAct || null,
    source,
  };
}

async function upsertSignal(bar, match, source) {
  const doc = docFromMatch(bar, match, source);
  return OiFlow5mPatternSignal.findOneAndUpdate(
    { symbol: doc.symbol, dateKey: doc.dateKey, minutes: doc.minutes },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

/**
 * Re-scan all closed 5m bars for dateKey and upsert matching signals.
 * Removes stale signals that no longer match (same day rewrite).
 */
async function backfill5mPatternSignals(dateKey, opts = {}) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const source = opts.source || 'backfill';

  const raw = await OiFlowMinuteRow.find({ symbol, dateKey: key, fetchOk: true })
    .sort({ minutes: 1 })
    .select({
      symbol: 1,
      dateKey: 1,
      minutes: 1,
      time: 1,
      spotPrice: 1,
      atm: 1,
      dayCallChgOi: 1,
      dayPutChgOi: 1,
      callsChgOi: 1,
      putsChgOi: 1,
      callOiTotal: 1,
      putOiTotal: 1,
      oiMigration: 1,
      fetchOk: 1,
    })
    .lean();

  const bars = build5mBars(raw, STEP_5M);
  const keptMinutes = new Set();
  const saved = [];

  for (const bar of bars) {
    const match = matchLivePattern(bar);
    if (!match) continue;
    const upserted = await upsertSignal(bar, match, source);
    keptMinutes.add(upserted.minutes);
    saved.push(toClient(upserted));
  }

  // Drop signals that no longer match after a full recompute.
  await OiFlow5mPatternSignal.deleteMany({
    symbol,
    dateKey: key,
    minutes: { $nin: [...keptMinutes] },
  });

  const callCount = saved.filter((s) => s.decision === 'CALL BUY').length;
  const putCount = saved.filter((s) => s.decision === 'PUT BUY').length;

  return {
    ok: true,
    dateKey: key,
    bars: bars.length,
    saved: saved.length,
    callCount,
    putCount,
    patterns: LIVE_PATTERNS.map((p) => ({
      id: p.id,
      decision: p.decision,
      name: p.name,
    })),
    signals: saved,
  };
}

/**
 * After a minute capture: if this minute closes a 5m bar, detect + save signal.
 */
async function detectLive5mPatternSignal({ symbol = 'NIFTY', dateKey, minutes } = {}) {
  if (!dateKey || !Number.isFinite(Number(minutes))) return null;
  if (!isClosed5mMinutes(minutes)) return null;

  const raw = await OiFlowMinuteRow.find({ symbol, dateKey, fetchOk: true })
    .sort({ minutes: 1 })
    .select({
      symbol: 1,
      dateKey: 1,
      minutes: 1,
      time: 1,
      spotPrice: 1,
      atm: 1,
      dayCallChgOi: 1,
      dayPutChgOi: 1,
      callsChgOi: 1,
      putsChgOi: 1,
      callOiTotal: 1,
      putOiTotal: 1,
      oiMigration: 1,
      fetchOk: 1,
    })
    .lean();

  const bars = build5mBars(raw, STEP_5M);
  const bar = bars.find((b) => Number(b.minutes) === Number(minutes));
  if (!bar) {
    // Closed grid minute with no match → clear any stale signal at this minute.
    await OiFlow5mPatternSignal.deleteOne({ symbol, dateKey, minutes: Number(minutes) });
    return null;
  }

  const match = matchLivePattern(bar);
  if (!match) {
    await OiFlow5mPatternSignal.deleteOne({ symbol, dateKey, minutes: Number(minutes) });
    return null;
  }

  const upserted = await upsertSignal(bar, match, 'live');
  return toClient(upserted);
}

async function list5mPatternSignals(dateKey, opts = {}) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const rows = await OiFlow5mPatternSignal.find({ symbol, dateKey: key })
    .sort({ minutes: 1 })
    .lean();
  const signals = rows.map(toClient);
  return {
    dateKey: key,
    callCount: signals.filter((s) => s.decision === 'CALL BUY').length,
    putCount: signals.filter((s) => s.decision === 'PUT BUY').length,
    signals,
  };
}

/**
 * Ensure today has been backfilled at least once (morning→now from existing minutes).
 * Cheap if already populated and minute count hasn't jumped past last signal.
 */
async function ensureToday5mPatternSignalsBackfilled(dateKey, opts = {}) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const existing = await OiFlow5mPatternSignal.countDocuments({ symbol, dateKey: key });
  const lastMinute = await OiFlowMinuteRow.findOne({ symbol, dateKey: key, fetchOk: true })
    .sort({ minutes: -1 })
    .select({ minutes: 1 })
    .lean();
  const lastSignal = await OiFlow5mPatternSignal.findOne({ symbol, dateKey: key })
    .sort({ minutes: -1 })
    .select({ minutes: 1 })
    .lean();

  const needFull =
    existing === 0
    || (lastMinute
      && isClosed5mMinutes(lastMinute.minutes)
      && (!lastSignal || Number(lastSignal.minutes) < Number(lastMinute.minutes) - STEP_5M * 2));

  if (needFull || opts.force) {
    return backfill5mPatternSignals(key, { symbol, source: 'backfill' });
  }

  // Keep live path: try detect on latest closed 5m if present.
  if (lastMinute && isClosed5mMinutes(lastMinute.minutes)) {
    await detectLive5mPatternSignal({
      symbol,
      dateKey: key,
      minutes: lastMinute.minutes,
    });
  }

  return list5mPatternSignals(key, { symbol });
}

module.exports = {
  backfill5mPatternSignals,
  detectLive5mPatternSignal,
  list5mPatternSignals,
  ensureToday5mPatternSignalsBackfilled,
  LIVE_PATTERNS,
};

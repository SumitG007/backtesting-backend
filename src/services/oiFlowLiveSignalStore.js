/**
 * Persist live OI-Flow signals at the moment the paper engine takes them.
 * Lookbacks are frozen from current + past minute rows only (no future).
 */
const OiFlowLiveSignal = require('../models/oiFlowLiveSignal');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const LivePaperTrade = require('../models/livePaperTrade');
const { OI_FLOW_TRACKER_LIVE_KEY } = require('../strategies/keys');
const { getIstClock } = require('../utils/dateTime');

function fmtLakh(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v / 100000).toFixed(2)}L`;
}

function formatHhmm(minutes) {
  if (!Number.isFinite(Number(minutes))) return null;
  const m = Math.max(0, Math.floor(Number(minutes)));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function lookbackSpot(byMin, minutes, ago) {
  const target = minutes - ago;
  if (byMin.has(target)) return Number(byMin.get(target).spot);
  for (let m = target; m >= target - 3; m -= 1) {
    if (byMin.has(m)) return Number(byMin.get(m).spot);
  }
  return null;
}

function tfFromLookback(spotNow, spotThen) {
  if (!Number.isFinite(spotNow) || !Number.isFinite(spotThen)) {
    return { label: '—', tone: 'flat' };
  }
  const d = spotNow - spotThen;
  if (d > 0.5) return { label: 'Bull', tone: 'bull' };
  if (d < -0.5) return { label: 'Bear', tone: 'bear' };
  return { label: 'Flat', tone: 'flat' };
}

function oiQuality(callAct, putAct) {
  const c = String(callAct || '');
  const p = String(putAct || '');
  if (/Put buying/i.test(p) && /Call writing/i.test(c)) {
    return { text: 'Call writing + Put buying = strong bearish confirmation', tone: 'bear' };
  }
  if (/Put buying/i.test(p) && /Call long unwind/i.test(c)) {
    return { text: 'Call long unwind + Put buying = bearish confirmation', tone: 'bear' };
  }
  if (/Put writing/i.test(p) && /Call short cover/i.test(c)) {
    return { text: 'Call short cover + Put writing = strong bullish confirmation', tone: 'bull' };
  }
  if (/Put writing/i.test(p) && /Call long build/i.test(c)) {
    return { text: 'Call long build + Put writing = bullish / mixed', tone: 'bull' };
  }
  if (/Put long unwind/i.test(p) && /Call short cover/i.test(c)) {
    return { text: 'Call short cover + Put long unwind = weak / conflicting', tone: 'flat' };
  }
  return { text: `${c || 'Call —'} + ${p || 'Put —'}`.trim(), tone: 'flat' };
}

function mapExitReason(reason) {
  const r = String(reason || '');
  if (r === 'TARGET') return 'TP';
  if (r === 'STOP_LOSS') return 'SL';
  if (r === 'TIME_EXIT') return 'TIME';
  if (r === 'DAY_CLOSE') return 'EOD';
  if (r === 'OPEN' || !r) return 'OPEN';
  return r;
}

function gradeFrom(exitReason, favorPts, targetPoints = 10) {
  const mapped = mapExitReason(exitReason);
  if (mapped === 'OPEN') return 'Pending';
  if (mapped === 'TP') return 'Excellent';
  if (mapped === 'SL') return 'Bad';
  const pts = Number(favorPts);
  if (!Number.isFinite(pts)) return 'Pending';
  if (pts >= Number(targetPoints) || pts >= 10) return 'Excellent';
  return pts >= 0 ? 'Good' : 'Bad';
}

function buildLookbacks(rawRows, minutes, spotNow) {
  const byMin = new Map();
  for (const r of Array.isArray(rawRows) ? rawRows : []) {
    const m = Number(r.minutes);
    if (!Number.isFinite(m)) continue;
    byMin.set(m, { spot: Number(r.spotPrice ?? r.spot) });
  }
  const tf15 = tfFromLookback(spotNow, lookbackSpot(byMin, minutes, 15));
  const tf5 = tfFromLookback(spotNow, lookbackSpot(byMin, minutes, 5));
  const tf3 = tfFromLookback(spotNow, lookbackSpot(byMin, minutes, 3));
  const tf1 = tfFromLookback(spotNow, lookbackSpot(byMin, minutes, 1));
  const spotThen = lookbackSpot(byMin, minutes, 15);
  const spot15 =
    Number.isFinite(spotNow) && Number.isFinite(spotThen)
      ? Number((spotNow - spotThen).toFixed(1))
      : null;
  const allBear = [tf15, tf5, tf3, tf1].every((t) => t.tone === 'bear');
  return { tf15, tf5, tf3, tf1, spot15, allBear };
}

async function saveLiveSignalFromEntry(trade, signal) {
  if (!trade || !signal) return null;
  const decision = signal.decision === 'PUT BUY' ? 'PUT BUY' : 'CALL BUY';
  const clock = getIstClock(trade.entryTime || new Date());
  const dateKey = trade.entryDateKey || clock.dateKey;
  const minutes = Number(signal.minutes);
  const spot = Number(signal.spot);
  const rawRows = await OiFlowMinuteRow.find({
    symbol: trade.symbol || 'NIFTY',
    dateKey,
  })
    .sort({ minutes: 1 })
    .lean();
  const look = buildLookbacks(rawRows, minutes, spot);
  const targetPoints = Number(trade.targetPremium) - Number(trade.entryPremium);
  const stopLossPoints = Number(trade.entryPremium) - Number(trade.stopLossPremium);
  const optionType =
    String(trade.optionType || '').toUpperCase() === 'PE'
      ? 'PE'
      : decision === 'PUT BUY'
        ? 'PE'
        : 'CE';
  let strike = Number(trade.strike);
  if (!Number.isFinite(strike) || strike <= 0) {
    strike = Number(signal.strike);
  }
  if (!Number.isFinite(strike) || strike <= 0) {
    strike = Number.isFinite(spot) ? Math.round(spot / 50) * 50 : null;
  }
  const symbol = trade.symbol || 'NIFTY';
  const strikeLabel = Number.isFinite(strike)
    ? `${symbol} ${strike} ${optionType}`
    : null;
  const doc = {
    symbol,
    dateKey,
    minutes,
    time: signal.time || trade.signalSnapshot?.time,
    decision,
    tone: decision === 'CALL BUY' ? 'call' : 'put',
    optionType,
    strike: Number.isFinite(strike) ? strike : null,
    strikeLabel,
    control: decision === 'PUT BUY' || look.allBear ? 'Sellers' : 'Buyers',
    spot,
    callChg: Number(signal.callChg),
    putChg: Number(signal.putChg),
    callOiL: signal.callChgL || fmtLakh(signal.callChg),
    putOiL: signal.putChgL || fmtLakh(signal.putChg),
    callAct: signal.callAct || null,
    putAct: signal.putAct || null,
    quality: oiQuality(signal.callAct, signal.putAct),
    tf15: look.tf15,
    tf5: look.tf5,
    tf3: look.tf3,
    tf1: look.tf1,
    spot15: look.spot15,
    tradeId: trade._id,
    status: 'OPEN',
    entryPremium: Number(trade.entryPremium),
    exitPremium: null,
    favorPts: 0,
    hold: 0,
    exitMinutes: null,
    exitTime: null,
    exitReason: 'OPEN',
    grade: 'Pending',
    tpLeft: Number.isFinite(targetPoints) ? Number(targetPoints.toFixed(1)) : 10,
    slLeft: Number.isFinite(stopLossPoints) ? Number(stopLossPoints.toFixed(1)) : 8,
    targetPoints: Number.isFinite(targetPoints) ? Number(targetPoints.toFixed(1)) : 10,
    stopLossPoints: Number.isFinite(stopLossPoints) ? Number(stopLossPoints.toFixed(1)) : 8,
  };
  return OiFlowLiveSignal.findOneAndUpdate(
    { dateKey, minutes, decision },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function updateLiveSignalOnExit(trade) {
  if (!trade?._id) return null;
  const entry = Number(trade.entryPremium);
  const exitPx = Number(trade.exitPremium);
  const favorPts =
    Number.isFinite(entry) && Number.isFinite(exitPx)
      ? Number((exitPx - entry).toFixed(2))
      : null;
  const hold =
    trade.entryTime && trade.exitTime
      ? Math.max(0, Math.round((new Date(trade.exitTime) - new Date(trade.entryTime)) / 60000))
      : null;
  const targetPoints =
    Number.isFinite(Number(trade.targetPremium)) && Number.isFinite(entry)
      ? Number((Number(trade.targetPremium) - entry).toFixed(1))
      : 10;
  const exitReason = mapExitReason(trade.reason);
  const exitClock = trade.exitTime ? getIstClock(trade.exitTime) : null;
  const exitMinutes = exitClock != null ? exitClock.minutes : null;
  const exitTime = formatHhmm(exitMinutes);
  return OiFlowLiveSignal.findOneAndUpdate(
    { tradeId: trade._id },
    {
      $set: {
        status: 'CLOSED',
        exitPremium: Number.isFinite(exitPx) ? exitPx : null,
        favorPts,
        hold,
        exitMinutes,
        exitTime,
        exitReason,
        grade: gradeFrom(trade.reason, favorPts, targetPoints),
        tpLeft: 0,
        slLeft: 0,
      },
    },
    { new: true },
  );
}

async function updateLiveSignalOpenMark(trade) {
  if (!trade?._id || trade.status !== 'OPEN') return null;
  const pts = Number(trade.openPositionMark?.pts);
  const entry = Number(trade.entryPremium);
  const targetPoints =
    Number.isFinite(Number(trade.targetPremium)) && Number.isFinite(entry)
      ? Number((Number(trade.targetPremium) - entry).toFixed(1))
      : 10;
  const stopLossPoints =
    Number.isFinite(entry) && Number.isFinite(Number(trade.stopLossPremium))
      ? Number((entry - Number(trade.stopLossPremium)).toFixed(1))
      : 8;
  const hold = trade.entryTime
    ? Math.max(0, Math.round((Date.now() - new Date(trade.entryTime).getTime()) / 60000))
    : 0;
  const favorPts = Number.isFinite(pts) ? Number(pts.toFixed(2)) : 0;
  return OiFlowLiveSignal.findOneAndUpdate(
    { tradeId: trade._id, status: 'OPEN' },
    {
      $set: {
        favorPts,
        hold,
        exitReason: 'OPEN',
        grade: 'Pending',
        tpLeft: Number((targetPoints - favorPts).toFixed(1)),
        slLeft: Number((favorPts + stopLossPoints).toFixed(1)),
      },
    },
    { new: true },
  );
}

function toClient(row) {
  return {
    time: row.time,
    minutes: row.minutes,
    spot: row.spot,
    tf15: row.tf15 || { label: '—', tone: 'flat' },
    tf5: row.tf5 || { label: '—', tone: 'flat' },
    tf3: row.tf3 || { label: '—', tone: 'flat' },
    tf1: row.tf1 || { label: '—', tone: 'flat' },
    callOiL: row.callOiL,
    putOiL: row.putOiL,
    callChg: row.callChg,
    putChg: row.putChg,
    quality: row.quality || { text: '', tone: 'flat' },
    control: row.control,
    spot15: row.spot15,
    decision: row.decision,
    tone: row.tone,
    optionType: row.optionType || (row.tone === 'put' ? 'PE' : 'CE'),
    strike: row.strike,
    strikeLabel:
      row.strikeLabel ||
      (Number.isFinite(Number(row.strike))
        ? `${row.symbol || 'NIFTY'} ${row.strike} ${
            row.optionType || (row.tone === 'put' ? 'PE' : 'CE')
          }`
        : null),
    favorPts: row.favorPts,
    hold: row.hold,
    exitMinutes: row.exitMinutes,
    exitTime:
      row.exitTime ||
      (Number.isFinite(Number(row.exitMinutes))
        ? formatHhmm(row.exitMinutes)
        : Number.isFinite(Number(row.minutes)) && Number.isFinite(Number(row.hold)) && row.status === 'CLOSED'
          ? formatHhmm(Number(row.minutes) + Number(row.hold))
          : null),
    exitReason: row.exitReason,
    grade: row.grade,
    tpLeft: row.tpLeft,
    slLeft: row.slLeft,
    status: row.status,
    tradeId: row.tradeId ? String(row.tradeId) : null,
    putChgL: row.putOiL,
  };
}

async function backfillFromTrades(dateKey) {
  const trades = await LivePaperTrade.find({
    strategyKey: OI_FLOW_TRACKER_LIVE_KEY,
    entryDateKey: dateKey,
  })
    .sort({ entryTime: 1 })
    .lean();
  for (const trade of trades) {
    const snap = trade.signalSnapshot || {};
    if (!snap.decision || !Number.isFinite(Number(snap.minutes))) continue;
    const exists = await OiFlowLiveSignal.findOne({ tradeId: trade._id }).lean();
    if (exists) continue;
    await saveLiveSignalFromEntry(trade, snap);
    if (trade.status === 'CLOSED') {
      await updateLiveSignalOnExit(trade);
    }
  }
}

/**
 * Force-save live-matched signals for a date from minute rows
 * (same gates as paper engine: 1 open, TP+10/SL-8/15m, cooldown 30m, re-arm after WAIT).
 * Used when the live engine was not running during market hours.
 */
async function forceBackfillLiveSignalsFromMinutes(dateKey, opts = {}) {
  const {
    decideRaw,
    normalizeRows,
    buildIndex,
  } = require('./oiFlowSignalEngine');

  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const minPutOi = Number(opts.minPutOi) || 250000;
  const maxPutOi = Number(opts.maxPutOi) || 3000000;
  const requireSpotAlign = opts.requireSpotAlign !== false;
  const targetPts = Number(opts.targetPoints) || 10;
  const stopPts = Number(opts.stopLossPoints) || 8;
  const holdMin = Number(opts.maxHoldMinutes) || 15;
  const cooldownMin = Number(opts.cooldownMinutes) || 30;
  const premiumDelta = 0.5; // spot→premium proxy (same as UI walk-forward)

  const raw = await OiFlowMinuteRow.find({ symbol, dateKey: key }).sort({ minutes: 1 }).lean();
  const rows = normalizeRows(raw);
  if (rows.length < 2) {
    return { ok: false, dateKey: key, error: 'not enough minute rows', rows: raw.length, saved: 0 };
  }

  // Keep real trade-linked signals; replace forced/sim ones for this date.
  await OiFlowLiveSignal.deleteMany({
    symbol,
    dateKey: key,
    $or: [{ tradeId: null }, { tradeId: { $exists: false } }],
  });

  const ctx = buildIndex(rows);
  let armed = true;
  let openUntil = null;
  let cooldownUntil = null;
  const saved = [];

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const minutes = row.minutes;

    if (openUntil != null && minutes < openUntil) continue;
    if (openUntil != null && minutes >= openUntil) {
      cooldownUntil = openUntil + cooldownMin;
      openUntil = null;
    }

    const decision = decideRaw(ctx, minutes, {
      minPutOi,
      maxPutOi,
      requireSpotAlign,
    });
    if (!decision) continue;

    if (decision.decision === 'WAIT') {
      armed = true;
      continue;
    }
    if (decision.decision !== 'PUT BUY' && decision.decision !== 'CALL BUY') continue;
    if (!armed) continue;
    if (cooldownUntil != null && minutes < cooldownUntil) continue;

    const side = decision.decision === 'PUT BUY' ? 'PE' : 'CE';
    const entrySpot = Number(row.spot);
    let exitReason = 'OPEN';
    let favorPts = null;
    let hold = 0;
    let exitMin = null;
    let grade = 'Pending';
    let status = 'OPEN';

    for (let j = i + 1; j < rows.length; j += 1) {
      const later = rows[j];
      const held = later.minutes - minutes;
      const dSpot = Number(later.spot) - entrySpot;
      const pts = side === 'PE' ? -(dSpot * premiumDelta) : dSpot * premiumDelta;
      if (!Number.isFinite(pts)) continue;
      if (pts <= -stopPts) {
        exitReason = 'SL';
        favorPts = -stopPts;
        hold = held;
        exitMin = later.minutes;
        grade = 'Bad';
        status = 'CLOSED';
        break;
      }
      if (pts >= targetPts) {
        exitReason = 'TP';
        favorPts = targetPts;
        hold = held;
        exitMin = later.minutes;
        grade = 'Excellent';
        status = 'CLOSED';
        break;
      }
      if (held >= holdMin) {
        favorPts = Number(pts.toFixed(1));
        hold = holdMin;
        exitMin = later.minutes;
        exitReason = 'TIME';
        grade = favorPts >= 0 ? 'Good' : 'Bad';
        status = 'CLOSED';
        break;
      }
    }

    if (status === 'OPEN') {
      const last = rows[rows.length - 1];
      const dSpot = Number(last.spot) - entrySpot;
      const pts = side === 'PE' ? -(dSpot * premiumDelta) : dSpot * premiumDelta;
      favorPts = Number.isFinite(pts) ? Number(pts.toFixed(1)) : 0;
      hold = Math.max(0, last.minutes - minutes);
    }

    armed = false;
    openUntil = exitMin != null ? exitMin : Number.POSITIVE_INFINITY;

    const look = buildLookbacks(raw, minutes, entrySpot);
    const optionType = side;
    let strike = Number(raw.find((r) => Number(r.minutes) === minutes)?.atm);
    if (!Number.isFinite(strike) || strike <= 0) {
      strike = Number.isFinite(entrySpot) ? Math.round(entrySpot / 50) * 50 : null;
    }
    const strikeLabel = Number.isFinite(strike) ? `${symbol} ${strike} ${optionType}` : null;

    const doc = {
      symbol,
      dateKey: key,
      minutes,
      time: decision.time || row.time,
      decision: decision.decision,
      tone: decision.decision === 'CALL BUY' ? 'call' : 'put',
      optionType,
      strike: Number.isFinite(strike) ? strike : null,
      strikeLabel,
      control: decision.decision === 'PUT BUY' || look.allBear ? 'Sellers' : 'Buyers',
      spot: entrySpot,
      callChg: Number(decision.callChg),
      putChg: Number(decision.putChg),
      callOiL: decision.callChgL || fmtLakh(decision.callChg),
      putOiL: decision.putChgL || fmtLakh(decision.putChg),
      callAct: decision.callAct || null,
      putAct: decision.putAct || null,
      quality: oiQuality(decision.callAct, decision.putAct),
      tf15: look.tf15,
      tf5: look.tf5,
      tf3: look.tf3,
      tf1: look.tf1,
      spot15: look.spot15,
      tradeId: null,
      status,
      entryPremium: null,
      exitPremium: null,
      favorPts,
      hold,
      exitMinutes: exitMin,
      exitTime: formatHhmm(exitMin),
      exitReason,
      grade,
      tpLeft: status === 'OPEN' && favorPts != null ? Number((targetPts - favorPts).toFixed(1)) : 0,
      slLeft: status === 'OPEN' && favorPts != null ? Number((favorPts + stopPts).toFixed(1)) : 0,
      targetPoints: targetPts,
      stopLossPoints: stopPts,
    };

    const upserted = await OiFlowLiveSignal.findOneAndUpdate(
      { dateKey: key, minutes, decision: decision.decision },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    saved.push({
      time: upserted.time,
      decision: upserted.decision,
      strikeLabel: upserted.strikeLabel,
      grade: upserted.grade,
      favorPts: upserted.favorPts,
      exitReason: upserted.exitReason,
      exitTime: upserted.exitTime,
      hold: upserted.hold,
    });
  }

  // Also merge any real paper trades for the day.
  await backfillFromTrades(key);

  return {
    ok: true,
    dateKey: key,
    rows: rows.length,
    saved: saved.length,
    signals: saved,
  };
}

async function listLiveSignals(dateKey) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  let rows = await OiFlowLiveSignal.find({ symbol: 'NIFTY', dateKey: key })
    .sort({ minutes: 1, createdAt: 1 })
    .lean();
  if (rows.length === 0) {
    await backfillFromTrades(key);
    rows = await OiFlowLiveSignal.find({ symbol: 'NIFTY', dateKey: key })
      .sort({ minutes: 1, createdAt: 1 })
      .lean();
  }
  const dates = await OiFlowLiveSignal.distinct('dateKey', { symbol: 'NIFTY' });
  const closedPts = rows
    .filter((r) => r.grade !== 'Pending' && r.status === 'CLOSED')
    .reduce((sum, r) => sum + (Number(r.favorPts) || 0), 0);
  return {
    dateKey: key,
    todayKey: getIstClock(new Date()).dateKey,
    availableDates: dates.sort(),
    signals: rows.map(toClient),
    closedPts: Number(closedPts.toFixed(2)),
  };
}

module.exports = {
  saveLiveSignalFromEntry,
  updateLiveSignalOnExit,
  updateLiveSignalOpenMark,
  listLiveSignals,
  forceBackfillLiveSignalsFromMinutes,
};

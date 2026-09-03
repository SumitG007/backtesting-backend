/**
 * Persist + monitor 15m E/B playbook trades.
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const OiFlowPlaybookTrade = require('../models/oiFlowPlaybookTrade');
const { getIstClock } = require('../utils/dateTime');
const {
  simulatePlaybookDay,
  markOpenTrade,
  matchLivePattern,
  build5mBars,
  attachCandleRange,
  riskLevels,
  walkExit,
  STEP,
  MAX_HOLD,
  DAILY_TARGET,
  DAILY_LOSS,
  round,
} = require('../utils/oiFlowPlaybook');

function toClient(row) {
  return {
    id: String(row._id),
    dateKey: row.dateKey,
    entryTime: row.entryTime,
    entryMinutes: row.entryMinutes,
    exitTime: row.exitTime,
    exitMinutes: row.exitMinutes,
    decision: row.decision,
    side: row.side,
    tone: row.tone,
    patternId: row.patternId,
    patternName: row.patternName,
    shortName: row.shortName,
    strength: row.strength,
    spotDelta: row.spotDelta,
    act: row.act,
    entrySpot: row.entrySpot,
    exitSpot: row.exitSpot,
    markSpot: row.markSpot,
    candleHigh: row.candleHigh,
    candleLow: row.candleLow,
    candleRange: row.candleRange,
    rawRisk: row.rawRisk,
    riskPts: row.riskPts,
    rewardPts: row.rewardPts,
    stopSpot: row.stopSpot,
    targetSpot: row.targetSpot,
    clamped: row.clamped,
    favorPts: row.favorPts,
    mae: row.mae,
    mfe: row.mfe,
    holdMin: row.holdMin,
    tpLeft: row.tpLeft,
    slLeft: row.slLeft,
    status: row.status,
    exitReason: row.exitReason,
    dayPtsAfter: row.dayPtsAfter,
    dayStopReason: row.dayStopReason,
    source: row.source,
  };
}

function summarize(trades) {
  let earned = 0;
  let lost = 0;
  let tp = 0;
  let sl = 0;
  let time = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    if (t.status !== 'CLOSED') continue;
    const p = Number(t.favorPts) || 0;
    if (p > 0) {
      wins += 1;
      earned += p;
    } else if (p < 0) {
      losses += 1;
      lost += p;
    }
    if (t.exitReason === 'TP') tp += 1;
    else if (t.exitReason === 'SL') sl += 1;
    else time += 1;
  }
  const closed = trades.filter((t) => t.status === 'CLOSED');
  const net = round(earned + lost);
  return {
    closed: closed.length,
    open: trades.filter((t) => t.status === 'OPEN').length,
    wins,
    losses,
    winRate: closed.length ? Math.round((100 * wins) / closed.length) : 0,
    tp,
    sl,
    time,
    earned: round(earned),
    lost: round(lost),
    net,
  };
}

async function loadRaw(dateKey, symbol = 'NIFTY') {
  return OiFlowMinuteRow.find({ symbol, dateKey, fetchOk: true })
    .sort({ minutes: 1 })
    .lean();
}

/**
 * Replace today's book with playbook simulation from minute tape.
 */
async function backfillPlaybookTrades(dateKey, opts = {}) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const raw = await loadRaw(key, symbol);
  const sim = simulatePlaybookDay(raw, opts);

  await OiFlowPlaybookTrade.deleteMany({ symbol, dateKey: key });

  const docs = [];
  for (const t of sim.trades) {
    const doc = await OiFlowPlaybookTrade.create({
      symbol,
      dateKey: key,
      entryMinutes: t.entryMinutes,
      entryTime: t.entryTime,
      exitMinutes: t.exitMinutes,
      exitTime: t.exitTime,
      decision: t.decision,
      side: t.side,
      tone: t.side === 'CALL' ? 'call' : 'put',
      patternId: t.patternId,
      patternName: t.patternName,
      shortName: t.shortName,
      strength: t.strength,
      spotDelta: t.spotDelta,
      act: t.act,
      entrySpot: t.entrySpot,
      exitSpot: Number.isFinite(Number(t.exitSpot)) ? Number(t.exitSpot) : null,
      markSpot: null,
      candleHigh: t.candleHigh,
      candleLow: t.candleLow,
      candleRange: t.candleRange,
      rawRisk: t.rawRisk,
      riskPts: t.riskPts,
      rewardPts: t.rewardPts,
      stopSpot: t.stopSpot,
      targetSpot: t.targetSpot,
      clamped: t.clamped,
      favorPts: t.favorPts,
      mae: t.mae,
      mfe: t.mfe,
      holdMin: t.holdMin,
      tpLeft: 0,
      slLeft: 0,
      status: 'CLOSED',
      exitReason: t.exitReason,
      dayPtsAfter: t.dayPtsAfter,
      dayStopReason: t.dayStopReason || null,
      source: 'backfill',
    });
    docs.push(doc);
  }

  const trades = docs.map(toClient);
  return {
    ok: true,
    dateKey: key,
    bars: sim.bars,
    rules: sim.rules,
    dayPts: sim.dayPts,
    dayStopReason: sim.dayStopReason,
    summary: summarize(trades),
    open: null,
    trades,
  };
}

async function dayNetSoFar(dateKey, symbol = 'NIFTY') {
  const closed = await OiFlowPlaybookTrade.find({
    symbol,
    dateKey,
    status: 'CLOSED',
  }).lean();
  return round(closed.reduce((s, t) => s + (Number(t.favorPts) || 0), 0));
}

async function dayIsLocked(dateKey, symbol = 'NIFTY') {
  const net = await dayNetSoFar(dateKey, symbol);
  if (net >= DAILY_TARGET) {
    return { locked: true, reason: `Daily target +${DAILY_TARGET}`, net };
  }
  if (net <= -DAILY_LOSS) {
    return { locked: true, reason: `Daily loss −${DAILY_LOSS}`, net };
  }
  return { locked: false, reason: null, net };
}

/**
 * After a closed LIVE_STEP bar: open a new trade if book allows.
 */
async function detectLivePlaybookEntry({ symbol = 'NIFTY', dateKey, minutes } = {}) {
  if (!dateKey || !Number.isFinite(Number(minutes))) return null;
  if ((Number(minutes) - (9 * 60 + 15)) % STEP !== 0) return null;

  const open = await OiFlowPlaybookTrade.findOne({
    symbol,
    dateKey,
    status: 'OPEN',
  }).lean();
  if (open) return null;

  const lock = await dayIsLocked(dateKey, symbol);
  if (lock.locked) return null;

  const raw = await loadRaw(dateKey, symbol);
  const rawByMin = new Map(raw.map((r) => [Number(r.minutes), r]));
  let bars = build5mBars(raw, STEP);
  bars = attachCandleRange(bars, rawByMin);
  const bar = bars.find((b) => Number(b.minutes) === Number(minutes));
  if (!bar) return null;

  const match = matchLivePattern(bar);
  if (!match) return null;

  const exists = await OiFlowPlaybookTrade.findOne({
    symbol,
    dateKey,
    entryMinutes: bar.minutes,
    decision: match.decision,
  }).lean();
  if (exists) return exists;

  const lv = riskLevels(bar, match.side);
  const doc = await OiFlowPlaybookTrade.findOneAndUpdate(
    {
      symbol,
      dateKey,
      entryMinutes: bar.minutes,
      decision: match.decision,
    },
    {
      $set: {
        entryTime: bar.time,
        exitMinutes: null,
        exitTime: null,
        side: match.side,
        tone: match.side === 'CALL' ? 'call' : 'put',
        patternId: match.patternId,
        patternName: match.patternName,
        shortName: match.shortName,
        strength: bar.strength?.label || null,
        spotDelta: round(bar.spotDelta),
        act: bar.act,
        entrySpot: lv.entry,
        exitSpot: null,
        markSpot: lv.entry,
        candleHigh: round(bar.high, 1),
        candleLow: round(bar.low, 1),
        candleRange: bar.range,
        rawRisk: lv.rawRisk,
        riskPts: lv.risk,
        rewardPts: lv.reward,
        stopSpot: lv.stopSpot,
        targetSpot: lv.targetSpot,
        clamped: lv.clamped,
        favorPts: 0,
        mae: 0,
        mfe: 0,
        holdMin: 0,
        tpLeft: lv.reward,
        slLeft: lv.risk,
        status: 'OPEN',
        exitReason: 'OPEN',
        dayPtsAfter: null,
        dayStopReason: null,
        source: 'live',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return doc;
}

/**
 * Mark open trade vs latest spot; close on TP/SL/TIME.
 */
async function monitorOpenPlaybookTrade({ symbol = 'NIFTY', dateKey, spot, minutes, time } = {}) {
  const open = await OiFlowPlaybookTrade.findOne({
    symbol,
    dateKey,
    status: 'OPEN',
  });
  if (!open) return null;

  const mark = markOpenTrade(open.toObject(), spot, minutes);
  open.markSpot = mark.markSpot;
  open.favorPts = mark.favorPts;
  open.holdMin = mark.holdMin;
  open.tpLeft = mark.tpLeft;
  open.slLeft = mark.slLeft;

  if (mark.status === 'CLOSED') {
    open.status = 'CLOSED';
    open.exitReason = mark.exitReason || 'TIME';
    open.exitSpot = mark.markSpot;
    open.exitMinutes = Number.isFinite(Number(minutes)) ? Number(minutes) : open.entryMinutes;
    open.exitTime = time || open.exitTime;
    open.tpLeft = 0;
    open.slLeft = 0;
    const prior = await dayNetSoFar(dateKey, symbol);
    open.dayPtsAfter = round(prior + (Number(open.favorPts) || 0));
    if (open.dayPtsAfter >= DAILY_TARGET) {
      open.dayStopReason = `Daily target +${DAILY_TARGET}`;
    } else if (open.dayPtsAfter <= -DAILY_LOSS) {
      open.dayStopReason = `Daily loss −${DAILY_LOSS}`;
    }
  }

  await open.save();
  return open.toObject();
}

/**
 * Ensure today has a book: backfill if empty (market closed / morning catch-up).
 * Then monitor open + try new entry on latest closed 15m.
 */
async function ensurePlaybookBook(dateKey, opts = {}) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const count = await OiFlowPlaybookTrade.countDocuments({ symbol, dateKey: key });

  if (count === 0 || opts.force) {
    return backfillPlaybookTrades(key, { symbol });
  }

  const clock = getIstClock(new Date());
  const lastRow = await OiFlowMinuteRow.findOne({ symbol, dateKey: key, fetchOk: true })
    .sort({ minutes: -1 })
    .lean();
  const spot = Number(opts.spot ?? lastRow?.spotPrice);
  const minutes = Number(opts.minutes ?? lastRow?.minutes ?? clock.minutes);
  const time = opts.time || lastRow?.time || null;

  if (Number.isFinite(spot)) {
    await monitorOpenPlaybookTrade({
      symbol,
      dateKey: key,
      spot,
      minutes,
      time,
    });
  }

  // Only open new live entries while session is active.
  if (opts.allowLiveEntry && Number.isFinite(minutes)) {
    // Find latest closed 15m grid minute ≤ now
    const grid = minutes - ((minutes - (9 * 60 + 15)) % STEP);
    if (grid >= 9 * 60 + 15) {
      await detectLivePlaybookEntry({ symbol, dateKey: key, minutes: grid });
      if (Number.isFinite(spot)) {
        await monitorOpenPlaybookTrade({
          symbol,
          dateKey: key,
          spot,
          minutes,
          time,
        });
      }
    }
  }

  return listPlaybookTrades(key, { symbol });
}

async function listPlaybookTrades(dateKey, opts = {}) {
  const key = String(dateKey || getIstClock(new Date()).dateKey);
  const symbol = opts.symbol || 'NIFTY';
  const rows = await OiFlowPlaybookTrade.find({ symbol, dateKey: key })
    .sort({ entryMinutes: 1 })
    .lean();
  const trades = rows.map(toClient);
  const open = trades.find((t) => t.status === 'OPEN') || null;
  const lock = await dayIsLocked(key, symbol);
  return {
    ok: true,
    dateKey: key,
    rules: {
      stepMin: STEP,
      maxHoldMin: MAX_HOLD,
      dailyTarget: DAILY_TARGET,
      dailyLoss: DAILY_LOSS,
      riskMin: 6,
      riskMax: 12,
      tpCap: 15,
      rMult: 1.5,
    },
    dayPts: lock.net,
    dayLocked: lock.locked,
    dayStopReason: lock.reason,
    summary: summarize(trades),
    open,
    trades,
  };
}

module.exports = {
  backfillPlaybookTrades,
  ensurePlaybookBook,
  listPlaybookTrades,
  detectLivePlaybookEntry,
  monitorOpenPlaybookTrade,
  DAILY_TARGET,
  DAILY_LOSS,
};

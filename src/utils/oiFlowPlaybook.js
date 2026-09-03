/**
 * 15m E/B playbook — shared risk + book simulation.
 * PUT = Strong Bear + Spot↓ + Match
 * CALL = Strong Bull + Spot↑≥5 + Match
 * SL = candle H/L ±2, risk clamp 6..12
 * TP = 1.5R cap +15 · hold 30m · day +15/−16 · 1 open
 */
const {
  build5mBars,
  matchLivePattern,
  LIVE_STEP,
} = require('./oiFlow5mPatterns');

const STEP = LIVE_STEP;
const BUF = 2;
const RISK_MIN = 6;
const RISK_MAX = 12;
const R_MULT = 1.5;
const TP_CAP = 15;
const MAX_HOLD = 30;
const DAILY_TARGET = 15;
const DAILY_LOSS = 16;

function round(n, d = 1) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function attachCandleRange(bars, rawByMin) {
  for (let i = 0; i < bars.length; i += 1) {
    const cur = bars[i];
    const prevMin = i > 0 ? bars[i - 1].minutes : cur.minutes - STEP;
    const spots = [];
    for (let m = prevMin + 1; m <= cur.minutes; m += 1) {
      const s = Number(rawByMin.get(m)?.spotPrice ?? rawByMin.get(m)?.spot);
      if (Number.isFinite(s)) spots.push(s);
    }
    if (!spots.length && Number.isFinite(Number(cur.spot))) spots.push(Number(cur.spot));
    cur.high = Math.max(...spots);
    cur.low = Math.min(...spots);
    cur.range = round(cur.high - cur.low);
  }
  return bars;
}

function riskLevels(bar, side) {
  const entry = Number(bar.spot);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const rawRisk =
    side === 'CALL' ? entry - (low - BUF) : high + BUF - entry;
  const risk = Math.min(RISK_MAX, Math.max(RISK_MIN, rawRisk));
  const reward = Math.min(TP_CAP, risk * R_MULT);
  const stopSpot = side === 'CALL' ? entry - risk : entry + risk;
  const targetSpot = side === 'CALL' ? entry + reward : entry - reward;
  return {
    entry: round(entry, 1),
    rawRisk: round(rawRisk),
    risk: round(risk),
    reward: round(reward),
    stopSpot: round(stopSpot, 1),
    targetSpot: round(targetSpot, 1),
    clamped: rawRisk > RISK_MAX || rawRisk < RISK_MIN,
  };
}

function ptsFromSpot(side, entry, spot) {
  const raw = Number(spot) - Number(entry);
  if (!Number.isFinite(raw)) return null;
  return side === 'CALL' ? raw : -raw;
}

/**
 * Walk 1m path after entry until TP/SL/TIME.
 */
function walkExit(rawChrono, entryMinutes, entry, side, stop, target, maxHold = MAX_HOLD) {
  let mae = 0;
  let mfe = 0;
  let last = {
    favorPts: 0,
    exitReason: 'TIME',
    exitTime: null,
    exitMinutes: null,
    exitSpot: entry,
    holdMin: 0,
  };

  for (const row of rawChrono) {
    const m = Number(row.minutes);
    if (m <= entryMinutes) continue;
    const held = m - entryMinutes;
    if (held > maxHold) break;
    const spot = Number(row.spotPrice ?? row.spot);
    if (!Number.isFinite(spot)) continue;

    const pts = ptsFromSpot(side, entry, spot);
    mae = Math.min(mae, pts);
    mfe = Math.max(mfe, pts);
    last = {
      favorPts: pts,
      exitReason: 'TIME',
      exitTime: row.time,
      exitMinutes: m,
      exitSpot: spot,
      holdMin: held,
      mae,
      mfe,
    };

    if (side === 'CALL') {
      if (spot <= stop) {
        return {
          favorPts: -(entry - stop),
          exitReason: 'SL',
          exitTime: row.time,
          exitMinutes: m,
          exitSpot: spot,
          holdMin: held,
          mae: round(mae),
          mfe: round(mfe),
        };
      }
      if (spot >= target) {
        return {
          favorPts: target - entry,
          exitReason: 'TP',
          exitTime: row.time,
          exitMinutes: m,
          exitSpot: spot,
          holdMin: held,
          mae: round(mae),
          mfe: round(mfe),
        };
      }
    } else if (spot >= stop) {
      return {
        favorPts: -(stop - entry),
        exitReason: 'SL',
        exitTime: row.time,
        exitMinutes: m,
        exitSpot: spot,
        holdMin: held,
        mae: round(mae),
        mfe: round(mfe),
      };
    } else if (spot <= target) {
      return {
        favorPts: entry - target,
        exitReason: 'TP',
        exitTime: row.time,
        exitMinutes: m,
        exitSpot: spot,
        holdMin: held,
        mae: round(mae),
        mfe: round(mfe),
      };
    }
  }

  return {
    ...last,
    favorPts: round(last.favorPts),
    mae: round(mae),
    mfe: round(mfe),
    exitSpot: round(last.exitSpot, 1),
  };
}

/**
 * Simulate full-day book from minute rows (for backfill).
 */
function simulatePlaybookDay(rawRows, opts = {}) {
  const dailyTarget = Number(opts.dailyTarget) || DAILY_TARGET;
  const dailyLoss = Number(opts.dailyLoss) || DAILY_LOSS;
  const raw = (Array.isArray(rawRows) ? rawRows : [])
    .filter((r) => r && r.fetchOk !== false)
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));
  const rawByMin = new Map(raw.map((r) => [Number(r.minutes), r]));
  let bars = build5mBars(raw, STEP);
  bars = attachCandleRange(bars, rawByMin);

  const trades = [];
  let dayPts = 0;
  let dayStopReason = null;
  let i = 0;

  while (i < bars.length) {
    if (dayStopReason) break;
    const bar = bars[i];
    const match = matchLivePattern(bar);
    if (!match) {
      i += 1;
      continue;
    }

    const side = match.side;
    const lv = riskLevels(bar, side);
    const ex = walkExit(
      raw,
      bar.minutes,
      Number(bar.spot),
      side,
      lv.stopSpot,
      lv.targetSpot,
      MAX_HOLD,
    );
    if (!ex?.exitTime) {
      i += 1;
      continue;
    }

    let pts = Number(ex.favorPts);
    if (ex.exitReason === 'SL') pts = -lv.risk;
    if (ex.exitReason === 'TP') pts = lv.reward;
    pts = round(pts);

    const trade = {
      entryTime: bar.time,
      entryMinutes: bar.minutes,
      exitTime: ex.exitTime,
      exitMinutes: ex.exitMinutes,
      side,
      decision: match.decision,
      patternId: match.patternId,
      patternName: match.patternName || match.shortName,
      shortName: match.shortName,
      strength: bar.strength?.label || null,
      spotDelta: round(bar.spotDelta),
      act: bar.act,
      entrySpot: lv.entry,
      exitSpot: Number.isFinite(Number(ex.exitSpot)) ? round(Number(ex.exitSpot), 1) : null,
      candleHigh: round(bar.high, 1),
      candleLow: round(bar.low, 1),
      candleRange: bar.range,
      rawRisk: lv.rawRisk,
      riskPts: lv.risk,
      rewardPts: lv.reward,
      stopSpot: lv.stopSpot,
      targetSpot: lv.targetSpot,
      clamped: lv.clamped,
      favorPts: pts,
      exitReason: ex.exitReason,
      holdMin: ex.holdMin,
      mae: round(ex.mae),
      mfe: round(ex.mfe),
      status: 'CLOSED',
      dayPtsAfter: null,
    };

    dayPts = round(dayPts + pts);
    trade.dayPtsAfter = dayPts;
    trades.push(trade);

    if (dayPts >= dailyTarget) {
      dayStopReason = `Daily target +${dailyTarget}`;
      trade.dayStopReason = dayStopReason;
    } else if (dayPts <= -Math.abs(dailyLoss)) {
      dayStopReason = `Daily loss −${dailyLoss}`;
      trade.dayStopReason = dayStopReason;
    }

    const exitMin = Number(ex.exitMinutes);
    if (!Number.isFinite(exitMin)) {
      i += 1;
      continue;
    }
    i = bars.findIndex((b) => b.minutes > exitMin);
    if (i < 0) break;
  }

  return {
    bars: bars.length,
    trades,
    dayPts: round(dayPts),
    dayStopReason,
    rules: {
      stepMin: STEP,
      riskMin: RISK_MIN,
      riskMax: RISK_MAX,
      buffer: BUF,
      rMult: R_MULT,
      tpCap: TP_CAP,
      maxHoldMin: MAX_HOLD,
      dailyTarget,
      dailyLoss,
    },
  };
}

/**
 * Live mark for an OPEN trade given latest spot.
 */
function markOpenTrade(trade, spotNow, nowMinutes) {
  const entry = Number(trade.entrySpot);
  const side = trade.side === 'CALL' || trade.decision === 'CALL BUY' ? 'CALL' : 'PUT';
  const pts = ptsFromSpot(side, entry, spotNow);
  const risk = Number(trade.riskPts);
  const reward = Number(trade.rewardPts);
  const stop = Number(trade.stopSpot);
  const target = Number(trade.targetSpot);
  const holdMin =
    Number.isFinite(nowMinutes) && Number.isFinite(Number(trade.entryMinutes))
      ? Math.max(0, nowMinutes - Number(trade.entryMinutes))
      : Number(trade.holdMin) || 0;

  let exitReason = null;
  let favorPts = round(pts);
  let status = 'OPEN';

  if (Number.isFinite(pts)) {
    if (side === 'CALL') {
      if (Number.isFinite(stop) && Number(spotNow) <= stop) {
        exitReason = 'SL';
        favorPts = -Math.abs(risk);
        status = 'CLOSED';
      } else if (Number.isFinite(target) && Number(spotNow) >= target) {
        exitReason = 'TP';
        favorPts = Math.abs(reward);
        status = 'CLOSED';
      }
    } else if (Number.isFinite(stop) && Number(spotNow) >= stop) {
      exitReason = 'SL';
      favorPts = -Math.abs(risk);
      status = 'CLOSED';
    } else if (Number.isFinite(target) && Number(spotNow) <= target) {
      exitReason = 'TP';
      favorPts = Math.abs(reward);
      status = 'CLOSED';
    }
  }

  if (status === 'OPEN' && holdMin >= MAX_HOLD) {
    exitReason = 'TIME';
    favorPts = round(pts) ?? 0;
    status = 'CLOSED';
  }

  return {
    status,
    favorPts,
    exitReason,
    holdMin,
    markSpot: Number.isFinite(Number(spotNow)) ? round(Number(spotNow), 1) : null,
    tpLeft:
      status === 'OPEN' && Number.isFinite(reward) && Number.isFinite(favorPts)
        ? round(reward - favorPts)
        : 0,
    slLeft:
      status === 'OPEN' && Number.isFinite(risk) && Number.isFinite(favorPts)
        ? round(favorPts + risk)
        : 0,
  };
}

module.exports = {
  STEP,
  BUF,
  RISK_MIN,
  RISK_MAX,
  R_MULT,
  TP_CAP,
  MAX_HOLD,
  DAILY_TARGET,
  DAILY_LOSS,
  round,
  attachCandleRange,
  riskLevels,
  walkExit,
  simulatePlaybookDay,
  markOpenTrade,
  ptsFromSpot,
  matchLivePattern,
  build5mBars,
};

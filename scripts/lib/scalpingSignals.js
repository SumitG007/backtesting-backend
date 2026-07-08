/**
 * Scalping entry signals for research scripts (VWAP pullback, ORB, EMA cross, VWAP+EMA trend).
 */

const { getIstClock } = require('../../src/utils/dateTime');
const { calculateEma, calculateAtr } = require('../../src/strategies/shared/indicators');

function calculateDayVwap(dayBars) {
  const n = dayBars.length;
  const vwap = Array(n).fill(null);
  let cumPv = 0;
  let cumVol = 0;
  for (let i = 0; i < n; i += 1) {
    const h = Number(dayBars[i][2]);
    const l = Number(dayBars[i][3]);
    const c = Number(dayBars[i][4]);
    const v = Number(dayBars[i][5]);
    const vol = Number.isFinite(v) && v > 0 ? v : 1;
    const tp = (h + l + c) / 3;
    cumPv += tp * vol;
    cumVol += vol;
    vwap[i] = cumVol > 0 ? cumPv / cumVol : tp;
  }
  return vwap;
}

function prepDayContext(dayBars) {
  const closes = dayBars.map((c) => Number(c[4]));
  const vwap = calculateDayVwap(dayBars);
  const ema9 = calculateEma(closes, 9);
  const ema21 = calculateEma(closes, 21);
  const atr = calculateAtr(dayBars, 14);

  // Opening range = first 3 bars (09:15–09:30 on 5m)
  const orbBars = dayBars.slice(0, Math.min(3, dayBars.length));
  let orbHigh = -Infinity;
  let orbLow = Infinity;
  for (const b of orbBars) {
    orbHigh = Math.max(orbHigh, Number(b[2]));
    orbLow = Math.min(orbLow, Number(b[3]));
  }
  if (!Number.isFinite(orbHigh)) orbHigh = null;
  if (!Number.isFinite(orbLow)) orbLow = null;
  const orbHeight = orbHigh != null && orbLow != null ? orbHigh - orbLow : null;

  return { closes, vwap, ema9, ema21, atr, orbHigh, orbLow, orbHeight, orbReady: orbBars.length >= 3 };
}

function bullishCandle(bar) {
  return Number(bar[4]) > Number(bar[1]);
}

function bearishCandle(bar) {
  return Number(bar[4]) < Number(bar[1]);
}

/** VWAP pullback: bias from VWAP, enter on reclaim above 9 EMA after touch. */
function findVwapPullback(dayBars, j, ctx) {
  const { vwap, ema9 } = ctx;
  if (j < 3) return null;
  const c = Number(dayBars[j][4]);
  const o = Number(dayBars[j][1]);
  const lo = Number(dayBars[j][3]);
  const hi = Number(dayBars[j][2]);
  const prevLo = Number(dayBars[j - 1][3]);
  const prevHi = Number(dayBars[j - 1][2]);
  const prevC = Number(dayBars[j - 1][4]);
  if (![c, o, lo, hi, prevLo, prevHi, prevC].every(Number.isFinite)) return null;
  if (!Number.isFinite(vwap[j]) || !Number.isFinite(ema9[j])) return null;

  const touchedVwap = prevLo <= vwap[j - 1] * 1.0015 || prevHi >= vwap[j - 1] * 0.9985;

  // Long CE
  if (c > vwap[j] && c > ema9[j] && c > o && touchedVwap && prevC <= ema9[j - 1]) {
    return {
      optionType: 'CE',
      reason: 'VWAP_PULLBACK_CE',
      stopIndex: Math.min(lo, prevLo) - 2,
      targetIndex: c + 22,
    };
  }

  // Long PE
  if (c < vwap[j] && c < ema9[j] && c < o && touchedVwap && prevC >= ema9[j - 1]) {
    return {
      optionType: 'PE',
      reason: 'VWAP_PULLBACK_PE',
      stopIndex: Math.max(hi, prevHi) + 2,
      targetIndex: c - 22,
    };
  }
  return null;
}

/** Opening range breakout (first 15m range, trade break + hold). */
function findOrbBreakout(dayBars, j, ctx) {
  const { orbHigh, orbLow, orbHeight, orbReady } = ctx;
  if (!orbReady || orbHigh == null || orbLow == null) return null;
  if (j < 3) return null;

  const c = Number(dayBars[j][4]);
  const prevC = Number(dayBars[j - 1][4]);
  const lo = Number(dayBars[j][3]);
  const hi = Number(dayBars[j][2]);
  const o = Number(dayBars[j][1]);
  if (![c, prevC, lo, hi, o].every(Number.isFinite)) return null;

  const clock = getIstClock(dayBars[j][0]);
  if (clock.minutes > 690) return null; // ORB window until ~11:30 (needs room when warmup > 3)

  const minRange = 5;
  if (!Number.isFinite(orbHeight) || orbHeight < minRange) return null;

  // Breakout: close clears range with momentum (prev bar was inside range).
  if (c > orbHigh && prevC <= orbHigh && c >= o) {
    return {
      optionType: 'CE',
      reason: 'ORB_CE',
      stopIndex: orbLow - 2,
      targetIndex: c + Math.min(30, orbHeight * 1.2),
    };
  }

  if (c < orbLow && prevC >= orbLow && c <= o) {
    return {
      optionType: 'PE',
      reason: 'ORB_PE',
      stopIndex: orbHigh + 2,
      targetIndex: c - Math.min(30, orbHeight * 1.2),
    };
  }
  return null;
}

/** 9/21 EMA crossover with VWAP side filter. */
function findEmaCross(dayBars, j, ctx) {
  const { ema9, ema21, vwap } = ctx;
  if (j < 22) return null;

  const c = Number(dayBars[j][4]);
  const lo = Number(dayBars[j][3]);
  const hi = Number(dayBars[j][2]);
  const e9 = ema9[j];
  const e21 = ema21[j];
  const pe9 = ema9[j - 1];
  const pe21 = ema21[j - 1];
  if (![c, lo, hi, e9, e21, pe9, pe21].every(Number.isFinite)) return null;
  if (!Number.isFinite(vwap[j])) return null;

  const bullCross = pe9 <= pe21 && e9 > e21;
  const bearCross = pe9 >= pe21 && e9 < e21;

  if (bullCross && c > vwap[j]) {
    return {
      optionType: 'CE',
      reason: 'EMA_CROSS_CE',
      stopIndex: lo - 2,
      targetIndex: c + 22,
    };
  }

  if (bearCross && c < vwap[j]) {
    return {
      optionType: 'PE',
      reason: 'EMA_CROSS_PE',
      stopIndex: hi + 2,
      targetIndex: c - 22,
    };
  }
  return null;
}

/** Simple VWAP + EMA trend alignment (fewer but cleaner signals). */
function findVwapEmaTrend(dayBars, j, ctx) {
  const { vwap, ema9, ema21 } = ctx;
  if (j < 22) return null;

  const c = Number(dayBars[j][4]);
  const o = Number(dayBars[j][1]);
  const lo = Number(dayBars[j][3]);
  const hi = Number(dayBars[j][2]);
  const e9 = ema9[j];
  const e21 = ema21[j];
  if (![c, o, lo, hi, e9, e21].every(Number.isFinite)) return null;
  if (!Number.isFinite(vwap[j])) return null;

  if (c > vwap[j] && e9 > e21 && c > e9 && c > o) {
    return {
      optionType: 'CE',
      reason: 'VWAP_EMA_CE',
      stopIndex: lo - 2,
      targetIndex: c + 20,
    };
  }

  if (c < vwap[j] && e9 < e21 && c < e9 && c < o) {
    return {
      optionType: 'PE',
      reason: 'VWAP_EMA_PE',
      stopIndex: hi + 2,
      targetIndex: c - 20,
    };
  }
  return null;
}

const SIGNAL_FNS = {
  vwap_pullback: findVwapPullback,
  orb: findOrbBreakout,
  ema_cross: findEmaCross,
  vwap_ema_trend: findVwapEmaTrend,
};

function makeFindSignal(entryKey) {
  const fn = SIGNAL_FNS[entryKey];
  if (!fn) throw new Error(`Unknown entry: ${entryKey}`);
  return (dayBars, j, ctx) => {
    if (!ctx._prepped || ctx._barLen !== dayBars.length) {
      const prep = prepDayContext(dayBars);
      Object.assign(ctx, prep, { _prepped: true, _barLen: dayBars.length });
    }
    return fn(dayBars, j, ctx);
  };
}

module.exports = {
  makeFindSignal,
  prepDayContext,
  SIGNAL_FNS,
};

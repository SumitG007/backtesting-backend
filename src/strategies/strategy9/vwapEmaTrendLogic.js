/**
 * VWAP + 9/21 EMA trend alignment — long CE/PE scalper (T01).
 */

// NOTE: shared indicators use a strict SMA-seeded EMA which returns `null`
// until `period` bars are available. For a 09:30 one-shot entry we need an
// EMA that starts producing values immediately (no lookahead).

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
  return {
    closes,
    vwap: calculateDayVwap(dayBars),
    ema9: calculateEmaEarly(closes, 9),
    ema21: calculateEmaEarly(closes, 21),
  };
}

/**
 * EMA that starts from the first finite close (no SMA warmup).
 * This allows early entries (e.g. 09:30) even when the strict EMA would be null.
 */
function calculateEmaEarly(values, period) {
  const n = Array.isArray(values) ? values.length : 0;
  const out = new Array(n).fill(null);
  const p = Math.max(2, Number(period) || 14);
  const k = 2 / (p + 1);
  let started = false;
  let ema = null;

  for (let i = 0; i < n; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (!started) {
      ema = v;
      started = true;
      out[i] = ema;
      continue;
    }
    ema = v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function bigCandlePasses({ open, high, low, close, bigCandleMinBodyPct, bigCandleMinRangePct }) {
  const o = Number(open);
  const h = Number(high);
  const l = Number(low);
  const c = Number(close);
  if (![o, h, l, c].every(Number.isFinite)) return false;
  if (c === 0) return false;

  const body = Math.abs(c - o);
  const range = h - l;
  if (!Number.isFinite(body) || !Number.isFinite(range)) return false;

  const bodyPct = body / Math.abs(c);
  const rangePct = range / Math.abs(c);

  const minBody = Number.isFinite(bigCandleMinBodyPct) ? bigCandleMinBodyPct : 0;
  const minRange = Number.isFinite(bigCandleMinRangePct) ? bigCandleMinRangePct : 0;
  return bodyPct >= minBody && rangePct >= minRange;
}

/** Long CE when price > VWAP, EMA9 > EMA21, close > EMA9, bullish bar. */
function findVwapEmaTrend(dayBars, j, ctx) {
  const { vwap, ema9, ema21 } = ctx;

  const c = Number(dayBars[j][4]);
  const o = Number(dayBars[j][1]);
  const h = Number(dayBars[j][2]);
  const l = Number(dayBars[j][3]);
  const e9 = ema9[j];
  const e21 = ema21[j];
  if (![c, o, h, l, e9, e21].every(Number.isFinite)) return null;
  if (!Number.isFinite(vwap[j])) return null;

  const bigCandleMinBodyPct = ctx.settings?.bigCandleMinBodyPct;
  const bigCandleMinRangePct = ctx.settings?.bigCandleMinRangePct;
  const slBufferPoints = Number.isFinite(ctx.settings?.slBufferPoints) ? Number(ctx.settings.slBufferPoints) : 0;

  const bigOk = bigCandlePasses({
    open: o,
    high: h,
    low: l,
    close: c,
    bigCandleMinBodyPct: bigCandleMinBodyPct != null ? Number(bigCandleMinBodyPct) : 0,
    bigCandleMinRangePct: bigCandleMinRangePct != null ? Number(bigCandleMinRangePct) : 0,
  });

  if (c > vwap[j] && e9 > e21 && c > e9 && c > o) {
    if (!bigOk) return null;
    return {
      optionType: 'CE',
      reason: 'VWAP_EMA_CE',
      // Index-structure SL: stop slightly below the entry candle low.
      stopIndex: l - slBufferPoints,
    };
  }

  if (c < vwap[j] && e9 < e21 && c < e9 && c < o) {
    if (!bigOk) return null;
    return {
      optionType: 'PE',
      reason: 'VWAP_EMA_PE',
      // Index-structure SL: stop slightly above the entry candle high.
      stopIndex: h + slBufferPoints,
    };
  }
  return null;
}

function makeVwapEmaTrendFindSignal() {
  return (dayBars, j, ctx) => {
    if (!ctx._prepped || ctx._barLen !== dayBars.length) {
      const prep = prepDayContext(dayBars);
      Object.assign(ctx, prep, { _prepped: true, _barLen: dayBars.length });
    }
    return findVwapEmaTrend(dayBars, j, ctx);
  };
}

module.exports = {
  calculateDayVwap,
  prepDayContext,
  findVwapEmaTrend,
  makeVwapEmaTrendFindSignal,
};

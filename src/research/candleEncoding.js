/**
 * Discretize OHLC bars into compact symbols for sequence pattern mining.
 * Symbol = dir + size + closePos (e.g. "ULH" = up, large range, close near high).
 */

const DEFAULT_RANGE_THRESHOLDS = {
  NIFTY: { small: 18, large: 45 },
  BANKNIFTY: { small: 40, large: 100 },
};

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function barOhlc(bar) {
  return {
    o: Number(bar[1]),
    h: Number(bar[2]),
    l: Number(bar[3]),
    c: Number(bar[4]),
  };
}

function resolveRangeThresholds(symbol, rollingMedian) {
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const fixed = DEFAULT_RANGE_THRESHOLDS[sym] || DEFAULT_RANGE_THRESHOLDS.NIFTY;
  if (Number.isFinite(rollingMedian) && rollingMedian > 0) {
    return {
      small: rollingMedian * 0.65,
      large: rollingMedian * 1.35,
    };
  }
  return fixed;
}

/**
 * @param {number[]} bar - [ts, o, h, l, c, ...]
 * @param {{ small: number, large: number }} thresholds
 */
function encodeBar(bar, thresholds) {
  const { o, h, l, c } = barOhlc(bar);
  if (![o, h, l, c].every(Number.isFinite)) return null;

  const range = h - l;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      dir: 'F',
      size: 'S',
      closePos: 'M',
      symbol: 'FSM',
      range: 0,
      body: 0,
      o,
      h,
      l,
      c,
    };
  }

  const body = Math.abs(c - o);
  let dir = 'F';
  if (body / range >= 0.15) {
    dir = c > o ? 'U' : 'D';
  }

  let size = 'M';
  if (range <= thresholds.small) size = 'S';
  else if (range >= thresholds.large) size = 'L';

  const closePos = (c - l) / range;
  let closeBucket = 'M';
  if (closePos >= 0.67) closeBucket = 'H';
  else if (closePos <= 0.33) closeBucket = 'L';

  return {
    dir,
    size,
    closePos: closeBucket,
    symbol: `${dir}${size}${closeBucket}`,
    range,
    body,
    o,
    h,
    l,
    c,
  };
}

function encodeDayBars(bars, symbol) {
  const ranges = bars.map((b) => {
    const { h, l } = barOhlc(b);
    return h - l;
  });
  const rollingMedian = median(ranges.slice(0, Math.min(24, ranges.length)));
  const thresholds = resolveRangeThresholds(symbol, rollingMedian);

  return bars.map((bar) => encodeBar(bar, thresholds));
}

function sequenceKey(encodedBars, startIdx, length) {
  const parts = [];
  for (let i = 0; i < length; i += 1) {
    const enc = encodedBars[startIdx + i];
    if (!enc) return null;
    parts.push(enc.symbol);
  }
  return parts.join('>');
}

module.exports = {
  DEFAULT_RANGE_THRESHOLDS,
  median,
  barOhlc,
  encodeBar,
  encodeDayBars,
  sequenceKey,
};

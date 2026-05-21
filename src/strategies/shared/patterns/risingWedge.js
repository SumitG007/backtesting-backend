/**
 * Rising wedge family — regression rising channel + optional swing wedge; bearish breakdown.
 */

function findSwingHighs(bars, startIdx, endIdx, pivotBars) {
  const p = Math.max(1, pivotBars || 1);
  const points = [];
  for (let i = startIdx + p; i <= endIdx - p; i += 1) {
    const h = Number(bars[i][2]);
    if (!Number.isFinite(h)) continue;
    let ok = true;
    for (let k = 1; k <= p; k += 1) {
      if (Number(bars[i - k][2]) >= h || Number(bars[i + k][2]) >= h) {
        ok = false;
        break;
      }
    }
    if (ok) points.push({ idx: i, price: h });
  }
  return points;
}

function findSwingLows(bars, startIdx, endIdx, pivotBars) {
  const p = Math.max(1, pivotBars || 1);
  const points = [];
  for (let i = startIdx + p; i <= endIdx - p; i += 1) {
    const l = Number(bars[i][3]);
    if (!Number.isFinite(l)) continue;
    let ok = true;
    for (let k = 1; k <= p; k += 1) {
      if (Number(bars[i - k][3]) <= l || Number(bars[i + k][3]) <= l) {
        ok = false;
        break;
      }
    }
    if (ok) points.push({ idx: i, price: l });
  }
  return points;
}

function lineThroughPoints(p1, p2) {
  const dx = p2.idx - p1.idx;
  if (dx === 0) return null;
  const slope = (p2.price - p1.price) / dx;
  const intercept = p1.price - slope * p1.idx;
  return { slope, intercept };
}

function lineValueAt(line, idx) {
  return line.slope * idx + line.intercept;
}

function isRisingEndpoints(points) {
  if (points.length < 2) return false;
  return points[points.length - 1].price > points[0].price;
}

function isBearishCandle(bar) {
  const o = Number(bar[1]);
  const c = Number(bar[4]);
  return Number.isFinite(o) && Number.isFinite(c) && c < o;
}

/** Least-squares slope for y over x indices. */
function regressionLine(indices, values) {
  const n = indices.length;
  if (n < 3) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += indices[i];
    sumY += values[i];
    sumXY += indices[i] * values[i];
    sumXX += indices[i] * indices[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function buildPatternResult({ bars, breakdownIdx, upperLine, lowerLine, wedgeHigh, widthStart, opts, signalType }) {
  const cl = Number(bars[breakdownIdx][4]);
  const measuredMove =
    widthStart * (Number(opts.measuredMoveMultiplier) || 0.75);
  const atrProxy = widthStart * 0.5;
  const move = Math.max(measuredMove, atrProxy);

  return {
    signalType,
    upperLine,
    lowerLine,
    wedgeHigh,
    supportAtBreak: lineValueAt(lowerLine, breakdownIdx),
    measuredMove: move,
    narrowPct: widthStart > 0 ? Number((((widthStart - (lineValueAt(upperLine, breakdownIdx - 1) - lineValueAt(lowerLine, breakdownIdx - 1))) / widthStart) * 100).toFixed(2)) : 0,
    stopIndex: wedgeHigh + (Number(opts.stopBufferPoints) || 6),
    targetIndex: cl - move,
  };
}

/**
 * Primary detector — rising channel via regression (more intraday signals).
 */
function detectRisingChannelBreakdown(bars, breakdownIdx, opts = {}) {
  const lookback = Math.max(6, Number(opts.wedgeLookback) || 8);
  const startIdx = breakdownIdx - lookback;
  if (startIdx < 0 || breakdownIdx >= bars.length) return null;

  const indices = [];
  const highs = [];
  const lows = [];
  for (let i = startIdx; i < breakdownIdx; i += 1) {
    const h = Number(bars[i][2]);
    const l = Number(bars[i][3]);
    if (![h, l].every(Number.isFinite)) return null;
    indices.push(i);
    highs.push(h);
    lows.push(l);
  }

  const upperLine = regressionLine(indices, highs);
  const lowerLine = regressionLine(indices, lows);
  if (!upperLine || !lowerLine) return null;

  const minSlope = Number(opts.minRisingSlopePerBar) || 0.15;
  if (upperLine.slope < minSlope || lowerLine.slope < minSlope) return null;

  const maxRatio = Number(opts.maxLowerToUpperSlopeRatio) || 1.02;
  if (lowerLine.slope >= upperLine.slope * maxRatio) return null;

  const widthStart = lineValueAt(upperLine, startIdx) - lineValueAt(lowerLine, startIdx);
  const widthEnd = lineValueAt(upperLine, breakdownIdx - 1) - lineValueAt(lowerLine, breakdownIdx - 1);
  if (widthStart <= 0 || widthEnd <= 0) return null;

  const minNarrowPct = Number(opts.minNarrowingPct) || 0;
  if (minNarrowPct > 0) {
    const narrowPct = ((widthStart - widthEnd) / widthStart) * 100;
    if (narrowPct < minNarrowPct) return null;
  } else if (widthEnd >= widthStart) {
    return null;
  }

  const breakdownBuffer = Math.max(0, Number(opts.breakdownBufferPoints) || 0);
  const supportAtBreak = lineValueAt(lowerLine, breakdownIdx);
  const cl = Number(bars[breakdownIdx][4]);
  const lo = Number(bars[breakdownIdx][3]);
  if (![cl, lo, supportAtBreak].every(Number.isFinite)) return null;

  const breakLevel = supportAtBreak - breakdownBuffer;
  if (lo > breakLevel && cl > breakLevel) return null;

  if (opts.requireBearishBreakdownCandle === true && !isBearishCandle(bars[breakdownIdx])) return null;

  const wedgeHigh = Math.max(...highs, lo, cl);
  return buildPatternResult({
    bars,
    breakdownIdx,
    upperLine,
    lowerLine,
    wedgeHigh,
    widthStart,
    opts,
    signalType: 'RISING_CHANNEL',
  });
}

/**
 * Swing-based wedge (stricter, used when signalMode includes wedge).
 */
function detectSwingWedgeBreakdown(bars, breakdownIdx, opts = {}) {
  const lookback = Math.max(6, Number(opts.wedgeLookback) || 8);
  const pivotBars = Math.max(1, Number(opts.pivotBars) || 1);
  const minSwings = Math.max(2, Number(opts.minSwingPoints) || 2);
  const startIdx = breakdownIdx - lookback;
  if (startIdx < 0 || breakdownIdx >= bars.length) return null;

  let swingHighs = findSwingHighs(bars, startIdx, breakdownIdx - 1, pivotBars);
  let swingLows = findSwingLows(bars, startIdx, breakdownIdx - 1, pivotBars);

  if (swingHighs.length < minSwings) {
    swingHighs = [
      { idx: startIdx, price: Number(bars[startIdx][2]) },
      { idx: breakdownIdx - 1, price: Number(bars[breakdownIdx - 1][2]) },
    ];
  }
  if (swingLows.length < minSwings) {
    swingLows = [
      { idx: startIdx, price: Number(bars[startIdx][3]) },
      { idx: breakdownIdx - 1, price: Number(bars[breakdownIdx - 1][3]) },
    ];
  }

  const highs = swingHighs.slice(-minSwings);
  const lows = swingLows.slice(-minSwings);
  if (!isRisingEndpoints(highs) || !isRisingEndpoints(lows)) return null;

  const upperLine = lineThroughPoints(highs[0], highs[highs.length - 1]);
  const lowerLine = lineThroughPoints(lows[0], lows[lows.length - 1]);
  if (!upperLine || !lowerLine) return null;

  if (upperLine.slope <= 0 || lowerLine.slope <= 0) return null;
  const maxRatio = Number(opts.maxLowerToUpperSlopeRatio) || 1.02;
  if (lowerLine.slope >= upperLine.slope * maxRatio) return null;

  const widthStart = lineValueAt(upperLine, highs[0].idx) - lineValueAt(lowerLine, lows[0].idx);
  const widthEnd =
    lineValueAt(upperLine, breakdownIdx - 1) - lineValueAt(lowerLine, breakdownIdx - 1);
  if (widthStart <= 0 || widthEnd <= 0 || widthEnd >= widthStart) return null;

  const minNarrowPct = Number(opts.minNarrowingPct) || 0;
  if (minNarrowPct > 0) {
    const narrowPct = ((widthStart - widthEnd) / widthStart) * 100;
    if (narrowPct < minNarrowPct) return null;
  }

  const breakdownBuffer = Math.max(0, Number(opts.breakdownBufferPoints) || 0);
  const supportAtBreak = lineValueAt(lowerLine, breakdownIdx);
  const cl = Number(bars[breakdownIdx][4]);
  const lo = Number(bars[breakdownIdx][3]);
  if (![cl, lo, supportAtBreak].every(Number.isFinite)) return null;
  const breakLevel = supportAtBreak - breakdownBuffer;
  if (lo > breakLevel && cl > breakLevel) return null;
  if (opts.requireBearishBreakdownCandle === true && !isBearishCandle(bars[breakdownIdx])) return null;

  const wedgeHigh = Math.max(...highs.map((p) => p.price), lo, cl);
  return buildPatternResult({
    bars,
    breakdownIdx,
    upperLine,
    lowerLine,
    wedgeHigh,
    widthStart,
    opts,
    signalType: 'SWING_WEDGE',
  });
}

/**
 * Rise-then-break micro setup — close drifts up, then breaks recent support (high frequency).
 */
function detectMicroRisingBreakdown(bars, breakdownIdx, opts = {}) {
  const lookback = Math.max(5, Number(opts.wedgeLookback) || 6);
  const breakLookback = Math.max(3, Number(opts.breakLookbackBars) || 4);
  const startIdx = breakdownIdx - lookback;
  if (startIdx < 0 || breakdownIdx < breakLookback) return null;

  const startClose = Number(bars[startIdx][4]);
  const driftClose = Number(bars[breakdownIdx - 2][4]);
  const cl = Number(bars[breakdownIdx][4]);
  const lo = Number(bars[breakdownIdx][3]);
  if (![startClose, driftClose, cl, lo].every(Number.isFinite)) return null;

  const minRise = Number(opts.minRisePoints) || 8;
  if (driftClose < startClose + minRise) return null;

  let supportLow = Infinity;
  for (let i = breakdownIdx - breakLookback; i < breakdownIdx; i += 1) {
    supportLow = Math.min(supportLow, Number(bars[i][3]));
  }
  if (!Number.isFinite(supportLow)) return null;

  const buffer = Math.max(0, Number(opts.breakdownBufferPoints) || 0);
  if (lo > supportLow - buffer && cl > supportLow - buffer) return null;

  const prevCl = Number(bars[breakdownIdx - 1][4]);
  if (Number.isFinite(prevCl) && prevCl < supportLow - buffer) return null;

  if (opts.requireBearishBreakdownCandle === true && !isBearishCandle(bars[breakdownIdx])) return null;

  const wedgeHigh = Math.max(
    ...Array.from({ length: lookback }, (_, k) => Number(bars[startIdx + k][2])).filter(Number.isFinite)
  );
  const widthStart = wedgeHigh - supportLow;
  const lowerLine = { slope: 0, intercept: supportLow };
  const upperLine = { slope: 0, intercept: wedgeHigh };

  return buildPatternResult({
    bars,
    breakdownIdx,
    upperLine,
    lowerLine,
    wedgeHigh: Math.max(wedgeHigh, lo, cl),
    widthStart: Math.max(widthStart, minRise),
    opts,
    signalType: 'MICRO_RISING_BREAK',
  });
}

/**
 * @param {unknown[]} bars
 * @param {number} breakdownIdx
 * @param {Record<string, unknown>} opts
 */
function detectRisingWedgeBreakdown(bars, breakdownIdx, opts = {}) {
  const mode = String(opts.signalMode || 'channel').toLowerCase();
  if (mode === 'wedge') return detectSwingWedgeBreakdown(bars, breakdownIdx, opts);
  if (mode === 'both') {
    return (
      detectRisingChannelBreakdown(bars, breakdownIdx, opts) ||
      detectSwingWedgeBreakdown(bars, breakdownIdx, opts) ||
      detectMicroRisingBreakdown(bars, breakdownIdx, opts)
    );
  }
  if (mode === 'aggressive') {
    return (
      detectMicroRisingBreakdown(bars, breakdownIdx, opts) ||
      detectRisingChannelBreakdown(bars, breakdownIdx, opts)
    );
  }
  if (mode === 'balanced') {
    const microOpts = {
      ...opts,
      minRisePoints: Math.max(Number(opts.minRisePoints) || 18, 18),
    };
    return (
      detectRisingChannelBreakdown(bars, breakdownIdx, opts) ||
      detectMicroRisingBreakdown(bars, breakdownIdx, microOpts)
    );
  }
  return (
    detectRisingChannelBreakdown(bars, breakdownIdx, opts) ||
    detectMicroRisingBreakdown(bars, breakdownIdx, opts)
  );
}

module.exports = {
  detectRisingWedgeBreakdown,
  detectRisingChannelBreakdown,
  detectSwingWedgeBreakdown,
  detectMicroRisingBreakdown,
  findSwingHighs,
  findSwingLows,
};

/**
 * Shared intraday indicators for strategy backtests.
 */

function calculateAtr(bars, period) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const p = Math.max(2, period || 14);
  const out = Array(n).fill(null);
  if (n < p) return out;

  const tr = [];
  for (let i = 0; i < n; i += 1) {
    const h = Number(bars[i][2]);
    const l = Number(bars[i][3]);
    const c = Number(bars[i][4]);
    const pc = i > 0 ? Number(bars[i - 1][4]) : c;
    if (![h, l, c].every(Number.isFinite)) {
      tr.push(null);
      continue;
    }
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  let sum = 0;
  let count = 0;
  for (let i = 0; i < p; i += 1) {
    if (Number.isFinite(tr[i])) {
      sum += tr[i];
      count += 1;
    }
  }
  if (count < p) return out;
  out[p - 1] = sum / p;

  for (let i = p; i < n; i += 1) {
    if (!Number.isFinite(tr[i]) || !Number.isFinite(out[i - 1])) continue;
    out[i] = (out[i - 1] * (p - 1) + tr[i]) / p;
  }
  return out;
}

function rollingVolumeAvg(bars, endIdx, lookback) {
  const lb = Math.max(3, lookback || 20);
  const start = Math.max(0, endIdx - lb + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= endIdx; i += 1) {
    const v = Number(bars[i][5]);
    const vol = Number.isFinite(v) && v > 0 ? v : 1;
    sum += vol;
    n += 1;
  }
  return n > 0 ? sum / n : 1;
}

function calculateRsi(bars, period) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const p = Math.max(2, period || 14);
  const out = Array(n).fill(null);
  if (n < p + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= p; i += 1) {
    const c = Number(bars[i][4]);
    const pc = Number(bars[i - 1][4]);
    if (![c, pc].every(Number.isFinite)) return out;
    const ch = c - pc;
    if (ch >= 0) avgGain += ch;
    else avgLoss += Math.abs(ch);
  }
  avgGain /= p;
  avgLoss /= p;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  out[p] = 100 - 100 / (1 + rs0);

  for (let i = p + 1; i < n; i += 1) {
    const c = Number(bars[i][4]);
    const pc = Number(bars[i - 1][4]);
    if (![c, pc].every(Number.isFinite)) continue;
    const ch = c - pc;
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? Math.abs(ch) : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function calculateEma(values, period) {
  const result = new Array(values.length).fill(null);
  const p = Math.max(2, period || 14);
  if (values.length < p) return result;
  const k = 2 / (p + 1);
  let seed = 0;
  for (let i = 0; i < p; i += 1) seed += values[i];
  let prev = seed / p;
  result[p - 1] = prev;
  for (let i = p; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

function calculateSma(values, period) {
  const n = values.length;
  const p = Math.max(1, period || 20);
  const out = new Array(n).fill(null);
  for (let i = p - 1; i < n; i += 1) {
    let sum = 0;
    let c = 0;
    for (let j = i - p + 1; j <= i; j += 1) {
      if (!Number.isFinite(values[j])) continue;
      sum += values[j];
      c += 1;
    }
    if (c === p) out[i] = sum / p;
  }
  return out;
}

function calculateBollinger(bars, period, stdMult) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const p = Math.max(5, period || 20);
  const mult = Number(stdMult) || 2;
  const closes = bars.map((c) => Number(c[4]));
  const mid = calculateSma(closes, p);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = p - 1; i < n; i += 1) {
    if (!Number.isFinite(mid[i])) continue;
    let sumSq = 0;
    for (let j = i - p + 1; j <= i; j += 1) sumSq += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sumSq / p);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function calculateStochastic(bars, kPeriod, dPeriod) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const kp = Math.max(3, kPeriod || 14);
  const dp = Math.max(2, dPeriod || 3);
  const k = new Array(n).fill(null);
  for (let i = kp - 1; i < n; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kp + 1; j <= i; j += 1) {
      hh = Math.max(hh, Number(bars[j][2]));
      ll = Math.min(ll, Number(bars[j][3]));
    }
    const cl = Number(bars[i][4]);
    if (![hh, ll, cl].every(Number.isFinite) || hh === ll) continue;
    k[i] = ((cl - ll) / (hh - ll)) * 100;
  }
  const d = calculateSma(k.map((v) => (Number.isFinite(v) ? v : 0)), dp);
  return { k, d };
}

function calculateDmi(highs, lows, closes, length = 14, smoothing = 10) {
  const n = highs.length;
  const tr = new Array(n).fill(0);
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(highLow, highClose, lowClose);
  }
  const diplus = new Array(n).fill(null);
  const diminus = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  let atr = 0;
  let pdm = 0;
  let mdm = 0;
  for (let i = 1; i <= length; i += 1) {
    atr += tr[i] || 0;
    pdm += plusDm[i] || 0;
    mdm += minusDm[i] || 0;
  }
  for (let i = length; i < n; i += 1) {
    if (i > length) {
      atr = atr - atr / length + (tr[i] || 0);
      pdm = pdm - pdm / length + (plusDm[i] || 0);
      mdm = mdm - mdm / length + (minusDm[i] || 0);
    }
    const plus = atr > 0 ? (100 * pdm) / atr : 0;
    const minus = atr > 0 ? (100 * mdm) / atr : 0;
    diplus[i] = plus;
    diminus[i] = minus;
    const sum = plus + minus;
    dx[i] = sum > 0 ? (100 * Math.abs(plus - minus)) / sum : 0;
  }
  const adx = new Array(n).fill(null);
  const start = length * 2 - 1;
  let seed = 0;
  let count = 0;
  for (let i = length; i <= Math.min(start, n - 1); i += 1) {
    if (Number.isFinite(dx[i])) {
      seed += dx[i];
      count += 1;
    }
  }
  if (count > 0 && start < n) adx[start] = seed / count;
  for (let i = start + 1; i < n; i += 1) {
    const prev = adx[i - 1];
    adx[i] = Number.isFinite(prev) ? (prev * (smoothing - 1) + (dx[i] || 0)) / smoothing : dx[i];
  }
  return { diplus, diminus, adx };
}

function calculateMacd(closes, fast, slow, signal) {
  const emaFast = calculateEma(closes, fast);
  const emaSlow = calculateEma(closes, slow);
  const macdLine = closes.map((_, i) =>
    Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i]) ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = calculateEma(
    macdLine.map((v) => (Number.isFinite(v) ? v : 0)),
    signal
  );
  return { macdLine, signalLine };
}

module.exports = {
  calculateAtr,
  rollingVolumeAvg,
  calculateRsi,
  calculateEma,
  calculateSma,
  calculateBollinger,
  calculateStochastic,
  calculateDmi,
  calculateMacd,
};

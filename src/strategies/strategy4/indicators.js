/**
 * Indicators for Strategy 4 — PHANTOM STRIKE (EMA, VWAP, RSI, ATR).
 */

function calculateEma(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let prev = seed / period;
  result[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

function calculateVwap(highs, lows, closes, volumes) {
  const n = closes.length;
  const vwap = new Array(n).fill(null);
  let cumulativePv = 0;
  let cumulativeVolume = 0;
  for (let i = 0; i < n; i += 1) {
    const high = Number(highs[i]);
    const low = Number(lows[i]);
    const close = Number(closes[i]);
    const typicalPrice = (high + low + close) / 3;
    const volume = Math.max(0, Number(volumes[i] ?? 0));
    cumulativePv += typicalPrice * volume;
    cumulativeVolume += volume;
    if (cumulativeVolume > 0) {
      vwap[i] = cumulativePv / cumulativeVolume;
    } else {
      const prev = i > 0 && Number.isFinite(vwap[i - 1]) ? vwap[i - 1] : typicalPrice;
      vwap[i] = (prev * i + typicalPrice) / (i + 1);
    }
  }
  return vwap;
}

function calculateRsi(values, period = 14) {
  const result = new Array(values.length).fill(null);
  if (values.length <= period) return result;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs);
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rsiRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rsiRs);
  }
  return result;
}

function calculateAtr(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const highLow = highs[i] - lows[i];
    const highClose = Math.abs(highs[i] - closes[i - 1]);
    const lowClose = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(highLow, highClose, lowClose);
  }
  const atr = new Array(n).fill(null);
  if (n <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i] || 0;
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) {
    atr[i] = ((atr[i - 1] * (period - 1)) + (tr[i] || 0)) / period;
  }
  return atr;
}

module.exports = {
  calculateEma,
  calculateVwap,
  calculateRsi,
  calculateAtr,
};

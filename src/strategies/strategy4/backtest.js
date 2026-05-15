/**
 * Strategy 4 — PHANTOM STRIKE (multi-timeframe intraday, backtest only).
 * 15m EMA trend · 5m VWAP + RSI · 1m trigger + volume · ATR stop/target · flat by 3:15 PM.
 */

const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');
const { getLotSize } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const { calculateEma, calculateVwap, calculateRsi, calculateAtr } = require('./indicators');

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  }
  return m;
}

function flattenSorted(byDay) {
  const keys = Array.from(byDay.keys()).sort();
  const out = [];
  for (const dk of keys) {
    for (const bar of byDay.get(dk) || []) out.push(bar);
  }
  return out;
}

/** For each IST minute 555–930, the last fully closed higher-TF bar (O(bars) per day, not per 1m tick). */
function buildClosedBarByMinute(dayBars, tfMinutes) {
  const items = dayBars
    .map((bar) => ({ bar, start: getIstClock(bar[0]).minutes }))
    .sort((a, b) => a.start - b.start);
  const byMinute = new Array(931);
  let j = 0;
  let current = null;
  for (let m = 555; m <= 930; m += 1) {
    while (j < items.length && items[j].start + tfMinutes <= m) {
      current = items[j].bar;
      j += 1;
    }
    byMinute[m] = current;
  }
  return byMinute;
}

function isStrongCandle(bar, direction) {
  const o = Number(bar[1]);
  const h = Number(bar[2]);
  const l = Number(bar[3]);
  const c = Number(bar[4]);
  if (![o, h, l, c].every(Number.isFinite)) return false;
  const range = h - l;
  if (range <= 0) return false;
  const body = Math.abs(c - o);
  if (body < 0.5 * range) return false;
  if (direction === 'LONG') return c > o && c >= l + 0.5 * range;
  return c < o && c <= h - 0.5 * range;
}

function build15mEmaMap(bars15, emaPeriod) {
  const closes = bars15.map((b) => Number(b[4]));
  const ema = calculateEma(closes, emaPeriod);
  const map = new Map();
  for (let i = 0; i < bars15.length; i += 1) {
    if (Number.isFinite(ema[i])) map.set(bars15[i][0], ema[i]);
  }
  return map;
}

function build5mContext(bars5, { rsiPeriod, atrPeriod }) {
  const closes = bars5.map((b) => Number(b[4]));
  const highs = bars5.map((b) => Number(b[2]));
  const lows = bars5.map((b) => Number(b[3]));
  const volumes = bars5.map((b) => Number(b[5] ?? 0));
  const vwap = calculateVwap(highs, lows, closes, volumes);
  const rsi = calculateRsi(closes, rsiPeriod);
  const atr = calculateAtr(highs, lows, closes, atrPeriod);
  const byTs = new Map();
  for (let i = 0; i < bars5.length; i += 1) {
    byTs.set(bars5[i][0], {
      vwap: vwap[i],
      rsi: rsi[i],
      atr: atr[i],
      close: closes[i],
    });
  }
  return byTs;
}

function barVolume(bar) {
  const v = Number(bar[5] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function barRange(bar) {
  const h = Number(bar[2]);
  const l = Number(bar[3]);
  if (!Number.isFinite(h) || !Number.isFinite(l)) return 0;
  return Math.max(0, h - l);
}

function build1mRollingAvg(dayBars1, lookback, metricFn) {
  const avgs = new Map();
  const ring = new Array(lookback);
  let sum = 0;
  let count = 0;
  let head = 0;
  for (const bar of dayBars1) {
    const v = metricFn(bar);
    if (count < lookback) {
      ring[count] = v;
      sum += v;
      count += 1;
    } else {
      sum -= ring[head];
      ring[head] = v;
      sum += v;
      head = (head + 1) % lookback;
    }
    avgs.set(bar[0], sum / count);
  }
  return avgs;
}

/** Index 1m feeds often report volume 0 (same as Strategy 3). Use range when volume is missing. */
function passesVolumeSpike(bar1, volAvg1, rangeAvg1, volumeMult) {
  const vol = barVolume(bar1);
  const avgVol = volAvg1.get(bar1[0]);
  if (Number.isFinite(avgVol) && avgVol > 0) {
    return vol >= volumeMult * avgVol;
  }
  const range = barRange(bar1);
  const avgRange = rangeAvg1.get(bar1[0]);
  if (Number.isFinite(avgRange) && avgRange > 0) {
    return range >= volumeMult * avgRange;
  }
  return true;
}

/**
 * @param {{ candles1m: unknown[], candles5m: unknown[], candles15m: unknown[], settings: Record<string, unknown> }} args
 */
function runStrategyFourBacktest({ candles1m, candles5m, candles15m, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const qty = lotSize * lotCount;

  const emaPeriod = Math.max(2, Number(settings.emaPeriod) || 50);
  const rsiPeriod = Math.max(2, Number(settings.rsiPeriod) || 14);
  const atrPeriod = Math.max(2, Number(settings.atrPeriod) || 14);
  const rsiMin = Number.isFinite(Number(settings.rsiMin)) ? Number(settings.rsiMin) : 45;
  const rsiMax = Number.isFinite(Number(settings.rsiMax)) ? Number(settings.rsiMax) : 65;
  const slAtrMult = Math.max(0.1, Number(settings.slAtrMult) || 1.5);
  const targetAtrMult = Math.max(0.1, Number(settings.targetAtrMult) || 3);
  const volumeMult = Math.max(1, Number(settings.volumeMult) || 1.5);
  const volumeLookback = Math.max(5, Number(settings.volumeLookback) || 20);

  const entryStartMin = parseClockMinutes(settings.entryFromTime, 615);
  const entryEndMin = parseClockMinutes(settings.entryToTime, 840);
  const timeExitMin = parseClockMinutes(settings.exitTime, 915);

  const rawPerTradeCost = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);

  const byDay1 = buildIntradayByDay(candles1m);
  const byDay5 = buildIntradayByDay(candles5m);
  const byDay15 = buildIntradayByDay(candles15m);

  const bars15All = flattenSorted(byDay15);
  const ema15Map = build15mEmaMap(bars15All, emaPeriod);

  const trades = [];
  const dayKeys = Array.from(byDay1.keys()).sort();

  for (const dayKey of dayKeys) {
    const dayBars1 = byDay1.get(dayKey) || [];
    const dayBars5 = byDay5.get(dayKey) || [];
    const dayBars15 = byDay15.get(dayKey) || [];
    if (dayBars1.length < volumeLookback + 2 || dayBars5.length < atrPeriod + 2) continue;

    const ctx5 = build5mContext(dayBars5, { rsiPeriod, atrPeriod });
    const volAvg1 = build1mRollingAvg(dayBars1, volumeLookback, barVolume);
    const rangeAvg1 = build1mRollingAvg(dayBars1, volumeLookback, barRange);
    const closed15 = buildClosedBarByMinute(dayBars15, 15);
    const closed5 = buildClosedBarByMinute(dayBars5, 5);
    const minutes1 = dayBars1.map((bar) => getIstClock(bar[0]).minutes);
    let tradesToday = 0;

    for (let i = volumeLookback; i < dayBars1.length; i += 1) {
      if (tradesToday >= maxTradesPerDay) break;

      const bar1 = dayBars1[i];
      const atMin = minutes1[i];
      if (atMin < entryStartMin || atMin > entryEndMin) continue;

      const bar15 = closed15[atMin];
      const bar5 = closed5[atMin];
      if (!bar15 || !bar5) continue;

      const close15 = Number(bar15[4]);
      const ema15 = ema15Map.get(bar15[0]);
      if (!Number.isFinite(close15) || !Number.isFinite(ema15)) continue;

      const ctx = ctx5.get(bar5[0]);
      if (!ctx || !Number.isFinite(ctx.vwap) || !Number.isFinite(ctx.rsi) || !Number.isFinite(ctx.atr)) continue;
      if (ctx.rsi < rsiMin || ctx.rsi > rsiMax) continue;

      if (!passesVolumeSpike(bar1, volAvg1, rangeAvg1, volumeMult)) continue;

      let direction = null;
      if (close15 > ema15 && ctx.close > ctx.vwap && isStrongCandle(bar1, 'LONG')) {
        direction = 'LONG';
      } else if (close15 < ema15 && ctx.close < ctx.vwap && isStrongCandle(bar1, 'SHORT')) {
        direction = 'SHORT';
      }
      if (!direction) continue;

      const entrySpot = Number(bar1[4]);
      if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

      const atrAtEntry = ctx.atr;
      if (!Number.isFinite(atrAtEntry) || atrAtEntry <= 0) continue;

      const stopSpot = direction === 'LONG'
        ? entrySpot - slAtrMult * atrAtEntry
        : entrySpot + slAtrMult * atrAtEntry;
      const targetSpot = direction === 'LONG'
        ? entrySpot + targetAtrMult * atrAtEntry
        : entrySpot - targetAtrMult * atrAtEntry;

      let exitIdx = dayBars1.length - 1;
      let exitSpot = Number(dayBars1[exitIdx][4]);
      let reason = 'TIME_EXIT';

      for (let k = i + 1; k < dayBars1.length; k += 1) {
        const b = dayBars1[k];
        const ckMin = minutes1[k];
        const hi = Number(b[2]);
        const lo = Number(b[3]);
        const cl = Number(b[4]);
        if (![hi, lo, cl].every(Number.isFinite)) continue;

        if (direction === 'LONG') {
          if (lo <= stopSpot) {
            exitIdx = k;
            exitSpot = stopSpot;
            reason = 'STOP_LOSS';
            break;
          }
          if (hi >= targetSpot) {
            exitIdx = k;
            exitSpot = targetSpot;
            reason = 'TARGET';
            break;
          }
        } else {
          if (hi >= stopSpot) {
            exitIdx = k;
            exitSpot = stopSpot;
            reason = 'STOP_LOSS';
            break;
          }
          if (lo <= targetSpot) {
            exitIdx = k;
            exitSpot = targetSpot;
            reason = 'TARGET';
            break;
          }
        }

        if (ckMin >= timeExitMin) {
          exitIdx = k;
          exitSpot = cl;
          reason = 'TIME_EXIT';
          break;
        }
      }

      const points = direction === 'LONG' ? exitSpot - entrySpot : entrySpot - exitSpot;
      const grossPnl = points * qty;
      const pnl = grossPnl - perTradeCost;

      trades.push({
        pair: symbol,
        type: direction,
        strike: null,
        buyPrice: Number(entrySpot.toFixed(2)),
        sellPrice: Number(exitSpot.toFixed(2)),
        lotSize,
        lots: lotCount,
        invested: Number((entrySpot * qty).toFixed(2)),
        finalValue: Number((exitSpot * qty).toFixed(2)),
        closed: direction,
        order: direction === 'LONG' ? 'BUY' : 'SELL',
        entryTime: bar1[0],
        exitTime: dayBars1[exitIdx][0],
        entryPrice: Number(entrySpot.toFixed(2)),
        exitPrice: Number(exitSpot.toFixed(2)),
        stopLoss: Number(stopSpot.toFixed(2)),
        target: Number(targetSpot.toFixed(2)),
        qty,
        premium: Number(atrAtEntry.toFixed(2)),
        lotCount,
        investmentAmount: Number((entrySpot * qty).toFixed(2)),
        stopLossAmount: Number((Math.abs(entrySpot - stopSpot) * qty).toFixed(2)),
        targetAmount: Number((Math.abs(targetSpot - entrySpot) * qty).toFixed(2)),
        grossPnl: Number(grossPnl.toFixed(2)),
        charges: perTradeCost,
        pnl: Number(pnl.toFixed(2)),
        pnlPct: entrySpot > 0 ? Number(((pnl / (entrySpot * qty)) * 100).toFixed(2)) : 0,
        reason,
        atrAtEntry: Number(atrAtEntry.toFixed(2)),
        ema15AtEntry: Number(ema15.toFixed(2)),
        rsi5AtEntry: Number(ctx.rsi.toFixed(2)),
      });

      tradesToday += 1;
    }
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = {
  runStrategyFourBacktest,
};

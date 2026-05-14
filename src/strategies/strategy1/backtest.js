/**
 * Strategy 1 — Previous day closing retest (backtest only).
 *
 * Uses prior session’s daily OHLC (interval `1`) vs intraday execution candles (1 / 5 / 15).
 */

const { getIstClock } = require('../../utils/dateTime');
const { getLotSize, getStrikeStep, getOptionPremiumFromSpotMove } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');

function candleTouchesBand(high, low, bandLow, bandHigh) {
  return high >= bandLow && low <= bandHigh;
}

function buildDailyMap(rows) {
  const m = new Map();
  for (const c of rows) {
    const dk = getIstClock(c[0]).dateKey;
    const o = Number(c[1]);
    const h = Number(c[2]);
    const l = Number(c[3]);
    const cl = Number(c[4]);
    if (!dk || ![o, h, l, cl].every(Number.isFinite)) continue;
    if (!m.has(dk)) {
      m.set(dk, { open: o, high: h, low: l, close: cl });
    } else {
      const p = m.get(dk);
      m.set(dk, {
        open: p.open,
        high: Math.max(p.high, h),
        low: Math.min(p.low, l),
        close: cl,
      });
    }
  }
  return m;
}

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

function prevTradingDateKey(sortedDailyAsc, dayKey) {
  let prev = null;
  for (const dk of sortedDailyAsc) {
    if (dk >= dayKey) break;
    prev = dk;
  }
  return prev;
}

function pickStrike({ entrySpot, strikeStep, optionType, strikeMode }) {
  const step = Math.max(1, strikeStep);
  const atm = Math.round(entrySpot / step) * step;
  const mode = String(strikeMode || 'ATM').toUpperCase();
  if (mode === 'ITM') {
    if (optionType === 'CE') return atm - step;
    return atm + step;
  }
  if (mode === 'OTM') {
    if (optionType === 'CE') return atm + step;
    return atm - step;
  }
  return atm;
}

/**
 * @param {{ dailyCandles: unknown[], execCandles: unknown[], settings: Record<string, unknown> }} args
 */
function runStrategyOneBacktest({ dailyCandles, execCandles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const retestPointsRaw = Number(settings.retestPoints);
  const retestPoints = Number.isFinite(retestPointsRaw) ? Math.max(0, retestPointsRaw) : 1;
  const strikeMode = String(settings.strikeMode || 'ATM');
  const rawSl = Number(settings.stopLossPct);
  const hasStopLoss = Number.isFinite(rawSl) && rawSl > 0;
  const stopLossPct = hasStopLoss ? Math.min(99, Math.max(0.01, rawSl)) : 0;
  const rawTg = Number(settings.targetProfitPct);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetProfitPct = hasTarget ? Math.min(500, Math.max(0.01, rawTg)) : 0;
  const rawPerTradeCost = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);

  const dailyMap = buildDailyMap(Array.isArray(dailyCandles) ? dailyCandles : []);
  const intraByDay = buildIntradayByDay(Array.isArray(execCandles) ? execCandles : []);
  const sortedDailyAsc = Array.from(dailyMap.keys()).sort();
  const sortedExecDays = Array.from(intraByDay.keys()).sort();

  const trades = [];

  for (const dayKey of sortedExecDays) {
    const prevKey = prevTradingDateKey(sortedDailyAsc, dayKey);
    if (!prevKey || !dailyMap.has(prevKey)) continue;

    const prevClose = Number(dailyMap.get(prevKey).close);
    if (!Number.isFinite(prevClose) || prevClose <= 0) continue;

    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 2) continue;

    const sessionOpen = Number(dayBars[0][1]);
    if (!Number.isFinite(sessionOpen)) continue;

    if (sessionOpen === prevClose) continue;

    const callBias = sessionOpen > prevClose;
    const optionType = callBias ? 'CE' : 'PE';
    const premiumSide = optionType === 'CE' ? 'LONG' : 'SHORT';

    const bandLow = prevClose - retestPoints;
    const bandHigh = prevClose + retestPoints;

    let entryIdx = null;
    for (let j = 1; j < dayBars.length; j += 1) {
      const hi = Number(dayBars[j][2]);
      const lo = Number(dayBars[j][3]);
      if (![hi, lo].every(Number.isFinite)) continue;
      if (candleTouchesBand(hi, lo, bandLow, bandHigh)) {
        entryIdx = j;
        break;
      }
    }
    if (entryIdx == null || maxTradesPerDay < 1) continue;

    if (entryIdx >= dayBars.length - 1) continue;

    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);

    const targetPremium = hasTarget ? entryPremium * (1 + targetProfitPct / 100) : null;
    const stopPremium = hasStopLoss ? entryPremium * (1 - stopLossPct / 100) : null;

    let exitIdx = dayBars.length - 1;
    let exitSpot = Number(dayBars[exitIdx][4]);
    let exitPremium = getOptionPremiumFromSpotMove({
      side: premiumSide,
      entrySpot,
      currentSpot: exitSpot,
      entryPremium,
      premiumLeverage,
      strike,
      strikeStep,
    });
    let reason = 'DAY_CLOSE';

    for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
      const hi = Number(dayBars[k][2]);
      const lo = Number(dayBars[k][3]);
      const cl = Number(dayBars[k][4]);
      if (![hi, lo, cl].every(Number.isFinite)) continue;

      if (hasStopLoss && stopPremium != null) {
        const adverseSpot = optionType === 'CE' ? lo : hi;
        const adversePrem = getOptionPremiumFromSpotMove({
          side: premiumSide,
          entrySpot,
          currentSpot: adverseSpot,
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        if (adversePrem <= stopPremium) {
          exitIdx = k;
          exitSpot = adverseSpot;
          exitPremium = stopPremium;
          reason = 'STOP_LOSS';
          break;
        }
      }

      if (hasTarget && targetPremium != null) {
        const favSpot = optionType === 'CE' ? hi : lo;
        const favPrem = getOptionPremiumFromSpotMove({
          side: premiumSide,
          entrySpot,
          currentSpot: favSpot,
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        if (favPrem >= targetPremium) {
          exitIdx = k;
          exitSpot = favSpot;
          exitPremium = targetPremium;
          reason = 'TARGET';
          break;
        }
      }

      const kClock = getIstClock(dayBars[k][0]);
      if (kClock.minutes >= 930) {
        exitIdx = k;
        exitSpot = cl;
        exitPremium = getOptionPremiumFromSpotMove({
          side: premiumSide,
          entrySpot,
          currentSpot: exitSpot,
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        reason = 'DAY_CLOSE';
        break;
      }
    }

    const invested = entryPremium * lotSize * lotCount;
    const finalValue = exitPremium * lotSize * lotCount;
    const rawPnl = finalValue - invested;
    const pnl = rawPnl - perTradeCost;

    trades.push({
      pair: symbol,
      type: optionType,
      strike,
      buyPrice: Number(entryPremium.toFixed(2)),
      sellPrice: Number(exitPremium.toFixed(2)),
      lotSize,
      lots: lotCount,
      invested: Number(invested.toFixed(2)),
      finalValue: Number(finalValue.toFixed(2)),
      closed: optionType,
      order: 'BUY',
      entryTime: dayBars[entryIdx][0],
      exitTime: dayBars[exitIdx][0],
      entryPrice: Number(entrySpot.toFixed(2)),
      exitPrice: Number(exitSpot.toFixed(2)),
      stopLoss: hasStopLoss && stopPremium != null ? Number(stopPremium.toFixed(2)) : null,
      target: hasTarget && targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
      qty: lotSize * lotCount,
      premium: Number(entryPremium.toFixed(2)),
      lotCount,
      investmentAmount: Number(invested.toFixed(2)),
      stopLossAmount:
        hasStopLoss && stopPremium != null
          ? Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2))
          : null,
      targetAmount:
        hasTarget && targetPremium != null
          ? Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2))
          : null,
      grossPnl: Number(rawPnl.toFixed(2)),
      charges: perTradeCost,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
      reason,
    });
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = {
  runStrategyOneBacktest,
};

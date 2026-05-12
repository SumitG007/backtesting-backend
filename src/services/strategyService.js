const { parseClockMinutes, getIstClock, getWeekdayFromDateKey } = require('../utils/dateTime');
const { getLotSize, getStrikeStep, getOptionPremiumFromSpotMove } = require('../utils/market');

function getSummaryFromTrades(trades) {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const netPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);

  return {
    totalTrades,
    wins,
    losses: totalTrades - wins,
    winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(2)) : 0,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netPnl: Number(netPnl.toFixed(2)),
  };
}

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

function calculateMacd(values, fast, slow, signal) {
  const emaFast = calculateEma(values, fast);
  const emaSlow = calculateEma(values, slow);
  const macdLine = values.map((_, i) =>
    Number.isFinite(emaFast[i]) && Number.isFinite(emaSlow[i]) ? emaFast[i] - emaSlow[i] : null
  );
  const signalLine = calculateEma(macdLine.map((v) => (Number.isFinite(v) ? v : 0)), signal);
  return { macdLine, signalLine };
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
      // If feed has no volume (common in some index candles), fallback to running typical price average.
      const prev = i > 0 && Number.isFinite(vwap[i - 1]) ? vwap[i - 1] : typicalPrice;
      vwap[i] = (prev * i + typicalPrice) / (i + 1);
    }
  }
  return vwap;
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

function runStrategyDowTheory({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.50);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const rawStopLossPct = Number(settings.stopLossPct);
  const hasStopLoss = Number.isFinite(rawStopLossPct) && rawStopLossPct > 0;
  const stopLossPct = hasStopLoss ? Math.max(0.5, rawStopLossPct) : null;
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(0.5, rawTargetPct) : null;
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const trendLookback = Math.max(6, Number(settings.trendLookbackCandles) || 10);
  const pullbackLookback = Math.max(2, Number(settings.pullbackLookbackCandles) || 4);
  const minBreakoutPct = Math.max(0.0005, Number(settings.minBreakoutPct) || 0.001);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 585);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const dayKeys = Array.from(byDay.keys()).sort();
  const trades = [];

  for (let d = 0; d < dayKeys.length; d += 1) {
    const dayKey = dayKeys[d];
    const dayCandles = byDay.get(dayKey) || [];
    if (dayCandles.length < trendLookback + pullbackLookback + 3) continue;

    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const closes = dayCandles.map((c) => Number(c[4]));
    let tradesToday = 0;

    for (let i = trendLookback + pullbackLookback; i < dayCandles.length; i += 1) {
      if (tradesToday >= maxTradesPerDay) break;

      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes < normalizedEntryFrom || clock.minutes > normalizedEntryTo) continue;

      const trendStart = i - trendLookback - pullbackLookback;
      const trendEnd = i - pullbackLookback;
      if (trendStart < 0 || trendEnd <= trendStart) continue;

      const trendHighs = highs.slice(trendStart, trendEnd);
      const trendLows = lows.slice(trendStart, trendEnd);
      if (trendHighs.length < 3 || trendLows.length < 3) continue;

      const trendUp =
        trendHighs[trendHighs.length - 1] > trendHighs[0] &&
        trendLows[trendLows.length - 1] > trendLows[0];
      const trendDown =
        trendHighs[trendHighs.length - 1] < trendHighs[0] &&
        trendLows[trendLows.length - 1] < trendLows[0];
      if (!trendUp && !trendDown) continue;

      const pullbackStart = i - pullbackLookback;
      const pullbackHigh = Math.max(...highs.slice(pullbackStart, i));
      const pullbackLow = Math.min(...lows.slice(pullbackStart, i));
      const close = closes[i];

      let setup = null;
      if (trendUp && close > pullbackHigh * (1 + minBreakoutPct)) {
        setup = { side: 'LONG', optionType: 'CE' };
      }
      if (!setup && trendDown && close < pullbackLow * (1 - minBreakoutPct)) {
        setup = { side: 'SHORT', optionType: 'PE' };
      }
      if (!setup) continue;

      const entrySpot = close;
      const strike = Math.round(entrySpot / strikeStep) * strikeStep;
      const entryPremium = Math.max(1, (entrySpot * basePremiumPct) / 100);
      const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium * (1 - stopLossPct / 100)) : null;
      const targetPremium = hasTarget ? entryPremium * (1 + targetPct / 100) : null;
      let exitIndex = dayCandles.length - 1;
      let exitSpot = closes[exitIndex];
      let exitPremium = getOptionPremiumFromSpotMove({
        side: setup.side,
        entrySpot,
        currentSpot: exitSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      let reason = 'DAY_CLOSE';

      for (let j = i + 1; j < dayCandles.length; j += 1) {
        const favorablePremium = getOptionPremiumFromSpotMove({
          side: setup.side,
          entrySpot,
          currentSpot: setup.side === 'LONG' ? highs[j] : lows[j],
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        const adversePremium = getOptionPremiumFromSpotMove({
          side: setup.side,
          entrySpot,
          currentSpot: setup.side === 'LONG' ? lows[j] : highs[j],
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        const closePremium = getOptionPremiumFromSpotMove({
          side: setup.side,
          entrySpot,
          currentSpot: closes[j],
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        if (hasStopLoss && adversePremium <= stopPremium) {
          exitIndex = j;
          exitSpot = closes[j];
          exitPremium = stopPremium;
          reason = 'STOP_LOSS';
          break;
        }
        if (hasTarget && favorablePremium >= targetPremium) {
          exitIndex = j;
          exitSpot = closes[j];
          exitPremium = targetPremium;
          reason = 'TARGET';
          break;
        }
        const jClock = getIstClock(dayCandles[j][0]);
        if (jClock.minutes >= 930) {
          exitIndex = j;
          exitSpot = closes[j];
          exitPremium = closePremium;
          reason = 'DAY_CLOSE';
          break;
        }
      }

      const invested = entryPremium * lotSize * lotCount;
      const finalValue = exitPremium * lotSize * lotCount;
      const pnl = finalValue - invested;
      trades.push({
        pair: symbol,
        type: setup.optionType,
        strike,
        buyPrice: Number(entryPremium.toFixed(2)),
        sellPrice: Number(exitPremium.toFixed(2)),
        lotSize,
        lots: lotCount,
        invested: Number(invested.toFixed(2)),
        finalValue: Number(finalValue.toFixed(2)),
        closed: setup.optionType,
        order: 'BUY',
        entryTime: dayCandles[i][0],
        exitTime: dayCandles[exitIndex][0],
        entryPrice: Number(entrySpot.toFixed(2)),
        exitPrice: Number(exitSpot.toFixed(2)),
        stopLoss: hasStopLoss ? Number(stopPremium.toFixed(2)) : null,
        target: hasTarget ? Number(targetPremium.toFixed(2)) : null,
        qty: lotSize * lotCount,
        premium: Number(entryPremium.toFixed(2)),
        lotCount,
        investmentAmount: Number(invested.toFixed(2)),
        stopLossAmount: hasStopLoss
          ? Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2))
          : null,
        targetAmount: hasTarget
          ? Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2))
          : null,
        pnl: Number(pnl.toFixed(2)),
        pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
        reason,
      });
      tradesToday += 1;
    }
  }

  return { summary: getSummaryFromTrades(trades), trades };
}

function runStrategyAdxMacdReversal({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.50);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 2);
  const adxLength = Math.max(5, Number(settings.adxLength) || 14);
  const adxSmoothing = Math.max(2, Number(settings.adxSmoothing) || 10);
  const macdFast = Math.max(2, Number(settings.macdFast) || 12);
  const macdSlow = Math.max(macdFast + 1, Number(settings.macdSlow) || 26);
  const macdSignal = Math.max(2, Number(settings.macdSignal) || 9);
  const minAdx = Math.max(0, Number(settings.minAdx) || 0);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const dayKeys = Array.from(byDay.keys()).sort();
  const trades = [];
  for (const dayKey of dayKeys) {
    const dayCandles = byDay.get(dayKey) || [];
    if (dayCandles.length < Math.max(adxLength * 2 + 2, macdSlow + macdSignal + 2)) continue;
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const closes = dayCandles.map((c) => Number(c[4]));
    const { diplus, diminus, adx } = calculateDmi(highs, lows, closes, adxLength, adxSmoothing);
    const { macdLine, signalLine } = calculateMacd(closes, macdFast, macdSlow, macdSignal);

    let position = 0;
    let openTrade = null;
    let tradesToday = 0;
    for (let i = 0; i < dayCandles.length; i += 1) {
      const clock = getIstClock(dayCandles[i][0]);
      const inWindow = clock.minutes >= normalizedEntryFrom && clock.minutes <= normalizedEntryTo;
      const metricsReady =
        Number.isFinite(diplus[i]) &&
        Number.isFinite(diminus[i]) &&
        Number.isFinite(adx[i]) &&
        Number.isFinite(macdLine[i]) &&
        Number.isFinite(signalLine[i]);
      const longcheck =
        metricsReady &&
        adx[i] >= minAdx &&
        diplus[i] > diminus[i] &&
        macdLine[i] > signalLine[i];
      const shortcheck =
        metricsReady &&
        adx[i] >= minAdx &&
        diminus[i] > diplus[i] &&
        signalLine[i] > macdLine[i];
      const close = closes[i];

      if (position === 0 && inWindow && tradesToday < maxTradesPerDay) {
        if (longcheck || shortcheck) {
          const side = longcheck ? 'LONG' : 'SHORT';
          const optionType = longcheck ? 'CE' : 'PE';
          const strike = Math.round(close / strikeStep) * strikeStep;
          const entryPremium = Math.max(1, (close * basePremiumPct) / 100);
          openTrade = {
            pair: symbol,
            type: optionType,
            strike,
            lotSize,
            lots: lotCount,
            closed: optionType,
            order: 'BUY',
            qty: lotSize * lotCount,
            premium: Number(entryPremium.toFixed(2)),
            lotCount,
            side,
            entryIndex: i,
            entryTime: dayCandles[i][0],
            entryPrice: Number(close.toFixed(2)),
            entryPremium,
          };
          position = side === 'LONG' ? 1 : -1;
          tradesToday += 1;
        }
      } else if (position === 1 && shortcheck && openTrade) {
        const exitPremium = getOptionPremiumFromSpotMove({
          side: 'LONG',
          entrySpot: openTrade.entryPrice,
          currentSpot: close,
          entryPremium: openTrade.entryPremium,
          premiumLeverage,
          strike: openTrade.strike,
          strikeStep,
        });
        const invested = openTrade.entryPremium * lotSize * lotCount;
        const finalValue = exitPremium * lotSize * lotCount;
        const pnl = finalValue - invested;
        trades.push({
          ...openTrade,
          buyPrice: Number(openTrade.entryPremium.toFixed(2)),
          sellPrice: Number(exitPremium.toFixed(2)),
          invested: Number(invested.toFixed(2)),
          finalValue: Number(finalValue.toFixed(2)),
          entryTime: openTrade.entryTime,
          exitTime: dayCandles[i][0],
          entryPrice: openTrade.entryPrice,
          exitPrice: Number(close.toFixed(2)),
          stopLoss: null,
          target: null,
          investmentAmount: Number(invested.toFixed(2)),
          stopLossAmount: null,
          targetAmount: null,
          pnl: Number(pnl.toFixed(2)),
          pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
          reason: 'REVERSAL',
        });
        position = 0;
        openTrade = null;
        if (inWindow && tradesToday < maxTradesPerDay) {
          const strike = Math.round(close / strikeStep) * strikeStep;
          const entryPremium = Math.max(1, (close * basePremiumPct) / 100);
          openTrade = {
            pair: symbol,
            type: 'PE',
            strike,
            lotSize,
            lots: lotCount,
            closed: 'PE',
            order: 'BUY',
            qty: lotSize * lotCount,
            premium: Number(entryPremium.toFixed(2)),
            lotCount,
            side: 'SHORT',
            entryIndex: i,
            entryTime: dayCandles[i][0],
            entryPrice: Number(close.toFixed(2)),
            entryPremium,
          };
          position = -1;
          tradesToday += 1;
        }
      } else if (position === -1 && longcheck && openTrade) {
        const exitPremium = getOptionPremiumFromSpotMove({
          side: 'SHORT',
          entrySpot: openTrade.entryPrice,
          currentSpot: close,
          entryPremium: openTrade.entryPremium,
          premiumLeverage,
          strike: openTrade.strike,
          strikeStep,
        });
        const invested = openTrade.entryPremium * lotSize * lotCount;
        const finalValue = exitPremium * lotSize * lotCount;
        const pnl = finalValue - invested;
        trades.push({
          ...openTrade,
          buyPrice: Number(openTrade.entryPremium.toFixed(2)),
          sellPrice: Number(exitPremium.toFixed(2)),
          invested: Number(invested.toFixed(2)),
          finalValue: Number(finalValue.toFixed(2)),
          entryTime: openTrade.entryTime,
          exitTime: dayCandles[i][0],
          entryPrice: openTrade.entryPrice,
          exitPrice: Number(close.toFixed(2)),
          stopLoss: null,
          target: null,
          investmentAmount: Number(invested.toFixed(2)),
          stopLossAmount: null,
          targetAmount: null,
          pnl: Number(pnl.toFixed(2)),
          pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
          reason: 'REVERSAL',
        });
        position = 0;
        openTrade = null;
        if (inWindow && tradesToday < maxTradesPerDay) {
          const strike = Math.round(close / strikeStep) * strikeStep;
          const entryPremium = Math.max(1, (close * basePremiumPct) / 100);
          openTrade = {
            pair: symbol,
            type: 'CE',
            strike,
            lotSize,
            lots: lotCount,
            closed: 'CE',
            order: 'BUY',
            qty: lotSize * lotCount,
            premium: Number(entryPremium.toFixed(2)),
            lotCount,
            side: 'LONG',
            entryIndex: i,
            entryTime: dayCandles[i][0],
            entryPrice: Number(close.toFixed(2)),
            entryPremium,
          };
          position = 1;
          tradesToday += 1;
        }
      }
    }

    if (openTrade) {
      const finalClose = closes[closes.length - 1];
      const exitPremium = getOptionPremiumFromSpotMove({
        side: openTrade.side,
        entrySpot: openTrade.entryPrice,
        currentSpot: finalClose,
        entryPremium: openTrade.entryPremium,
        premiumLeverage,
        strike: openTrade.strike,
        strikeStep,
      });
      const invested = openTrade.entryPremium * lotSize * lotCount;
      const finalValue = exitPremium * lotSize * lotCount;
      const pnl = finalValue - invested;
      trades.push({
        ...openTrade,
        buyPrice: Number(openTrade.entryPremium.toFixed(2)),
        sellPrice: Number(exitPremium.toFixed(2)),
        invested: Number(invested.toFixed(2)),
        finalValue: Number(finalValue.toFixed(2)),
        entryTime: openTrade.entryTime,
        exitTime: dayCandles[dayCandles.length - 1][0],
        entryPrice: openTrade.entryPrice,
        exitPrice: Number(finalClose.toFixed(2)),
        stopLoss: null,
        target: null,
        investmentAmount: Number(invested.toFixed(2)),
        stopLossAmount: null,
        targetAmount: null,
        pnl: Number(pnl.toFixed(2)),
        pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
        reason: 'DAY_CLOSE',
      });
    }
  }
  return { summary: getSummaryFromTrades(trades), trades };
}

function runStrategyEmaVwapMacdHistogram({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.50);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const hasStopLoss = false;
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(0.5, rawTargetPct) : null;
  const oppositeSignalExitEnabled =
    settings.oppositeSignalExitEnabled !== false && settings.oppositeSignalExitEnabled !== 'false';
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const emaLength = Math.max(2, Number(settings.emaLength) || 9);
  const macdFast = Math.max(2, Number(settings.macdFast) || 48);
  const macdSlow = Math.max(macdFast + 1, Number(settings.macdSlow) || 104);
  const macdSignal = Math.max(2, Number(settings.macdSignal) || 36);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  const sessionCandles = [];
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    sessionCandles.push(c);
  }
  if (sessionCandles.length < Math.max(emaLength + 2, macdSlow + macdSignal + 2)) {
    return { summary: getSummaryFromTrades([]), trades: [] };
  }

  const highs = sessionCandles.map((c) => Number(c[2]));
  const lows = sessionCandles.map((c) => Number(c[3]));
  const closes = sessionCandles.map((c) => Number(c[4]));
  const volumes = sessionCandles.map((c) => Number(c[5] ?? 0));
  const ema = calculateEma(closes, emaLength);
  const { macdLine, signalLine } = calculateMacd(closes, macdFast, macdSlow, macdSignal);

  // VWAP resets each day.
  const vwap = new Array(sessionCandles.length).fill(null);
  let vwapDateKey = null;
  let cumulativePv = 0;
  let cumulativeVolume = 0;
  for (let i = 0; i < sessionCandles.length; i += 1) {
    const clock = getIstClock(sessionCandles[i][0]);
    if (clock.dateKey !== vwapDateKey) {
      vwapDateKey = clock.dateKey;
      cumulativePv = 0;
      cumulativeVolume = 0;
    }
    const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
    const volume = Math.max(0, Number(volumes[i] ?? 0));
    cumulativePv += typicalPrice * volume;
    cumulativeVolume += volume;
    if (cumulativeVolume > 0) {
      vwap[i] = cumulativePv / cumulativeVolume;
    } else {
      const prev = i > 0 && Number.isFinite(vwap[i - 1]) ? vwap[i - 1] : typicalPrice;
      vwap[i] = (prev + typicalPrice) / 2;
    }
  }

  const trades = [];
  let position = 0;
  let openTrade = null;
  let tradesToday = 0;
  let activeDateKey = null;

  function closeOpenTrade(exitIndex, reason) {
    if (!openTrade) return;
    const exitClose = closes[exitIndex];
    const exitPremium = getOptionPremiumFromSpotMove({
      side: openTrade.side,
      entrySpot: openTrade.entryPrice,
      currentSpot: exitClose,
      entryPremium: openTrade.entryPremium,
      premiumLeverage,
      strike: openTrade.strike,
      strikeStep,
    });
    const invested = openTrade.entryPremium * lotSize * lotCount;
    const finalValue = exitPremium * lotSize * lotCount;
    const pnl = finalValue - invested;
    trades.push({
      ...openTrade,
      buyPrice: Number(openTrade.entryPremium.toFixed(2)),
      sellPrice: Number(exitPremium.toFixed(2)),
      invested: Number(invested.toFixed(2)),
      finalValue: Number(finalValue.toFixed(2)),
      entryTime: openTrade.entryTime,
      exitTime: sessionCandles[exitIndex][0],
      entryPrice: openTrade.entryPrice,
      exitPrice: Number(exitClose.toFixed(2)),
      stopLoss: hasStopLoss && Number.isFinite(openTrade.stopPremium)
        ? Number(openTrade.stopPremium.toFixed(2))
        : null,
      target: hasTarget && Number.isFinite(openTrade.targetPremium)
        ? Number(openTrade.targetPremium.toFixed(2))
        : null,
      investmentAmount: Number(invested.toFixed(2)),
      stopLossAmount: hasStopLoss && Number.isFinite(openTrade.stopPremium)
        ? Number((Math.max(0, openTrade.entryPremium - openTrade.stopPremium) * lotSize * lotCount).toFixed(2))
        : null,
      targetAmount: hasTarget && Number.isFinite(openTrade.targetPremium)
        ? Number((Math.max(0, openTrade.targetPremium - openTrade.entryPremium) * lotSize * lotCount).toFixed(2))
        : null,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
      reason,
    });
    position = 0;
    openTrade = null;
  }

  for (let i = 0; i < sessionCandles.length; i += 1) {
    const clock = getIstClock(sessionCandles[i][0]);
    if (clock.dateKey !== activeDateKey) {
      if (openTrade && i > 0) closeOpenTrade(i - 1, 'DAY_CLOSE');
      activeDateKey = clock.dateKey;
      tradesToday = 0;
    }

    const inWindow = clock.minutes >= normalizedEntryFrom && clock.minutes <= normalizedEntryTo;
    const metricsReady =
      Number.isFinite(ema[i]) &&
      Number.isFinite(vwap[i]) &&
      Number.isFinite(macdLine[i]) &&
      Number.isFinite(signalLine[i]);
    const hist = metricsReady ? macdLine[i] - signalLine[i] : null;
    const close = closes[i];
    const longSignal = metricsReady && close > ema[i] && close > vwap[i] && hist > 0;
    const shortSignal = metricsReady && close < ema[i] && close < vwap[i] && hist < 0;
    const longExitSignal = metricsReady && close < ema[i] && close < vwap[i];
    const shortExitSignal = metricsReady && close > ema[i] && close > vwap[i];

    if (position === 0 && inWindow && tradesToday < maxTradesPerDay) {
      if (longSignal || shortSignal) {
        const side = longSignal ? 'LONG' : 'SHORT';
        const optionType = longSignal ? 'CE' : 'PE';
        const strike = Math.round(close / strikeStep) * strikeStep;
        const entryPremium = Math.max(1, (close * basePremiumPct) / 100);
        const stopPremium = null;
        const targetPremium = hasTarget ? entryPremium * (1 + targetPct / 100) : null;
        openTrade = {
          pair: symbol,
          type: optionType,
          strike,
          lotSize,
          lots: lotCount,
          closed: optionType,
          order: 'BUY',
          qty: lotSize * lotCount,
          premium: Number(entryPremium.toFixed(2)),
          lotCount,
          side,
          entryIndex: i,
          entryTime: sessionCandles[i][0],
          entryPrice: Number(close.toFixed(2)),
          entryPremium,
          stopPremium,
          targetPremium,
        };
        position = side === 'LONG' ? 1 : -1;
        tradesToday += 1;
      }
    }

    if (openTrade) {
      const favorablePremium = getOptionPremiumFromSpotMove({
        side: openTrade.side,
        entrySpot: openTrade.entryPrice,
        currentSpot: openTrade.side === 'LONG' ? highs[i] : lows[i],
        entryPremium: openTrade.entryPremium,
        premiumLeverage,
        strike: openTrade.strike,
        strikeStep,
      });
      if (hasTarget && Number.isFinite(openTrade.targetPremium) && favorablePremium >= openTrade.targetPremium) {
        closeOpenTrade(i, 'TARGET');
        continue;
      }
    }

    if (oppositeSignalExitEnabled && position === 1 && longExitSignal && openTrade) {
      closeOpenTrade(i, 'OPPOSITE_SIGNAL');
    } else if (oppositeSignalExitEnabled && position === -1 && shortExitSignal && openTrade) {
      closeOpenTrade(i, 'OPPOSITE_SIGNAL');
    }
  }

  if (openTrade) closeOpenTrade(sessionCandles.length - 1, 'DAY_CLOSE');
  return { summary: getSummaryFromTrades(trades), trades };
}

function runStrategyConfirmationBreakout({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.50);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(0.5, rawTargetPct) : 12;
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 2);
  const confirmationCandles = Math.max(1, Number(settings.confirmationCandles) || 3);
  const confirmationWindow = Math.max(1, Number(settings.confirmationWindow) || 2);
  const breakoutBufferPct = Math.max(0, Number(settings.breakoutBufferPct) || 0.08);
  const minRefRangePct = Math.max(0.01, Number(settings.minRefRangePct) || 0.15);
  const premiumStopLossCapPct = Math.max(0.5, Number(settings.premiumStopLossCapPct) || 3);
  const rawPerTradeCost = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const dayKeys = Array.from(byDay.keys()).sort();
  const trades = [];
  for (const dayKey of dayKeys) {
    const dayCandles = byDay.get(dayKey) || [];
    if (dayCandles.length <= confirmationCandles + 1) continue;
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const closes = dayCandles.map((c) => Number(c[4]));
    const volumes = dayCandles.map((c) => Number(c[5] ?? 0));
    const vwap = calculateVwap(highs, lows, closes, volumes);
    let tradesToday = 0;

    for (let i = 0; i < dayCandles.length - confirmationCandles; i += 1) {
      if (tradesToday >= maxTradesPerDay) break;
      const refClock = getIstClock(dayCandles[i][0]);
      if (refClock.minutes < normalizedEntryFrom || refClock.minutes > normalizedEntryTo) continue;
      if (i + 1 >= dayCandles.length) break;

      const refHigh = Math.max(highs[i], highs[i + 1]);
      const refLow = Math.min(lows[i], lows[i + 1]);
      if (!Number.isFinite(refHigh) || !Number.isFinite(refLow) || refHigh <= refLow) continue;
      const refRange = refHigh - refLow;
      const refRangePct = (refRange / Math.max(1, closes[i])) * 100;
      if (refRangePct < minRefRangePct) continue;

      let confirmationIndex = null;
      let setup = null;
      const confirmStart = i + 1 + confirmationCandles;
      const confirmEnd = Math.min(dayCandles.length - 1, confirmStart + confirmationWindow - 1);
      for (let k = confirmStart; k <= confirmEnd; k += 1) {
        const confirmClock = getIstClock(dayCandles[k][0]);
        if (confirmClock.minutes > normalizedEntryTo) break;
        const confirmationClose = closes[k];
        const bufferUp = refHigh * (1 + breakoutBufferPct / 100);
        const bufferDown = refLow * (1 - breakoutBufferPct / 100);
        const vwapValue = vwap[k];
        const bullishTrendOkay = Number.isFinite(vwapValue) ? confirmationClose > vwapValue : true;
        const bearishTrendOkay = Number.isFinite(vwapValue) ? confirmationClose < vwapValue : true;
        if (confirmationClose > bufferUp && bullishTrendOkay) {
          confirmationIndex = k;
          setup = { side: 'LONG', optionType: 'CE', stopSpot: refLow };
          break;
        }
        if (confirmationClose < bufferDown && bearishTrendOkay) {
          confirmationIndex = k;
          setup = { side: 'SHORT', optionType: 'PE', stopSpot: refHigh };
          break;
        }
      }
      if (!setup || confirmationIndex == null) continue;

      const entrySpot = closes[confirmationIndex];
      const strike = Math.round(entrySpot / strikeStep) * strikeStep;
      const entryPremium = Math.max(1, (entrySpot * basePremiumPct) / 100);
      const structureStopPremium = getOptionPremiumFromSpotMove({
        side: setup.side,
        entrySpot,
        currentSpot: setup.stopSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      const cappedStopPremium = Math.max(0.05, entryPremium * (1 - premiumStopLossCapPct / 100));
      const stopPremium = Math.max(cappedStopPremium, structureStopPremium);
      const targetPremium = entryPremium * (1 + targetPct / 100);

      let exitIndex = dayCandles.length - 1;
      let exitSpot = closes[exitIndex];
      let exitPremium = getOptionPremiumFromSpotMove({
        side: setup.side,
        entrySpot,
        currentSpot: exitSpot,
        entryPremium,
        premiumLeverage,
        strike,
        strikeStep,
      });
      let reason = 'DAY_CLOSE';

      for (let j = confirmationIndex + 1; j < dayCandles.length; j += 1) {
        const stopHit = setup.side === 'LONG' ? lows[j] <= setup.stopSpot : highs[j] >= setup.stopSpot;
        if (stopHit) {
          exitIndex = j;
          exitSpot = setup.stopSpot;
          exitPremium = stopPremium;
          reason = 'STOP_LOSS';
          break;
        }

        const favorablePremium = getOptionPremiumFromSpotMove({
          side: setup.side,
          entrySpot,
          currentSpot: setup.side === 'LONG' ? highs[j] : lows[j],
          entryPremium,
          premiumLeverage,
          strike,
          strikeStep,
        });
        if (favorablePremium >= targetPremium) {
          exitIndex = j;
          exitSpot = closes[j];
          exitPremium = targetPremium;
          reason = 'TARGET';
          break;
        }

        const jClock = getIstClock(dayCandles[j][0]);
        if (jClock.minutes >= 930) {
          exitIndex = j;
          exitSpot = closes[j];
          exitPremium = getOptionPremiumFromSpotMove({
            side: setup.side,
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
      // Per-trade cost (brokerage + slippage + other charges) applied to every
      // Strategy 1 trade. Profitable trades earn this much less, losing trades lose this much more.
      const pnl = rawPnl - perTradeCost;
      trades.push({
        pair: symbol,
        type: setup.optionType,
        strike,
        buyPrice: Number(entryPremium.toFixed(2)),
        sellPrice: Number(exitPremium.toFixed(2)),
        lotSize,
        lots: lotCount,
        invested: Number(invested.toFixed(2)),
        finalValue: Number(finalValue.toFixed(2)),
        closed: setup.optionType,
        order: 'BUY',
        entryTime: dayCandles[confirmationIndex][0],
        exitTime: dayCandles[exitIndex][0],
        entryPrice: Number(entrySpot.toFixed(2)),
        exitPrice: Number(exitSpot.toFixed(2)),
        stopLoss: Number(stopPremium.toFixed(2)),
        target: Number(targetPremium.toFixed(2)),
        qty: lotSize * lotCount,
        premium: Number(entryPremium.toFixed(2)),
        lotCount,
        investmentAmount: Number(invested.toFixed(2)),
        stopLossAmount: Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2)),
        targetAmount: Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2)),
        grossPnl: Number(rawPnl.toFixed(2)),
        charges: perTradeCost,
        pnl: Number(pnl.toFixed(2)),
        pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
        reason,
      });
      tradesToday += 1;
      i = Math.max(i, exitIndex - 1);
    }
  }

  return { summary: getSummaryFromTrades(trades), trades };
}

function runStrategyShortStraddle({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(1, rawTargetPct) : 50;
  const rawStopLossPct = Number(settings.stopLossPct);
  const hasStopLoss = Number.isFinite(rawStopLossPct) && rawStopLossPct > 0;
  const stopLossPct = hasStopLoss ? Math.max(1, rawStopLossPct) : 30;
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 840);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  // Exit time on NEXT trading day (default 09:20 IST = 560 minutes).
  const nextDayExitMinutes = parseClockMinutes(settings.dayCloseTime, 560);

  // Avoid same-day expiry contracts on weekly expiry day (default Thursday = 4).
  // Historical backtests do not have the live expiry list, so an expiry-weekday entry
  // is modeled as rolling to the next available expiry instead of skipping the day.
  const skipExpiryDay = settings.skipExpiryDay !== false && settings.skipExpiryDay !== 'false';
  const rawExpiryWeekday = Number(settings.expiryWeekday);
  const expiryWeekday = Number.isFinite(rawExpiryWeekday)
    ? Math.max(0, Math.min(6, Math.trunc(rawExpiryWeekday)))
    : 4;

  // Per-trade tax/brokerage applied to every Strategy 2 trade (default Rs 100).
  const rawPerTradeCost = Number(settings.perTradeCost);
  const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;

  // Group candles by IST date (session minutes 555..930).
  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }
  const dayKeys = Array.from(byDay.keys()).sort();
  const trades = [];

  for (let dIdx = 0; dIdx < dayKeys.length; dIdx += 1) {
    const entryDayKey = dayKeys[dIdx];
    const usesNextExpiry = skipExpiryDay && getWeekdayFromDateKey(entryDayKey) === expiryWeekday;

    const entryDayCandles = byDay.get(entryDayKey) || [];
    if (entryDayCandles.length < 1) continue;

    const nextDayKey = dayKeys[dIdx + 1];
    if (!nextDayKey) continue;
    const nextDayCandles = byDay.get(nextDayKey) || [];
    if (nextDayCandles.length < 1) continue;

    // Locate the entry candle: first candle inside the entry window.
    let entryIdx = -1;
    for (let i = 0; i < entryDayCandles.length; i += 1) {
      const clock = getIstClock(entryDayCandles[i][0]);
      if (clock.minutes >= normalizedEntryFrom && clock.minutes <= normalizedEntryTo) {
        entryIdx = i;
        break;
      }
    }
    if (entryIdx < 0) continue;

    const entryCandle = entryDayCandles[entryIdx];
    const entrySpot = Number(entryCandle[4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = Math.round(entrySpot / strikeStep) * strikeStep;
    const ceEntry = Math.max(1, (entrySpot * basePremiumPct) / 100);
    const peEntry = Math.max(1, (entrySpot * basePremiumPct) / 100);
    const entryCredit = ceEntry + peEntry;
    const targetCombined = entryCredit * (1 - targetPct / 100);
    const stopCombined = entryCredit * (1 + stopLossPct / 100);

    // Build the holding-period candle stream: from the candle AFTER entry on Day N,
    // through the rest of Day N, then all of Day N+1 up to the configured exit time.
    // For BTST behaviour, SL/Target checks are ONLY active on Day N+1 candles — Day N
    // candles are held through (no intraday exits on entry day).
    const holdingCandles = [];
    for (let i = entryIdx + 1; i < entryDayCandles.length; i += 1) {
      holdingCandles.push(entryDayCandles[i]);
    }
    const dayOneCandleCount = holdingCandles.length;
    for (let i = 0; i < nextDayCandles.length; i += 1) {
      holdingCandles.push(nextDayCandles[i]);
      const nClock = getIstClock(nextDayCandles[i][0]);
      if (nClock.minutes >= nextDayExitMinutes) break;
    }
    if (holdingCandles.length === 0) continue;

    const totalHoldCandles = holdingCandles.length;
    // Initial extrinsic value (premium - intrinsic). At entry, spot is at/near strike so this
    // is almost the entire credit. We decay this linearly to zero over the hold window to
    // model theta. Intrinsic value (|spot - strike|) at any moment is added to extrinsic
    // to get the combined premium.
    const initialExtrinsic = Math.max(0.01, entryCredit - Math.abs(entrySpot - strike));

    function combinedAtSpot(spot, elapsedSteps) {
      const intrinsic = Math.abs(Number(spot) - strike);
      const elapsedFraction = totalHoldCandles > 0
        ? Math.min(1, Math.max(0, elapsedSteps / totalHoldCandles))
        : 1;
      const remainingExtrinsic = initialExtrinsic * (1 - elapsedFraction);
      return Math.max(0.05, intrinsic + Math.max(0, remainingExtrinsic));
    }

    let exitCandle = holdingCandles[holdingCandles.length - 1];
    let exitSpot = Number(exitCandle[4]);
    let exitCombined = combinedAtSpot(exitSpot, totalHoldCandles);
    let reason = 'DAY_CLOSE';

    for (let j = 0; j < holdingCandles.length; j += 1) {
      const cnd = holdingCandles[j];
      const high = Number(cnd[2]);
      const low = Number(cnd[3]);
      const close = Number(cnd[4]);
      const elapsed = j + 1;
      const atHigh = combinedAtSpot(high, elapsed);
      const atLow = combinedAtSpot(low, elapsed);
      const atClose = combinedAtSpot(close, elapsed);

      // BTST: ignore intraday exits on Day N — only check SL/Target on Day N+1 candles.
      const isDayOne = j < dayOneCandleCount;
      if (isDayOne) continue;

      const worst = Math.max(atHigh, atLow, atClose);
      const best = Math.min(atHigh, atLow, atClose);

      if (worst >= stopCombined) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = stopCombined;
        reason = 'STOP_LOSS';
        break;
      }
      if (best <= targetCombined) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = targetCombined;
        reason = 'TARGET';
        break;
      }
      if (j === holdingCandles.length - 1) {
        exitCandle = cnd;
        exitSpot = close;
        exitCombined = atClose;
        reason = 'DAY_CLOSE';
      }
    }

    const qty = lotSize * lotCount;
    const credit = entryCredit * qty;
    const buyback = exitCombined * qty;
    const rawPnl = credit - buyback;
    const pnl = rawPnl - perTradeCost;

    trades.push({
      pair: symbol,
      type: 'STRADDLE',
      strike,
      buyPrice: Number(exitCombined.toFixed(2)),
      sellPrice: Number(entryCredit.toFixed(2)),
      lotSize,
      lots: lotCount,
      invested: Number(credit.toFixed(2)),
      finalValue: Number(buyback.toFixed(2)),
      closed: 'STRADDLE',
      order: 'SELL',
      entryTime: entryCandle[0],
      exitTime: exitCandle[0],
      entryPrice: Number(entrySpot.toFixed(2)),
      exitPrice: Number(exitSpot.toFixed(2)),
      stopLoss: Number(stopCombined.toFixed(2)),
      target: Number(targetCombined.toFixed(2)),
      qty,
      premium: Number(entryCredit.toFixed(2)),
      lotCount,
      investmentAmount: Number(credit.toFixed(2)),
      stopLossAmount: Number((Math.max(0, stopCombined - entryCredit) * qty).toFixed(2)),
      targetAmount: Number((Math.max(0, entryCredit - targetCombined) * qty).toFixed(2)),
      grossPnl: Number(rawPnl.toFixed(2)),
      charges: perTradeCost,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: credit > 0 ? Number(((pnl / credit) * 100).toFixed(2)) : 0,
      reason,
      expiryMode: usesNextExpiry ? 'NEXT_EXPIRY' : 'CURRENT_EXPIRY',
    });
  }

  return { summary: getSummaryFromTrades(trades), trades };
}

module.exports = {
  runStrategyDowTheory,
  runStrategyAdxMacdReversal,
  runStrategyEmaVwapMacdHistogram,
  runStrategyConfirmationBreakout,
  runStrategyShortStraddle,
};

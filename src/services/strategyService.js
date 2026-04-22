const { parseClockMinutes, getIstClock } = require('../utils/dateTime');
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

function runStrategyBreakoutRetest({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.85);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const rawStopLossPct = Number(settings.stopLossPct);
  const hasStopLoss = Number.isFinite(rawStopLossPct) && rawStopLossPct > 0;
  const stopLossPct = hasStopLoss ? Math.max(0.5, rawStopLossPct) : null;
  const rawTargetPct = Number(settings.targetPct);
  const hasTarget = Number.isFinite(rawTargetPct) && rawTargetPct > 0;
  const targetPct = hasTarget ? Math.max(0.5, rawTargetPct) : null;
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 900);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  const minBreakoutBodyPct = Math.max(0.35, Number(settings.minBreakoutBodyPct) || 0.5);
  const breakoutRangeMult = Math.max(0.8, Number(settings.breakoutRangeMult) || 1.0);
  const breakoutVolumeMult = Math.max(0.8, Number(settings.breakoutVolumeMult) || 1.2);
  const closeLocationBandPct = 0.4;

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
    if (dayCandles.length < 12) continue;

    const opens = dayCandles.map((c) => Number(c[1]));
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const closes = dayCandles.map((c) => Number(c[4]));
    const volumes = dayCandles.map((c) => Number(c[5] ?? 0));
    const openingIndexes = [];
    for (let i = 0; i < dayCandles.length; i += 1) {
      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes >= 555 && clock.minutes < 570) openingIndexes.push(i);
    }
    if (openingIndexes.length === 0) continue;

    const openingHigh = Math.max(...openingIndexes.map((idx) => highs[idx]));
    const openingLow = Math.min(...openingIndexes.map((idx) => lows[idx]));
    const openingRange = openingHigh - openingLow;
    if (!Number.isFinite(openingRange) || openingRange <= 0) continue;

    let tradesToday = 0;
    for (let i = openingIndexes[openingIndexes.length - 1] + 1; i < dayCandles.length; i += 1) {
      if (tradesToday >= maxTradesPerDay) break;
      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes < normalizedEntryFrom || clock.minutes > normalizedEntryTo) continue;

      const open = opens[i];
      const high = highs[i];
      const low = lows[i];
      const close = closes[i];
      const range = Math.max(0.0001, high - low);
      const body = Math.abs(close - open);
      const bodyPct = body / range;
      const closesNearHigh = (high - close) <= range * closeLocationBandPct;
      const closesNearLow = (close - low) <= range * closeLocationBandPct;
      const avgPrevRange =
        i >= 5 ? highs.slice(i - 5, i).map((h, j) => h - lows[i - 5 + j]).reduce((a, v) => a + v, 0) / 5 : range;
      const avgPrevVolume =
        i >= 5 ? volumes.slice(i - 5, i).reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0) / 5 : volumes[i] || 0;
      const hasReliableVolume = avgPrevVolume > 0;
      // Older Dhan index history can contain zero/empty volumes for entire periods.
      // In that case we skip volume-strength filtering instead of blocking all trades.
      const volumeStrong = !hasReliableVolume || (volumes[i] || 0) >= avgPrevVolume * breakoutVolumeMult;
      const strongBullish =
        close > open &&
        bodyPct >= minBreakoutBodyPct &&
        range >= avgPrevRange * breakoutRangeMult &&
        volumeStrong &&
        closesNearHigh;
      const strongBearish =
        close < open &&
        bodyPct >= minBreakoutBodyPct &&
        range >= avgPrevRange * breakoutRangeMult &&
        volumeStrong &&
        closesNearLow;
      let setup = null;
      if (close > openingHigh && strongBullish) setup = { side: 'LONG', optionType: 'CE' };
      if (!setup && close < openingLow && strongBearish) setup = { side: 'SHORT', optionType: 'PE' };
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

function runStrategyDowTheory({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.85);
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
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 900);
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
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.85);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 20);
  const adxLength = Math.max(5, Number(settings.adxLength) || 22);
  const adxSmoothing = Math.max(2, Number(settings.adxSmoothing) || 18);
  const macdFast = Math.max(2, Number(settings.macdFast) || 18);
  const macdSlow = Math.max(macdFast + 1, Number(settings.macdSlow) || 45);
  const macdSignal = Math.max(2, Number(settings.macdSignal) || 15);
  const minAdx = Math.max(0, Number(settings.minAdx) || 22);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 915);
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

module.exports = {
  runStrategyBreakoutRetest,
  runStrategyDowTheory,
  runStrategyAdxMacdReversal,
};

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

function runStrategyBreakoutRetest({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.85);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const stopLossPct = Math.max(0.5, Number(settings.stopLossPct) || 10);
  const targetPct = Math.max(0.5, Number(settings.targetPct) || 100);
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 570);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 900);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  const minBreakoutBodyPct = Math.max(0.35, Number(settings.minBreakoutBodyPct) || 0.5);
  const breakoutRangeMult = Math.max(0.8, Number(settings.breakoutRangeMult) || 1.0);
  const minOpeningRangePct = Math.max(0.03, Number(settings.minOpeningRangePct) || 0.07);
  const retestBufferPct = Math.max(0, Number(settings.retestBufferPct) || 0.08);

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const dayKeys = Array.from(byDay.keys()).sort();
  const dayOpenMap = new Map();
  for (const dayKey of dayKeys) {
    const firstCandle = byDay.get(dayKey)?.[0];
    dayOpenMap.set(dayKey, Number(firstCandle?.[1]));
  }

  const trades = [];
  for (let d = 1; d < dayKeys.length; d += 1) {
    const prevDayKey = dayKeys[d - 1];
    const dayKey = dayKeys[d];
    const pdo = dayOpenMap.get(prevDayKey);
    const dayCandles = byDay.get(dayKey) || [];
    if (!Number.isFinite(pdo) || dayCandles.length < 12) continue;

    const opens = dayCandles.map((c) => Number(c[1]));
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const closes = dayCandles.map((c) => Number(c[4]));
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
    const openingRangePct = (openingRange / Math.max(1, opens[openingIndexes[0]])) * 100;
    if (openingRangePct < minOpeningRangePct) continue;

    const zoneLow = openingLow + openingRange * 0.3;
    const zoneHigh = openingHigh - openingRange * 0.3;
    const levelBuffer = openingRange * (retestBufferPct / 100);

    let tradesToday = 0;
    let longBreakIndex = -1;
    let shortBreakIndex = -1;
    let longRetestConsumed = false;
    let shortRetestConsumed = false;

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
      const avgPrevRange =
        i >= 5 ? highs.slice(i - 5, i).map((h, j) => h - lows[i - 5 + j]).reduce((a, v) => a + v, 0) / 5 : range;
      const strongBullish = close > open && bodyPct >= minBreakoutBodyPct && range >= avgPrevRange * breakoutRangeMult;
      const strongBearish = close < open && bodyPct >= minBreakoutBodyPct && range >= avgPrevRange * breakoutRangeMult;
      const inNoTradeZone = close >= zoneLow && close <= zoneHigh;

      if (close > pdo && !inNoTradeZone && longBreakIndex === -1 && close > openingHigh && strongBullish) {
        longBreakIndex = i;
        continue;
      }
      if (close < pdo && !inNoTradeZone && shortBreakIndex === -1 && close < openingLow && strongBearish) {
        shortBreakIndex = i;
        continue;
      }

      let setup = null;
      if (longBreakIndex >= 0 && !longRetestConsumed && i > longBreakIndex && close > pdo && low <= openingHigh + levelBuffer) {
        longRetestConsumed = true;
        const lowerWick = Math.max(0, Math.min(open, close) - low);
        const rejection = close > open && lowerWick >= body;
        if ((rejection || strongBullish) && !inNoTradeZone) {
          setup = { side: 'LONG', optionType: 'CE' };
        }
      }
      if (
        !setup &&
        shortBreakIndex >= 0 &&
        !shortRetestConsumed &&
        i > shortBreakIndex &&
        close < pdo &&
        high >= openingLow - levelBuffer
      ) {
        shortRetestConsumed = true;
        const upperWick = Math.max(0, high - Math.max(open, close));
        const rejection = close < open && upperWick >= body;
        if ((rejection || strongBearish) && !inNoTradeZone) {
          setup = { side: 'SHORT', optionType: 'PE' };
        }
      }
      if (!setup) continue;

      const entrySpot = close;
      const strike = Math.round(entrySpot / strikeStep) * strikeStep;
      const entryPremium = Math.max(1, (entrySpot * basePremiumPct) / 100);
      const stopPremium = Math.max(0.05, entryPremium * (1 - stopLossPct / 100));
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
        if (adversePremium <= stopPremium) {
          exitIndex = j;
          exitSpot = closes[j];
          exitPremium = stopPremium;
          reason = 'STOP_LOSS';
          break;
        }
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
        stopLoss: Number(stopPremium.toFixed(2)),
        target: Number(targetPremium.toFixed(2)),
        qty: lotSize * lotCount,
        premium: Number(entryPremium.toFixed(2)),
        lotCount,
        investmentAmount: Number(invested.toFixed(2)),
        stopLossAmount: Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2)),
        targetAmount: Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
        pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
        reason,
      });
      tradesToday += 1;
    }
  }
  return { summary: getSummaryFromTrades(trades), trades };
}

module.exports = {
  runStrategyBreakoutRetest,
};

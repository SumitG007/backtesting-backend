/**
 * Strategy 5 (UI) — Kukki V2 style intraday long + short on NIFTY options.
 * Bullish regime → buy CE; bearish regime → buy PE. Flat by session close.
 */

const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');
const { buildStrategyRunSummary } = require('../shared/summary');
const { calculateEma, calculateDmi, calculateMacd } = require('../shared/indicators');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
} = require('../shared/intradayOptions');

function recentHighLow(bars, idx, lookback) {
  const n = Math.max(2, lookback || 3);
  let hh = -Infinity;
  let ll = Infinity;
  for (let k = Math.max(0, idx - n); k < idx; k += 1) {
    hh = Math.max(hh, Number(bars[k][2]));
    ll = Math.min(ll, Number(bars[k][3]));
  }
  return { hh, ll };
}

/**
 * @param {{ execCandles: unknown[], settings: Record<string, unknown> }} args
 */
function runKukkiV2Backtest({ execCandles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const common = parseCommonOptionSettings(settings, symbol);
  const {
    lotSize,
    lotCount,
    basePremiumPct,
    premiumLeverage,
    strikeStep,
    strikeMode,
    hasStopLoss,
    stopLossPoints,
    hasTarget,
    targetPoints,
    perTradeCost,
  } = common;

  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 6);
  const minBarsBetweenTrades = Math.max(1, Number(settings.minBarsBetweenTrades) || 2);
  const emaFastLen = Math.max(3, Number(settings.emaFast) || 9);
  const emaSlowLen = Math.max(emaFastLen + 1, Number(settings.emaSlow) || 21);
  const adxLength = Math.max(5, Number(settings.adxLength) || 14);
  const adxSmoothing = Math.max(2, Number(settings.adxSmoothing) || 10);
  const minAdx = Math.max(0, Number(settings.minAdx) || 20);
  const macdFast = Math.max(2, Number(settings.macdFast) || 12);
  const macdSlow = Math.max(macdFast + 1, Number(settings.macdSlow) || 26);
  const macdSignal = Math.max(2, Number(settings.macdSignal) || 9);
  const breakLookback = Math.max(2, Number(settings.breakLookbackBars) || 3);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 630);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 870);
  const minWarmup = Math.max(emaSlowLen, macdSlow + macdSignal, adxLength * 2) + breakLookback + 2;

  const intraByDay = buildIntradayByDay(Array.isArray(execCandles) ? execCandles : []);
  const sortedDays = Array.from(intraByDay.keys()).sort();
  const trades = [];
  let barsScanned = 0;
  let longSignals = 0;
  let shortSignals = 0;

  for (const dayKey of sortedDays) {
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < minWarmup) continue;

    const closes = dayBars.map((c) => Number(c[4]));
    const highs = dayBars.map((c) => Number(c[2]));
    const lows = dayBars.map((c) => Number(c[3]));
    const emaFast = calculateEma(closes, emaFastLen);
    const emaSlow = calculateEma(closes, emaSlowLen);
    const { diplus, diminus, adx } = calculateDmi(highs, lows, closes, adxLength, adxSmoothing);
    const { macdLine, signalLine } = calculateMacd(closes, macdFast, macdSlow, macdSignal);

    let dayTrades = 0;
    let lastEntryIdx = -minBarsBetweenTrades;

    for (let j = minWarmup; j < dayBars.length - 1; j += 1) {
      if (dayTrades >= maxTradesPerDay) break;

      const clock = getIstClock(dayBars[j][0]);
      if (clock.minutes < entryFromMinutes || clock.minutes > entryToMinutes) continue;
      if (j - lastEntryIdx < minBarsBetweenTrades) continue;

      barsScanned += 1;

      const close = closes[j];
      if (!Number.isFinite(close) || close <= 0) continue;

      const metricsReady =
        Number.isFinite(emaFast[j]) &&
        Number.isFinite(emaSlow[j]) &&
        Number.isFinite(diplus[j]) &&
        Number.isFinite(diminus[j]) &&
        Number.isFinite(adx[j]) &&
        Number.isFinite(macdLine[j]) &&
        Number.isFinite(signalLine[j]);
      if (!metricsReady || adx[j] < minAdx) continue;

      const { hh, ll } = recentHighLow(dayBars, j, breakLookback);
      const bullishTrend = emaFast[j] > emaSlow[j] && diplus[j] > diminus[j] && macdLine[j] > signalLine[j];
      const bearishTrend = emaFast[j] < emaSlow[j] && diminus[j] > diplus[j] && macdLine[j] < signalLine[j];
      const longBreak = close > hh;
      const shortBreak = close < ll;

      let optionType = null;
      if (bullishTrend && longBreak) {
        optionType = 'CE';
        longSignals += 1;
      } else if (bearishTrend && shortBreak) {
        optionType = 'PE';
        shortSignals += 1;
      }
      if (!optionType) continue;

      const entryIdx = j;
      const entrySpot = close;
      const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
      const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
      const targetPremium = hasTarget ? entryPremium + targetPoints : null;
      const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;

      const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
        dayBars,
        entryIdx,
        optionType,
        entrySpot,
        entryPremium,
        strike,
        strikeStep,
        premiumLeverage,
        hasStopLoss,
        stopPremium,
        hasTarget,
        targetPremium,
        useIndexExits: false,
      });

      trades.push(
        buildLongOptionTrade({
          symbol,
          lotSize,
          lotCount,
          perTradeCost,
          dayBars,
          entryIdx,
          optionType,
          strike,
          entrySpot,
          entryPremium,
          exitIdx,
          exitSpot,
          exitPremium,
          reason,
          hasStopLoss,
          stopPremium,
          hasTarget,
          targetPremium,
          extra: {
            signal: optionType === 'CE' ? 'KUKKI_LONG_CE' : 'KUKKI_SHORT_PE',
            adx: Number(adx[j].toFixed(2)),
            emaFast: Number(emaFast[j].toFixed(2)),
            emaSlow: Number(emaSlow[j].toFixed(2)),
          },
        })
      );

      dayTrades += 1;
      lastEntryIdx = entryIdx;
    }
  }

  return {
    trades,
    summary: buildStrategyRunSummary(trades),
    meta: {
      daysScanned: sortedDays.length,
      barsScanned,
      patternCandidates: longSignals + shortSignals,
      longSignals,
      shortSignals,
      execBarsTotal: Array.isArray(execCandles) ? execCandles.length : 0,
      maxTradesPerDay,
      pnlModel:
        'Kukki V2 style: trend + breakout entries, buy CE (long) or PE (short), flat at day close. Simulated premium; charges deducted.',
    },
  };
}

module.exports = { runKukkiV2Backtest };

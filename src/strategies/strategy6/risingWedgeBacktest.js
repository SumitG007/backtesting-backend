/**
 * Strategy 6 — Rising wedge / rising channel breakdown (bearish). Long PE on support break.
 */

const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');
const { buildStrategyRunSummary } = require('../shared/summary');
const { rollingVolumeAvg } = require('../shared/indicators');
const { detectRisingWedgeBreakdown } = require('../shared/patterns/risingWedge');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
} = require('../shared/intradayOptions');

function buildPatternOpts(settings) {
  return {
    wedgeLookback: Number(settings.wedgeLookback) || 8,
    pivotBars: Number(settings.pivotBars) || 1,
    minSwingPoints: Number(settings.minSwingPoints) || 2,
    maxLowerToUpperSlopeRatio: Number(settings.maxLowerToUpperSlopeRatio) || 1.02,
    minNarrowingPct: Number(settings.minNarrowingPct) ?? 2,
    minRisingSlopePerBar: Number(settings.minRisingSlopePerBar) || 0.15,
    breakdownBufferPoints: Number(settings.breakdownBufferPoints) || 0,
    stopBufferPoints: Number(settings.stopBufferPoints) || 6,
    measuredMoveMultiplier: Number(settings.measuredMoveMultiplier) || 0.75,
    requireBearishBreakdownCandle: settings.requireBearishBreakdownCandle === true,
    signalMode: String(settings.signalMode || 'balanced'),
    breakLookbackBars: Number(settings.breakLookbackBars) || 4,
    minRisePoints: Number(settings.minRisePoints) || 6,
  };
}

/**
 * @param {{ execCandles: unknown[], settings: Record<string, unknown> }} args
 */
function runRisingWedgeBacktest({ execCandles, settings }) {
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
    maxTradesPerDay,
    usePatternExits,
  } = common;

  const wedgeLookback = Math.max(6, Number(settings.wedgeLookback) || 8);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 555);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 915);
  const minBarsBetweenTrades = Math.max(1, Number(settings.minBarsBetweenTrades) || 2);
  const volumeConfirm = settings.volumeConfirm === true;
  const volumeLookback = Math.max(5, Number(settings.volumeLookback) || 20);
  const volumeMultiplier = Math.max(1, Number(settings.volumeMultiplier) || 1.15);
  const patternOpts = buildPatternOpts(settings);

  const intraByDay = buildIntradayByDay(Array.isArray(execCandles) ? execCandles : []);
  const sortedDays = Array.from(intraByDay.keys()).sort();
  const trades = [];
  let barsScanned = 0;
  let patternCandidates = 0;

  for (const dayKey of sortedDays) {
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < wedgeLookback + 2) continue;

    let dayTrades = 0;
    let lastEntryIdx = -minBarsBetweenTrades;

    for (let j = wedgeLookback; j < dayBars.length - 1; j += 1) {
      if (dayTrades >= maxTradesPerDay) break;

      const clock = getIstClock(dayBars[j][0]);
      if (clock.minutes < entryFromMinutes || clock.minutes > entryToMinutes) continue;

      barsScanned += 1;

      if (j - lastEntryIdx < minBarsBetweenTrades) continue;

      if (volumeConfirm) {
        const vol = Number(dayBars[j][5]);
        const avgVol = rollingVolumeAvg(dayBars, j, volumeLookback);
        if (avgVol > 2) {
          const v = Number.isFinite(vol) && vol > 0 ? vol : 0;
          if (v < avgVol * volumeMultiplier) continue;
        }
      }

      const pattern = detectRisingWedgeBreakdown(dayBars, j, patternOpts);
      if (!pattern) continue;
      patternCandidates += 1;

      const entryIdx = j;
      const entrySpot = Number(dayBars[entryIdx][4]);
      if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

      const optionType = 'PE';
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
        useIndexExits: usePatternExits,
        stopIndex: pattern.stopIndex,
        targetIndex: pattern.targetIndex,
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
            pattern: pattern.signalType || 'RISING_WEDGE_BREAKDOWN',
            narrowPct: pattern.narrowPct,
            stopLossIndex: Number(pattern.stopIndex.toFixed(2)),
            targetIndex: Number(pattern.targetIndex.toFixed(2)),
            measuredMove: Number(pattern.measuredMove.toFixed(2)),
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
      patternCandidates,
      execBarsTotal: Array.isArray(execCandles) ? execCandles.length : 0,
      signalMode: patternOpts.signalMode,
    },
  };
}

module.exports = {
  runRisingWedgeBacktest,
};

/**
 * Strategy 7 — Data-driven daily patterns (2022–26 study → intraday CE/PE).
 * Modes: gap / ORB / PDH-PDL / first hour / opening-range / combined
 */

const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');
const { buildStrategyRunSummary } = require('../shared/summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
} = require('../shared/intradayOptions');
const { buildDayContext, resolveDataPatternSignal } = require('./patternSignals');

const M915 = 555;
const M945 = 585;
const M1000 = 600;

function openingRange(bars) {
  let high = -Infinity;
  let low = Infinity;
  let endIdx = -1;
  for (let i = 0; i < bars.length; i += 1) {
    const m = getIstClock(bars[i][0]).minutes;
    if (m > M945) break;
    const h = Number(bars[i][2]);
    const l = Number(bars[i][3]);
    if (![h, l].every(Number.isFinite)) continue;
    high = Math.max(high, h);
    low = Math.min(low, l);
    endIdx = i;
  }
  if (endIdx < 0 || !Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low, endIdx, range: high - low };
}

function firstHourBias(bars) {
  const open = Number(bars[0][1]);
  let lastFh = null;
  for (const c of bars) {
    const m = getIstClock(c[0]).minutes;
    if (m < M915 || m >= M1000) continue;
    const cl = Number(c[4]);
    if (Number.isFinite(cl)) lastFh = cl;
  }
  if (!Number.isFinite(open) || lastFh == null) return null;
  if (lastFh > open) return 'UP';
  if (lastFh < open) return 'DOWN';
  return 'FLAT';
}

/** Opening-range momentum (legacy mode). */
function findOrMomentumSignal(bars, settings) {
  const sessionOpen = Number(bars[0][1]);
  if (!Number.isFinite(sessionOpen)) return null;

  const or = openingRange(bars);
  const fh = firstHourBias(bars);
  const entryFrom = parseClockMinutes(settings.entryFromTime, 600);
  const entryTo = parseClockMinutes(settings.entryToTime, 870);
  const minOrPct = Number(settings.minOrRangePct) || 0;
  const maxOrPct = Number(settings.maxOrRangePct) || 0;
  const requireFhAlign = settings.requireFirstHourAlign !== false;

  if (or && or.range > 0) {
    const orPct = (or.range / sessionOpen) * 100;
    if (minOrPct > 0 && orPct < minOrPct) return null;
    if (maxOrPct > 0 && orPct > maxOrPct) return null;
  }

  if (!or) return null;
  const buffer = Math.max(0, Number(settings.orBreakBufferPoints) || 0);

  for (let j = or.endIdx + 1; j < bars.length; j += 1) {
    const m = getIstClock(bars[j][0]).minutes;
    if (m < entryFrom || m > entryTo) continue;
    const cl = Number(bars[j][4]);
    if (!Number.isFinite(cl)) continue;

    if (cl > or.high + buffer) {
      if (requireFhAlign && fh !== 'UP') continue;
      return { optionType: 'CE', entryIdx: j, signal: 'OR_BREAK_UP' };
    }
    if (cl < or.low - buffer) {
      if (requireFhAlign && fh !== 'DOWN') continue;
      return { optionType: 'PE', entryIdx: j, signal: 'OR_BREAK_DOWN' };
    }
  }
  return null;
}

/**
 * @param {{ execCandles: unknown[], settings: Record<string, unknown> }} args
 */
function runDailyPatternBacktest({ execCandles, settings }) {
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

  const mode = String(settings.patternMode || 'combined').toLowerCase();
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const ctx = buildDayContext(execCandles);
  const trades = [];
  let patternCandidates = 0;

  for (const dayKey of ctx.sortedDays) {
    const dayBars = ctx.intraByDay.get(dayKey) || [];
    if (dayBars.length < 20) continue;

    let sig = null;
    if (mode === 'or_momentum' || mode === 'or_breakout') {
      sig = findOrMomentumSignal(dayBars, settings);
    } else {
      const day = ctx.dayByKey.get(dayKey);
      sig = resolveDataPatternSignal(day, dayBars, settings, {
        first30Median: ctx.first30Median,
      });
    }
    if (!sig) continue;
    patternCandidates += 1;

    const entryIdx = sig.entryIdx;
    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const optionType = sig.optionType;
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
          pattern: sig.signal,
          patternId: sig.patternId,
          patternMode: mode,
        },
      })
    );

    if (trades.length && maxTradesPerDay <= 1) continue;
  }

  return {
    trades,
    summary: buildStrategyRunSummary(trades),
    meta: {
      daysScanned: ctx.sortedDays.length,
      patternCandidates,
      patternMode: mode,
      maxTradesPerDay,
      pnlModel:
        'Simulated CE/PE premium from index moves. Rules from multi-year pattern study (gap, ORB, PDH/PDL, first hour).',
    },
  };
}

module.exports = {
  runDailyPatternBacktest,
};

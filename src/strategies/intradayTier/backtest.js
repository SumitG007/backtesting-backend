/**
 * Strategy 4 — first-hour vs 09:15 open: PE or CE; entry ≥10:00; premium SL/target; flat 15:20.
 */

const {
  getIstClock,
  parseClockMinutes,
  getWeekdayFromDateKey,
  parseDateOnly,
  addDays,
  formatDateOnly,
  isWeekendDateKey,
} = require('../../utils/dateTime');
const { isNseCashTradingDay } = require('../../services/nseHolidayService');
const { getLotSize, getStrikeStep, getOptionPremiumFromSpotMove } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');
const { computeSessionHighLow } = require('../shared/sessionRange');
const { shortStraddleMarginBlocked } = require('../shared/shortStraddleMargin');

const M915 = 555;
const M920 = 560; // 09:20 IST
const M1520 = 920; // 15:20 IST — short straddle same-day entry default
const M1000 = 600; // 10:00
const M1100 = 660;
const EOD_EXIT = 920; // 15:20 IST
const NEXT_DAY_EOD_EXIT = 915; // 15:15 IST — next-day exit default
const SESSION_END = 930;

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < M915 || clock.minutes > SESSION_END) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  }
  return m;
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

function firstHourMetrics(bars) {
  const sessionOpen = Number(bars[0][1]);
  if (!Number.isFinite(sessionOpen)) return null;

  let lastCloseBefore1000 = null;
  let fhHigh = -Infinity;
  let fhLow = Infinity;
  for (const c of bars) {
    const m = getIstClock(c[0]).minutes;
    if (m < M915) continue;
    if (m >= M1000) break;
    const h = Number(c[2]);
    const l = Number(c[3]);
    const cl = Number(c[4]);
    if (Number.isFinite(h)) fhHigh = Math.max(fhHigh, h);
    if (Number.isFinite(l)) fhLow = Math.min(fhLow, l);
    if (Number.isFinite(cl)) lastCloseBefore1000 = cl;
  }
  if (lastCloseBefore1000 == null || !Number.isFinite(fhHigh) || !Number.isFinite(fhLow)) return null;

  const movePoints = lastCloseBefore1000 - sessionOpen;
  const moveAbsPct = sessionOpen > 0 ? (Math.abs(movePoints) / sessionOpen) * 100 : 0;
  let optionType = null;
  if (lastCloseBefore1000 < sessionOpen) optionType = 'PE';
  else if (lastCloseBefore1000 > sessionOpen) optionType = 'CE';
  else return null;

  return {
    sessionOpen,
    lastCloseBefore1000,
    movePoints,
    moveAbsPct,
    fhRange: fhHigh - fhLow,
    optionType,
  };
}

/**
 * Strategy 4: first hour vs session open → PE / CE; entry on first bar ≥ entry time (default 10:00).
 */
function findFirstHourPeCeSignal(bars, settings = {}) {
  const fh = firstHourMetrics(bars);
  if (!fh) return null;

  const minMovePct = Number(settings.minFirstHourMovePct) || 0;
  const maxMovePct = Number(settings.maxFirstHourMovePct) || 0;
  const minMovePts = Number(settings.minFirstHourMovePoints) || 0;
  const minFhRange = Number(settings.minFirstHourRangePoints) || 0;
  const peMinPct = Number(settings.peMinFirstHourMovePct) || 0;
  const ceMinPct = Number(settings.ceMinFirstHourMovePct) || 0;
  const peMinRange = Number(settings.peMinFirstHourRangePoints) || 0;
  const ceMinRange = Number(settings.ceMinFirstHourRangePoints) || 0;

  const sideMinPct =
    fh.optionType === 'PE'
      ? peMinPct || minMovePct
      : ceMinPct || minMovePct;
  const sideMinRange =
    fh.optionType === 'PE'
      ? peMinRange || minFhRange
      : ceMinRange || minFhRange;

  if (sideMinPct > 0 && fh.moveAbsPct < sideMinPct) return null;
  if (maxMovePct > 0 && fh.moveAbsPct > maxMovePct) return null;
  if (minMovePts > 0 && Math.abs(fh.movePoints) < minMovePts) return null;
  if (sideMinRange > 0 && fh.fhRange < sideMinRange) return null;

  const side = String(settings.tradeSide || 'both').toLowerCase();
  if (side === 'pe_only' && fh.optionType !== 'PE') return null;
  if (side === 'ce_only' && fh.optionType !== 'CE') return null;

  const entryFromMin = parseClockMinutes(settings.entryFromTime, M1000);
  const entryToMin = parseClockMinutes(settings.entryToTime, M1100);
  let entryIdx = null;
  for (let j = 0; j < bars.length; j += 1) {
    const m = getIstClock(bars[j][0]).minutes;
    if (m >= entryFromMin && m <= entryToMin) {
      entryIdx = j;
      break;
    }
  }
  if (entryIdx == null) return null;
  return { optionType: fh.optionType, entryIdx, firstHourMovePct: fh.moveAbsPct, fhRange: fh.fhRange };
}

function simulateExitPeCe({
  dayBars,
  entryIdx,
  optionType,
  entrySpot,
  entryPremium,
  stopPremium,
  hasStopLoss,
  hasSignal,
  signalPoints,
  hasTrail,
  trailPoints,
  premiumLeverage,
  strike,
  strikeStep,
}) {
  const premiumSide = optionType === 'CE' ? 'LONG' : 'SHORT';
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
  let peakFavorablePremium = entryPremium;

  for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
    const hi = Number(dayBars[k][2]);
    const lo = Number(dayBars[k][3]);
    const c = Number(dayBars[k][4]);
    const kMin = getIstClock(dayBars[k][0]).minutes;
    if (![hi, lo, c].every(Number.isFinite)) continue;

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
    if (favPrem > peakFavorablePremium) peakFavorablePremium = favPrem;

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

    const peakProfitPts = peakFavorablePremium - entryPremium;
    const signalReached = hasSignal && signalPoints > 0 && peakProfitPts >= signalPoints;
    if (hasTrail && trailPoints > 0 && signalReached) {
      const trailStopPremium = Math.max(0.05, peakFavorablePremium - trailPoints);
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
      if (adversePrem <= trailStopPremium) {
        exitIdx = k;
        exitSpot = adverseSpot;
        exitPremium = trailStopPremium;
        reason = 'TRAIL_STOP';
        break;
      }
    }

    if (kMin >= EOD_EXIT) {
      exitIdx = k;
      exitSpot = c;
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

  return { exitIdx, exitSpot, exitPremium, reason };
}

function pushTrade({
  trades,
  symbol,
  dayBars,
  entryIdx,
  exitIdx,
  optionType,
  entrySpot,
  exitSpot,
  entryPremium,
  exitPremium,
  reason,
  lotSize,
  lotCount,
  perTradeCost,
  hasStopLoss,
  stopPremium,
  hasTarget,
  targetPremium,
  strike,
}) {
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
    ...computeSessionHighLow(dayBars),
  });
}

function firstBarAtOrAfter(bars, minuteMark) {
  for (let i = 0; i < bars.length; i += 1) {
    if (getIstClock(bars[i][0]).minutes >= minuteMark) return i;
  }
  return null;
}

function parseExpiryWeekday(value) {
  const byName = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };
  const raw = String(value == null ? 'TUESDAY' : value).trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(byName, raw)) return byName[raw];
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  return 2; // Tuesday default
}

function resolveNextExpiryDateKey(entryDateKey, expiryWeekday) {
  const wd = getWeekdayFromDateKey(entryDateKey);
  if (wd < 0) return null;
  const parsed = parseDateOnly(entryDateKey);
  if (Number.isNaN(parsed.getTime())) return null;
  let daysAhead = (expiryWeekday - wd + 7) % 7;
  if (daysAhead === 0) daysAhead = 7; // On expiry day, use next expiry.
  return formatDateOnly(addDays(parsed, daysAhead));
}

/** First NSE trading day after entry — matches live paper engine exit schedule. */
function resolveFirstTradingDayAfter(entryDateKey) {
  const parsed = parseDateOnly(entryDateKey);
  if (Number.isNaN(parsed.getTime())) return null;
  for (let d = 1; d <= 10; d += 1) {
    const key = formatDateOnly(addDays(parsed, d));
    if (isWeekendDateKey(key)) continue;
    if (!isNseCashTradingDay(key)) continue;
    return key;
  }
  return null;
}

/** Candle day to exit on: planned exit day, or next available session if that day has no bars. */
function findExitDayInCandleData(entryDateKey, sortedKeys) {
  const plannedExitDay = resolveFirstTradingDayAfter(entryDateKey);
  if (!plannedExitDay) return null;
  for (const key of sortedKeys) {
    if (key <= entryDateKey) continue;
    if (key < plannedExitDay) continue;
    return key;
  }
  return null;
}

function runShortStraddleNextDay({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, M1520);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, entryFromMinutes);
  const normalizedEntryFrom = Math.min(entryFromMinutes, entryToMinutes);
  const normalizedEntryTo = Math.max(entryFromMinutes, entryToMinutes);
  const nextDayExitAtMinutes = parseClockMinutes(settings.nextDayExitTime, NEXT_DAY_EOD_EXIT);
  const expiryWeekday = parseExpiryWeekday(settings.expiryWeekday);
  const thetaDecayPerDayPct = Math.max(1, Number(settings.thetaDecayPerDayPct) || 12);

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];

  for (let i = 0; i < sortedKeys.length; i += 1) {
    const entryDateKey = sortedKeys[i];
    if (isWeekendDateKey(entryDateKey) || !isNseCashTradingDay(entryDateKey)) continue;

    const exitDateKey = findExitDayInCandleData(entryDateKey, sortedKeys);
    if (!exitDateKey) continue;

    const entryBars = intraByDay.get(entryDateKey) || [];
    const exitBars = intraByDay.get(exitDateKey) || [];
    if (entryBars.length < 2 || exitBars.length < 2) continue;

    let entryIdx = null;
    for (let j = 0; j < entryBars.length; j += 1) {
      const m = getIstClock(entryBars[j][0]).minutes;
      if (m >= normalizedEntryFrom && m <= normalizedEntryTo) {
        entryIdx = j;
        break;
      }
    }
    if (entryIdx == null) continue;

    const nextDayExitIdx = firstBarAtOrAfter(exitBars, nextDayExitAtMinutes);
    if (nextDayExitIdx == null) continue;

    const entrySpot = Number(entryBars[entryIdx][4]);
    const exitSpot = Number(exitBars[nextDayExitIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0 || !Number.isFinite(exitSpot) || exitSpot <= 0) continue;

    const strike = pickStrike({ entrySpot, strikeStep, optionType: 'CE', strikeMode });
    const expiryDate = resolveNextExpiryDateKey(entryDateKey, expiryWeekday);
    const ceEntryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
    const peEntryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);

    const ceExitPremium = getOptionPremiumFromSpotMove({
      side: 'LONG',
      entrySpot,
      currentSpot: exitSpot,
      entryPremium: ceEntryPremium,
      premiumLeverage,
      strike,
      strikeStep,
    });
    const peExitPremium = getOptionPremiumFromSpotMove({
      side: 'SHORT',
      entrySpot,
      currentSpot: exitSpot,
      entryPremium: peEntryPremium,
      premiumLeverage,
      strike,
      strikeStep,
    });

    const entryCredit = ceEntryPremium + peEntryPremium;
    const qty = lotSize * lotCount;
    const exitTime = exitBars[nextDayExitIdx][0];
    const exitSpotChosen = exitSpot;
    const reason = 'NEXT_DAY_EXIT';

    const entryTs = new Date(entryBars[entryIdx][0]).getTime();
    const exitBarTs = new Date(exitTime).getTime();
    const elapsedDays =
      Number.isFinite(entryTs) && Number.isFinite(exitBarTs) && exitBarTs > entryTs
        ? (exitBarTs - entryTs) / (1000 * 60 * 60 * 24)
        : 0;
    const decayFactor = Math.max(0.35, 1 - (thetaDecayPerDayPct / 100) * elapsedDays);
    const exitBuyback = (ceExitPremium + peExitPremium) * decayFactor;

    const credit = entryCredit * qty;
    const buyback = exitBuyback * qty;
    const rawPnl = credit - buyback;
    const pnl = rawPnl - perTradeCost;
    const totalMarginBlocked = shortStraddleMarginBlocked({
      entrySpot,
      lotSize,
      lotCount,
      settings,
    });
    trades.push({
      pair: symbol,
      type: 'STRADDLE',
      strike,
      buyPrice: Number(exitBuyback.toFixed(2)),
      sellPrice: Number(entryCredit.toFixed(2)),
      lotSize,
      lots: lotCount,
      invested: Number(totalMarginBlocked.toFixed(2)),
      finalValue: Number(buyback.toFixed(2)),
      closed: 'STRADDLE',
      order: 'SELL',
      entryTime: entryBars[entryIdx][0],
      exitTime,
      entryPrice: Number(entrySpot.toFixed(2)),
      exitPrice: Number(exitSpotChosen.toFixed(2)),
      stopLoss: null,
      target: null,
      qty,
      premium: Number(entryCredit.toFixed(2)),
      lotCount,
      creditReceived: Number(credit.toFixed(2)),
      investmentAmount: Number(totalMarginBlocked.toFixed(2)),
      stopLossAmount: null,
      targetAmount: null,
      grossPnl: Number(rawPnl.toFixed(2)),
      charges: perTradeCost,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: totalMarginBlocked > 0 ? Number(((pnl / totalMarginBlocked) * 100).toFixed(2)) : 0,
      reason,
      expiryDate: expiryDate || undefined,
      ...computeSessionHighLow(entryBars),
    });
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

/**
 * @param {{ candles: unknown[], settings: Record<string, unknown>, variant: string }} args
 */
function runIntradayTierBacktest({ candles, settings, variant }) {
  if (variant === 'short_straddle_next_day') {
    return runShortStraddleNextDay({ candles, settings });
  }

  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const strikeMode = String(settings.strikeMode || 'ATM');
  const rawSl = Number(settings.stopLossPoints);
  const hasStopLoss = Number.isFinite(rawSl) && rawSl > 0;
  const stopLossPoints = hasStopLoss ? Math.min(5000, Math.max(0.01, rawSl)) : 0;
  const rawSignal = Number(settings.signalPoints ?? settings.targetProfitPoints);
  const hasSignal = Number.isFinite(rawSignal) && rawSignal > 0;
  const signalPoints = hasSignal ? Math.min(5000, Math.max(0.01, rawSignal)) : 0;
  const rawTrail = Number(settings.trailPoints);
  const hasTrail = Number.isFinite(rawTrail) && rawTrail > 0;
  const trailPoints = hasTrail ? Math.min(5000, Math.max(0.01, rawTrail)) : 0;
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  const maxGapPct = Number(settings.maxGapPct) || 0;
  const minGapPct = Number(settings.minGapPct) || 0;

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const trades = [];
  const prevCloseByDay = new Map();
  for (let i = 1; i < sortedKeys.length; i += 1) {
    const prevBars = intraByDay.get(sortedKeys[i - 1]);
    if (!prevBars?.length) continue;
    const pc = Number(prevBars[prevBars.length - 1][4]);
    if (Number.isFinite(pc)) prevCloseByDay.set(sortedKeys[i], pc);
  }

  for (const dayKey of sortedKeys) {
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 3) continue;

    const sessionOpen = Number(dayBars[0][1]);
    const prevClose = prevCloseByDay.get(dayKey);
    if (Number.isFinite(sessionOpen) && Number.isFinite(prevClose) && prevClose > 0) {
      const gapPct = ((sessionOpen - prevClose) / prevClose) * 100;
      if (maxGapPct > 0 && Math.abs(gapPct) > maxGapPct) continue;
      if (minGapPct > 0 && Math.abs(gapPct) < minGapPct) continue;
      const skipGapUpPe = settings.skipGapUpPe === true && gapPct > 0.15;
      const skipGapDownCe = settings.skipGapDownCe === true && gapPct < -0.15;
      if (skipGapUpPe || skipGapDownCe) {
        const fh = firstHourMetrics(dayBars);
        if (fh && ((skipGapUpPe && fh.optionType === 'PE') || (skipGapDownCe && fh.optionType === 'CE'))) {
          continue;
        }
      }
    }

    let entryIdx = null;
    let optionType = null;

    if (variant !== 'first_hour_pe_ce') {
      throw new Error(`Unknown intraday tier variant: ${variant}`);
    }
    const sig = findFirstHourPeCeSignal(dayBars, settings);
    if (!sig) continue;
    entryIdx = sig.entryIdx;
    optionType = sig.optionType;

    if (entryIdx == null || optionType == null) continue;
    const entryMin = getIstClock(dayBars[entryIdx][0]).minutes;
    if (entryMin > M1100) continue;
    if (entryIdx >= dayBars.length - 1) continue;

    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = pickStrike({ entrySpot, strikeStep, optionType, strikeMode });
    const entryPremium = Math.max(0.05, (entrySpot * basePremiumPct) / 100);

    const signalPremium = hasSignal ? entryPremium + signalPoints : null;
    const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;
    const { exitIdx, exitSpot, exitPremium, reason } = simulateExitPeCe({
      dayBars,
      entryIdx,
      optionType,
      entrySpot,
      entryPremium,
      stopPremium,
      hasStopLoss,
      hasSignal,
      signalPoints,
      hasTrail,
      trailPoints,
      premiumLeverage,
      strike,
      strikeStep,
    });

    pushTrade({
      trades,
      symbol,
      dayBars,
      entryIdx,
      exitIdx,
      optionType,
      entrySpot,
      exitSpot,
      entryPremium,
      exitPremium,
      reason,
      lotSize,
      lotCount,
      perTradeCost,
      hasStopLoss,
      stopPremium,
      hasTarget: hasSignal,
      targetPremium: signalPremium,
      strike,
    });
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = {
  runIntradayTierBacktest,
};

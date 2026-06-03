/**
 * Short straddle next day — sell ATM CE + PE same day, exit next trading day.
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

const M1520 = 920;
const NEXT_DAY_EOD_EXIT = 915;
const SESSION_END = 930;

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > SESSION_END) continue;
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
  return 2;
}

function resolveNextExpiryDateKey(entryDateKey, expiryWeekday) {
  const wd = getWeekdayFromDateKey(entryDateKey);
  if (wd < 0) return null;
  const parsed = parseDateOnly(entryDateKey);
  if (Number.isNaN(parsed.getTime())) return null;
  let daysAhead = (expiryWeekday - wd + 7) % 7;
  if (daysAhead === 0) daysAhead = 7;
  return formatDateOnly(addDays(parsed, daysAhead));
}

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
      exitPrice: Number(exitSpot.toFixed(2)),
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

function runIntradayTierBacktest({ candles, settings, variant }) {
  if (variant !== 'short_straddle_next_day') {
    throw new Error(`Unknown intraday tier variant: ${variant}`);
  }
  return runShortStraddleNextDay({ candles, settings });
}

module.exports = {
  runIntradayTierBacktest,
};

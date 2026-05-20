/**
 * Strategy 5 — Intraday IV mean reversion (short vol).
 * IV proxy = 09:15–09:45 range vs lookback median. Short ATM straddle on spike.
 * Exits: optional vol-crush target / vol-expand stop; post-entry IV expand; 15:20 day close.
 */

const { getIstClock } = require('../../utils/dateTime');
const { getLotSize, getStrikeStep, getOptionPremiumFromSpotMove } = require('../../utils/market');
const { buildStrategyRunSummary } = require('../shared/summary');

const M915 = 555;
const M945 = 585;
const M1000 = 600;
const M1100 = 660;
const EOD_EXIT = 920;
const SESSION_END = 930;
const MIN_HOLD_BARS = 2;

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

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Opening-range width 09:15–09:45. */
function orIvProxy(bars) {
  let hi = -Infinity;
  let lo = Infinity;
  let n = 0;
  for (const c of bars) {
    const m = getIstClock(c[0]).minutes;
    if (m < M915 || m > M945) continue;
    const h = Number(c[2]);
    const l = Number(c[3]);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    hi = Math.max(hi, h);
    lo = Math.min(lo, l);
    n += 1;
  }
  if (n < 2 || !Number.isFinite(hi)) return null;
  return hi - lo;
}

/** High-low range from entry bar through endIdx (post-entry only). */
function postEntryRange(bars, entryIdx, endIdx) {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = entryIdx; i <= endIdx && i < bars.length; i += 1) {
    const h = Number(bars[i][2]);
    const l = Number(bars[i][3]);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    hi = Math.max(hi, h);
    lo = Math.min(lo, l);
  }
  if (!Number.isFinite(hi)) return null;
  return hi - lo;
}

function shortStraddlePremium({
  spot,
  strike,
  entrySpot,
  entryCredit,
  entryMin,
  currentMin,
  premiumLeverage,
  strikeStep,
}) {
  const half = entryCredit / 2;
  const ce = getOptionPremiumFromSpotMove({
    side: 'LONG',
    entrySpot,
    currentSpot: spot,
    entryPremium: half,
    premiumLeverage,
    strike,
    strikeStep,
  });
  const pe = getOptionPremiumFromSpotMove({
    side: 'LONG',
    entrySpot,
    currentSpot: spot,
    entryPremium: half,
    premiumLeverage,
    strike,
    strikeStep,
  });
  let combined = ce + pe;
  const minutesHeld = Math.max(0, currentMin - entryMin);
  const timeDecay = Math.min(0.4, (minutesHeld / 360) * 0.4);
  combined *= 1 - timeDecay;
  return Math.max(0.05, combined);
}

function findEntry({ dayBars, medianOrIv, ivSpikeMultiplier, maxSpikeMultiplier }) {
  const todayOr = orIvProxy(dayBars);
  if (!todayOr || todayOr <= 0 || medianOrIv <= 0) return null;
  if (todayOr < medianOrIv * ivSpikeMultiplier) return null;
  if (todayOr > medianOrIv * maxSpikeMultiplier) return null;

  for (let j = 0; j < dayBars.length; j += 1) {
    const m = getIstClock(dayBars[j][0]).minutes;
    if (m < M1000) continue;
    if (m > M1100) break;
    return { entryIdx: j, entryIv: todayOr, medianIv: medianOrIv };
  }
  return null;
}

function simulateExit({
  dayBars,
  entryIdx,
  entrySpot,
  strike,
  entryCredit,
  entryIv,
  premiumLeverage,
  strikeStep,
  hasPremiumTarget,
  targetVolCrushPct,
  hasPremiumStop,
  stopVolExpandPct,
  ivExpandStopMult,
}) {
  const entryMin = getIstClock(dayBars[entryIdx][0]).minutes;
  let exitIdx = dayBars.length - 1;
  let exitSpot = Number(dayBars[exitIdx][4]);
  let exitCombined = shortStraddlePremium({
    spot: exitSpot,
    strike,
    entrySpot,
    entryCredit,
    entryMin,
    currentMin: getIstClock(dayBars[exitIdx][0]).minutes,
    premiumLeverage,
    strikeStep,
  });
  let reason = 'DAY_CLOSE';

  const targetCombined = hasPremiumTarget ? entryCredit * (1 - targetVolCrushPct / 100) : null;
  const stopCombined = hasPremiumStop ? entryCredit * (1 + stopVolExpandPct / 100) : null;

  for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
    const c = dayBars[k];
    const hi = Number(c[2]);
    const lo = Number(c[3]);
    const cl = Number(c[4]);
    const kMin = getIstClock(c[0]).minutes;
    if (![hi, lo, cl].every(Number.isFinite)) continue;

    const barsHeld = k - entryIdx;
    if (barsHeld < MIN_HOLD_BARS) continue;

    const atHigh = shortStraddlePremium({
      spot: hi,
      strike,
      entrySpot,
      entryCredit,
      entryMin,
      currentMin: kMin,
      premiumLeverage,
      strikeStep,
    });
    const atLow = shortStraddlePremium({
      spot: lo,
      strike,
      entrySpot,
      entryCredit,
      entryMin,
      currentMin: kMin,
      premiumLeverage,
      strikeStep,
    });
    const atClose = shortStraddlePremium({
      spot: cl,
      strike,
      entrySpot,
      entryCredit,
      entryMin,
      currentMin: kMin,
      premiumLeverage,
      strikeStep,
    });
    const worst = Math.max(atHigh, atLow, atClose);
    const best = Math.min(atHigh, atLow, atClose);

    if (hasPremiumTarget && targetCombined != null && best <= targetCombined) {
      exitIdx = k;
      exitSpot = cl;
      exitCombined = targetCombined;
      reason = 'TARGET';
      break;
    }

    const postRange = postEntryRange(dayBars, entryIdx, k);
    if (postRange != null && postRange >= entryIv * ivExpandStopMult) {
      exitIdx = k;
      exitSpot = cl;
      exitCombined = worst;
      reason = 'IV_EXPAND';
      break;
    }

    if (hasPremiumStop && stopCombined != null && worst >= stopCombined) {
      exitIdx = k;
      exitSpot = cl;
      exitCombined = stopCombined;
      reason = 'STOP_LOSS';
      break;
    }

    if (kMin >= EOD_EXIT) {
      exitIdx = k;
      exitSpot = cl;
      exitCombined = atClose;
      reason = 'DAY_CLOSE';
      break;
    }
  }

  return { exitIdx, exitSpot, exitCombined, reason, targetCombined, stopCombined };
}

/**
 * @param {{ candles: unknown[], settings: Record<string, unknown> }} args
 */
function runIvMeanReversionBacktest({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.5);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  const ivLookbackDays = Math.max(5, Math.min(60, Number(settings.ivLookbackDays) || 20));
  const ivSpikeMultiplier = Math.max(1.05, Number(settings.ivSpikeMultiplier) || 1.25);
  const maxSpikeMultiplier = Math.max(ivSpikeMultiplier + 0.1, Number(settings.maxSpikeMultiplier) || 2);
  const ivExpandStopMult = Math.max(1.2, Number(settings.ivExpandStopMult) || 1.5);

  const rawTg = settings.targetVolCrushPct;
  const hasPremiumTarget =
    rawTg != null && Number.isFinite(Number(rawTg)) && Number(rawTg) > 0;
  const targetVolCrushPct = hasPremiumTarget
    ? Math.min(90, Math.max(5, Number(rawTg)))
    : 0;

  const rawSl = settings.stopVolExpandPct;
  const hasPremiumStop =
    rawSl != null && Number.isFinite(Number(rawSl)) && Number(rawSl) > 0;
  const stopVolExpandPct = hasPremiumStop
    ? Math.min(200, Math.max(5, Number(rawSl)))
    : 0;

  const intraByDay = buildIntradayByDay(Array.isArray(candles) ? candles : []);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const orIvByDay = new Map();
  for (const dk of sortedKeys) {
    const bars = intraByDay.get(dk) || [];
    const v = orIvProxy(bars);
    if (v != null && v > 0) orIvByDay.set(dk, v);
  }

  const trades = [];

  for (let i = 0; i < sortedKeys.length; i += 1) {
    const dayKey = sortedKeys[i];
    const dayBars = intraByDay.get(dayKey) || [];
    if (dayBars.length < 5) continue;

    const histOr = [];
    for (let j = Math.max(0, i - ivLookbackDays); j < i; j += 1) {
      const v = orIvByDay.get(sortedKeys[j]);
      if (v != null) histOr.push(v);
    }
    if (histOr.length < 5) continue;
    const medianOrIv = median(histOr);

    const entry = findEntry({
      dayBars,
      medianOrIv,
      ivSpikeMultiplier,
      maxSpikeMultiplier,
    });
    if (!entry) continue;

    const { entryIdx, entryIv, medianIv } = entry;
    if (entryIdx >= dayBars.length - 1) continue;

    const entrySpot = Number(dayBars[entryIdx][4]);
    if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

    const strike = Math.round(entrySpot / strikeStep) * strikeStep;
    const legPrem = Math.max(0.05, (entrySpot * basePremiumPct) / 100);
    const entryCredit = legPrem * 2;

    const ex = simulateExit({
      dayBars,
      entryIdx,
      entrySpot,
      strike,
      entryCredit,
      entryIv,
      premiumLeverage,
      strikeStep,
      hasPremiumTarget,
      targetVolCrushPct,
      hasPremiumStop,
      stopVolExpandPct,
      ivExpandStopMult,
    });

    const qty = lotSize * lotCount;
    const credit = entryCredit * qty;
    const buyback = ex.exitCombined * qty;
    const rawPnl = credit - buyback;
    const pnl = rawPnl - perTradeCost;

    trades.push({
      pair: symbol,
      type: 'STRADDLE',
      strike,
      buyPrice: Number(ex.exitCombined.toFixed(2)),
      sellPrice: Number(entryCredit.toFixed(2)),
      lotSize,
      lots: lotCount,
      invested: Number(credit.toFixed(2)),
      finalValue: Number(buyback.toFixed(2)),
      closed: 'STRADDLE',
      order: 'SELL',
      entryTime: dayBars[entryIdx][0],
      exitTime: dayBars[ex.exitIdx][0],
      entryPrice: Number(entrySpot.toFixed(2)),
      exitPrice: Number(ex.exitSpot.toFixed(2)),
      stopLoss: hasPremiumStop && ex.stopCombined != null ? Number(ex.stopCombined.toFixed(2)) : null,
      target: hasPremiumTarget && ex.targetCombined != null ? Number(ex.targetCombined.toFixed(2)) : null,
      qty,
      premium: Number(entryCredit.toFixed(2)),
      lotCount,
      investmentAmount: Number(credit.toFixed(2)),
      stopLossAmount:
        hasPremiumStop && ex.stopCombined != null
          ? Number((Math.max(0, ex.stopCombined - entryCredit) * qty).toFixed(2))
          : null,
      targetAmount:
        hasPremiumTarget && ex.targetCombined != null
          ? Number((Math.max(0, entryCredit - ex.targetCombined) * qty).toFixed(2))
          : null,
      grossPnl: Number(rawPnl.toFixed(2)),
      charges: perTradeCost,
      pnl: Number(pnl.toFixed(2)),
      pnlPct: credit > 0 ? Number(((pnl / credit) * 100).toFixed(2)) : 0,
      reason: ex.reason,
      entryIvProxy: Number(entryIv.toFixed(2)),
      medianIvProxy: Number(medianIv.toFixed(2)),
    });
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = {
  runIvMeanReversionBacktest,
};

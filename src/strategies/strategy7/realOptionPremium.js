/**
 * Strategy 3 backtest — REAL option premium enrichment (live parity).
 *
 * The worker computes direction + entry/exit timing on the INDEX candles, but prices the
 * option with a synthetic proxy (`spot * basePremiumPct`). That diverges hard from live
 * (especially near expiry). This module runs in the MAIN process (where the Dhan token is
 * hydrated) AFTER the worker returns, and — for every day whose option contract is still
 * resolvable in the instrument master — replaces the entry premium with the real historical
 * option price and re-simulates the exit (SL / target / EOD) on the real option candles.
 *
 * Days whose contracts have already expired (not in the master) keep the synthetic model.
 */

const { getIstClock } = require('../../utils/dateTime');
const { fetchIntradayCandlesBySecurity } = require('../../services/dhanDataService');
const {
  resolveOptionInstrument,
  listOptionExpiriesFromMaster,
} = require('../../services/dhanLiveService');

const SESSION_START_MIN = 555; // 09:15 IST
const SESSION_END_MIN = 930; // 15:30 IST
const EOD_EXIT_MIN = 920; // 15:20 IST (matches simple920Backtest EOD_EXIT)
// A weekly option used for a same-day trade expires within a few days of that day. If the
// nearest available expiry is further out, the day's real contract is gone (expired) → fallback.
const MAX_EXPIRY_AHEAD_DAYS = 12;

function dayDiff(fromKey, toKey) {
  const a = new Date(`${fromKey}T00:00:00Z`).getTime();
  const b = new Date(`${toKey}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

/** Nearest expiry >= dayKey from the master, only if it's within the weekly window. */
function resolveBacktestExpiryForDay(dayKey, sortedExpiries) {
  for (const e of sortedExpiries) {
    if (e >= dayKey) {
      return dayDiff(dayKey, e) <= MAX_EXPIRY_AHEAD_DAYS ? e : null;
    }
  }
  return null;
}

function sessionFilter(rows) {
  return (rows || []).filter((c) => {
    const m = getIstClock(c[0]).minutes;
    return m >= SESSION_START_MIN && m <= SESSION_END_MIN;
  });
}

/** Index of the option bar matching the entry clock minute (last bar at/<= entry minute). */
function findEntryBarIdx(optionBars, entryMinutes) {
  let idx = -1;
  for (let i = 0; i < optionBars.length; i += 1) {
    const m = getIstClock(optionBars[i][0]).minutes;
    if (m <= entryMinutes) idx = i;
    else break;
  }
  return idx;
}

/**
 * Exit on REAL option candles. We hold a LONG option, so its own premium IS the P&L:
 * premium falling to stop = loss, rising to target = profit (true for both CE and PE).
 */
function simulateRealOptionExit({ optionBars, entryIdx, entryPremium, hasStopLoss, stopLossPoints, hasTarget, targetPoints }) {
  const stopPremium = hasStopLoss ? Math.max(0.05, entryPremium - stopLossPoints) : null;
  const targetPremium = hasTarget ? entryPremium + targetPoints : null;

  let exitIdx = optionBars.length - 1;
  let exitPremium = Number(optionBars[exitIdx][4]);
  let reason = 'DAY_CLOSE';

  for (let k = entryIdx + 1; k < optionBars.length; k += 1) {
    const hi = Number(optionBars[k][2]);
    const lo = Number(optionBars[k][3]);
    const cl = Number(optionBars[k][4]);
    if (![hi, lo, cl].every(Number.isFinite)) continue;

    if (hasStopLoss && stopPremium != null && lo <= stopPremium) {
      exitIdx = k;
      exitPremium = stopPremium;
      reason = 'STOP_LOSS';
      break;
    }
    if (hasTarget && targetPremium != null && hi >= targetPremium) {
      exitIdx = k;
      exitPremium = targetPremium;
      reason = 'TARGET';
      break;
    }
    if (getIstClock(optionBars[k][0]).minutes >= EOD_EXIT_MIN) {
      exitIdx = k;
      exitPremium = cl;
      reason = 'DAY_CLOSE';
      break;
    }
  }

  return { exitIdx, exitPremium, reason, stopPremium, targetPremium };
}

function reprice(trade, { entryPremium, exitPremium, exitTimeIso, reason, stopPremium, targetPremium }) {
  const lotSize = Number(trade.lotSize) || 0;
  const lotCount = Number(trade.lotCount || trade.lots) || 0;
  const perTradeCost = Number(trade.charges) || 0;
  const invested = entryPremium * lotSize * lotCount;
  const finalValue = exitPremium * lotSize * lotCount;
  const rawPnl = finalValue - invested;
  const pnl = rawPnl - perTradeCost;

  return {
    ...trade,
    buyPrice: Number(entryPremium.toFixed(2)),
    sellPrice: Number(exitPremium.toFixed(2)),
    premium: Number(entryPremium.toFixed(2)),
    invested: Number(invested.toFixed(2)),
    investmentAmount: Number(invested.toFixed(2)),
    finalValue: Number(finalValue.toFixed(2)),
    grossPnl: Number(rawPnl.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
    exitTime: exitTimeIso || trade.exitTime,
    reason,
    stopLoss: stopPremium != null ? Number(stopPremium.toFixed(2)) : trade.stopLoss,
    target: targetPremium != null ? Number(targetPremium.toFixed(2)) : trade.target,
    premiumSource: 'REAL',
  };
}

/**
 * Replace synthetic premiums with real Dhan option premiums where the contract is resolvable.
 * @returns {Promise<{ trades: object[], realCount: number, modelCount: number }>}
 */
async function enrichStrategySevenTradesWithRealPremiums({ trades, settings }) {
  const list = Array.isArray(trades) ? trades : [];
  if (list.length === 0) return { trades: list, realCount: 0, modelCount: 0 };

  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const interval = String(settings.interval || '5');
  const rawSl = Number(settings.stopLossPoints);
  const hasStopLoss = Number.isFinite(rawSl) && rawSl > 0;
  const stopLossPoints = hasStopLoss ? rawSl : 0;
  const rawTg = Number(settings.targetProfitPoints);
  const hasTarget = Number.isFinite(rawTg) && rawTg > 0;
  const targetPoints = hasTarget ? rawTg : 0;

  let sortedExpiries = [];
  try {
    sortedExpiries = await listOptionExpiriesFromMaster(symbol);
  } catch {
    // No master → everything stays on the model.
    return { trades: list.map((t) => ({ ...t, premiumSource: 'MODEL' })), realCount: 0, modelCount: list.length };
  }

  const optionBarsCache = new Map();
  const out = [];
  let realCount = 0;
  let modelCount = 0;

  for (const trade of list) {
    let enriched = null;
    try {
      const entryClock = getIstClock(trade.entryTime);
      const dayKey = entryClock.dateKey;
      const entryMinutes = entryClock.minutes;
      const optionType = String(trade.type || '').toUpperCase();
      const strike = Number(trade.strike);
      const expiry = resolveBacktestExpiryForDay(dayKey, sortedExpiries);

      if (expiry && (optionType === 'CE' || optionType === 'PE') && Number.isFinite(strike)) {
        const cacheKey = `${dayKey}|${expiry}|${strike}|${optionType}`;
        let optionBars = optionBarsCache.get(cacheKey);
        if (optionBars === undefined) {
          optionBars = await fetchOptionDayBars({ symbol, strike, expiry, optionType, interval, dateKey: dayKey });
          optionBarsCache.set(cacheKey, optionBars);
        }

        if (optionBars && optionBars.length) {
          const entryIdx = findEntryBarIdx(optionBars, entryMinutes);
          if (entryIdx >= 0) {
            const entryPremium = Number(optionBars[entryIdx][4]);
            if (Number.isFinite(entryPremium) && entryPremium > 0) {
              const exit = simulateRealOptionExit({
                optionBars,
                entryIdx,
                entryPremium,
                hasStopLoss,
                stopLossPoints,
                hasTarget,
                targetPoints,
              });
              enriched = reprice(trade, {
                entryPremium,
                exitPremium: exit.exitPremium,
                exitTimeIso: optionBars[exit.exitIdx][0],
                reason: exit.reason,
                stopPremium: exit.stopPremium,
                targetPremium: exit.targetPremium,
              });
            }
          }
        }
      }
    } catch {
      enriched = null;
    }

    if (enriched) {
      out.push(enriched);
      realCount += 1;
    } else {
      out.push({ ...trade, premiumSource: 'MODEL' });
      modelCount += 1;
    }
  }

  return { trades: out, realCount, modelCount };
}

async function fetchOptionDayBars({ symbol, strike, expiry, optionType, interval, dateKey }) {
  let inst;
  try {
    inst = await resolveOptionInstrument({ symbol, strike, expiry, optionType });
  } catch {
    return null;
  }
  if (!inst?.securityId) return null;
  const { rows } = await fetchIntradayCandlesBySecurity({
    securityId: inst.securityId,
    exchangeSegment: inst.exchangeSegment || 'NSE_FNO',
    instrument: 'OPTIDX',
    interval,
    dateKey,
  });
  const bars = sessionFilter(rows);
  return bars.length ? bars : null;
}

module.exports = {
  enrichStrategySevenTradesWithRealPremiums,
  resolveBacktestExpiryForDay,
  simulateRealOptionExit,
};

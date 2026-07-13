/**
 * Per-side stop-loss lockout for Trail Scalp (Strategy 5).
 * After N STOP_LOSS exits on PE (or CE) in a session, block new entries on that side only.
 */

const { getIstClock } = require('../../utils/dateTime');

const DEFAULT_MAX_LOSSES_PER_SIDE = 2;

function parseMaxLossesPerSidePerDay(settings = {}) {
  const raw = settings.maxLossesPerSidePerDay;
  if (raw === '' || raw === null || raw === undefined) {
    return DEFAULT_MAX_LOSSES_PER_SIDE;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(10, Math.floor(n));
}

/** @returns {number|null} null = unlimited daily entries */
function parseMaxTradesPerDayCap(settings = {}, fallback = null) {
  const raw = settings.maxTradesPerDay;
  if (raw === '' || raw === null || raw === undefined) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(100, Math.floor(n));
}

function isOptionSideLocked(optionType, { peSlCount = 0, ceSlCount = 0, maxLossesPerSidePerDay }) {
  if (maxLossesPerSidePerDay == null) return false;
  const side = String(optionType || 'PE').toUpperCase() === 'CE' ? 'CE' : 'PE';
  const count = side === 'PE' ? peSlCount : ceSlCount;
  return count >= maxLossesPerSidePerDay;
}

function sideLockSkipReason(optionType, lockState) {
  if (!isOptionSideLocked(optionType, lockState)) return null;
  return String(optionType || 'PE').toUpperCase() === 'CE' ? 'CE_SIDE_LOCKED' : 'PE_SIDE_LOCKED';
}

function countStopLossesBySide(trades = []) {
  let peSlCount = 0;
  let ceSlCount = 0;
  for (const t of trades) {
    if (String(t.reason || '').toUpperCase() !== 'STOP_LOSS') continue;
    if (String(t.optionType || 'PE').toUpperCase() === 'CE') ceSlCount += 1;
    else peSlCount += 1;
  }
  return { peSlCount, ceSlCount };
}

function bothSidesLocked(lockState) {
  const { maxLossesPerSidePerDay, peSlCount = 0, ceSlCount = 0 } = lockState;
  if (maxLossesPerSidePerDay == null) return false;
  return peSlCount >= maxLossesPerSidePerDay && ceSlCount >= maxLossesPerSidePerDay;
}

function tradeOptionSide(trade) {
  return String(trade?.type || trade?.optionType || 'PE').toUpperCase() === 'CE' ? 'CE' : 'PE';
}

function tradeDayKey(trade) {
  const raw = trade?.entryTime;
  if (!raw) return '';
  try {
    return getIstClock(raw).dateKey || '';
  } catch {
    return String(raw).slice(0, 10);
  }
}

/**
 * Drop same-side entries that would be illegal after Max SL / side / day,
 * using final exit reasons (e.g. after real-premium re-simulation).
 * Preserves chronological order; only STOP_LOSS increments the per-side count.
 */
function filterTradesByMaxLossesPerSidePerDay(trades = [], settings = {}) {
  const maxLossesPerSidePerDay = parseMaxLossesPerSidePerDay(settings);
  if (maxLossesPerSidePerDay == null) return Array.isArray(trades) ? [...trades] : [];

  const list = Array.isArray(trades) ? trades : [];
  const sorted = [...list].sort((a, b) => {
    const ta = new Date(a?.entryTime || 0).getTime();
    const tb = new Date(b?.entryTime || 0).getTime();
    return ta - tb;
  });

  const peSlByDay = new Map();
  const ceSlByDay = new Map();
  const kept = [];

  for (const trade of sorted) {
    const dayKey = tradeDayKey(trade) || '_';
    const side = tradeOptionSide(trade);
    const peSlCount = peSlByDay.get(dayKey) || 0;
    const ceSlCount = ceSlByDay.get(dayKey) || 0;

    if (isOptionSideLocked(side, { peSlCount, ceSlCount, maxLossesPerSidePerDay })) {
      continue;
    }

    kept.push(trade);

    if (String(trade.reason || '').toUpperCase() === 'STOP_LOSS') {
      if (side === 'CE') ceSlByDay.set(dayKey, ceSlCount + 1);
      else peSlByDay.set(dayKey, peSlCount + 1);
    }
  }

  return kept;
}

module.exports = {
  DEFAULT_MAX_LOSSES_PER_SIDE,
  parseMaxLossesPerSidePerDay,
  parseMaxTradesPerDayCap,
  isOptionSideLocked,
  sideLockSkipReason,
  countStopLossesBySide,
  bothSidesLocked,
  filterTradesByMaxLossesPerSidePerDay,
  tradeOptionSide,
};

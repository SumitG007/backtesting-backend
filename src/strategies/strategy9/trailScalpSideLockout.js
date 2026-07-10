/**
 * Per-side stop-loss lockout for Trail Scalp (Strategy 5).
 * After N STOP_LOSS exits on PE (or CE) in a session, block new entries on that side only.
 */

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

module.exports = {
  DEFAULT_MAX_LOSSES_PER_SIDE,
  parseMaxLossesPerSidePerDay,
  parseMaxTradesPerDayCap,
  isOptionSideLocked,
  sideLockSkipReason,
  countStopLossesBySide,
  bothSidesLocked,
};

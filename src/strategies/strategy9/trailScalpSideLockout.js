/**
 * Per-side stop-loss lockout for Trail Scalp (Strategy 5).
 * DISABLED: Max SL / side / day was removed — always allow entries.
 * Helpers remain for legacy callers / tests but never lock.
 */

const DEFAULT_MAX_LOSSES_PER_SIDE = null;

/** Always null — side lockout is off for backtest and paper live. */
function parseMaxLossesPerSidePerDay(_settings = {}) {
  return null;
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

function isOptionSideLocked(_optionType, _lockState) {
  return false;
}

function sideLockSkipReason(_optionType, _lockState) {
  return null;
}

function countStopLossesBySide(trades = []) {
  let peSlCount = 0;
  let ceSlCount = 0;
  for (const t of trades) {
    if (String(t.reason || '').toUpperCase() !== 'STOP_LOSS') continue;
    if (String(t.type || t.optionType || 'PE').toUpperCase() === 'CE') ceSlCount += 1;
    else peSlCount += 1;
  }
  return { peSlCount, ceSlCount };
}

function bothSidesLocked(_lockState) {
  return false;
}

function tradeOptionSide(trade) {
  return String(trade?.type || trade?.optionType || 'PE').toUpperCase() === 'CE' ? 'CE' : 'PE';
}

/** No-op identity filter — side lockout disabled. */
function filterTradesByMaxLossesPerSidePerDay(trades = [], _settings = {}) {
  return Array.isArray(trades) ? [...trades] : [];
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

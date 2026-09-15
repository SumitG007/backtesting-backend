/**
 * Broker margin proxy for short straddle (sell CE + sell PE).
 * Premium credit alone understates capital at risk vs SPAN + exposure minus hedge benefit.
 */

/** Gross margin as % of spot notional per qty unit (both legs, before straddle offset). */
const DEFAULT_GROSS_MARGIN_PCT = 10;
/** Approximate % reduction when CE+PE are margined as a straddle. */
const DEFAULT_STRADDLE_HEDGE_BENEFIT_PCT = 40;

/**
 * @param {object} params
 * @param {number} params.entrySpot - Index spot at entry
 * @param {number} params.lotSize - Units per lot
 * @param {number} [params.lotCount=1] - Number of lots
 * @param {Record<string, unknown>} [params.settings] - Optional grossMarginPct, straddleHedgeBenefitPct
 * @returns {number} Estimated margin blocked (Rs)
 */
function shortStraddleMarginBlocked({ entrySpot, lotSize, lotCount = 1, settings = {} }) {
  const spot = Number(entrySpot);
  if (!Number.isFinite(spot) || spot <= 0) return 0;

  const lots = Math.max(1, Number(lotCount) || 1);
  const units = Math.max(1, Number(lotSize) || 1) * lots;

  const rawGross = Number(settings.grossMarginPct);
  const grossPct = Number.isFinite(rawGross) && rawGross > 0
    ? Math.min(25, rawGross)
    : DEFAULT_GROSS_MARGIN_PCT;

  const rawHedge = Number(settings.straddleHedgeBenefitPct);
  const hedgePct = Number.isFinite(rawHedge) && rawHedge >= 0
    ? Math.min(90, rawHedge)
    : DEFAULT_STRADDLE_HEDGE_BENEFIT_PCT;

  const netMarginPct = grossPct * (1 - hedgePct / 100);
  return spot * (netMarginPct / 100) * units;
}

module.exports = {
  shortStraddleMarginBlocked,
  DEFAULT_GROSS_MARGIN_PCT,
  DEFAULT_STRADDLE_HEDGE_BENEFIT_PCT,
};

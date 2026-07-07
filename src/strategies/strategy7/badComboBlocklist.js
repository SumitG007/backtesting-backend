/**
 * Strategy 3 — signal combos with negative multi-year expectancy (2022–2026).
 * Skip at entry when the fired PE/CE pattern matches the blocklist (no lookahead).
 */

/** @type {ReadonlySet<string>} */
const BLOCKED_SIGNAL_COMBOS = new Set([
  'PE|below_open+gap_up_fade+orb_low_break+pdl_break',
  'PE|below_open+orb_low_break+pdl_break',
  'PE|below_open+gap_down+pdl_break',
  'CE|above_open+gap_up+pdh_break',
]);

function buildSignalComboKey(optionType, signals) {
  const type = String(optionType || '').toUpperCase();
  const sorted = [...(Array.isArray(signals) ? signals : [])].sort().join('+');
  return `${type}|${sorted}`;
}

function isBlockedSignalCombo(optionType, signals) {
  return BLOCKED_SIGNAL_COMBOS.has(buildSignalComboKey(optionType, signals));
}

module.exports = {
  BLOCKED_SIGNAL_COMBOS,
  buildSignalComboKey,
  isBlockedSignalCombo,
};

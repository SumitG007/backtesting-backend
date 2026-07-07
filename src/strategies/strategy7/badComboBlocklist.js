/**
 * Strategy 3 — built-in probability blocklist (2022–2026 research).
 * Skip at entry when the fired PE/CE pattern matches (no lookahead).
 *
 * Tier 1 — negative expectancy combos
 * Tier 2 — high SL-rate combos (≥60% stop-loss, min 12 trades)
 */

/** @type {ReadonlySet<string>} */
const BLOCKED_SIGNAL_COMBOS = new Set([
  // Tier 1 — net loss over 2022–2026
  'PE|below_open+gap_up_fade+orb_low_break+pdl_break',
  'PE|below_open+orb_low_break+pdl_break',
  'PE|below_open+gap_down+pdl_break',
  'CE|above_open+gap_up+pdh_break',
  // Tier 2 — high SL probability (fewer SL days, small profit trade-off)
  'CE|above_open+orb_high_break+pdh_break', // 67% SL
  'PE|below_open+orb_low_break', // 64% SL
  'CE|gap_up+orb_high_break+pdh_break', // 58% SL, negative net
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

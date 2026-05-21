/**
 * Strategy 7 scenarios — data-mined patterns, multi-year monthly evaluation.
 */

const { STRATEGY_CATALOG } = require('../catalog');

const BASE = { ...STRATEGY_CATALOG[7].defaults };

/** @type {{ id: string, name: string, settings: Record<string, unknown> }[]} */
const STRATEGY_SEVEN_SCENARIOS = [
  { id: 'D01', name: 'Combined (all mined rules) SL25 TG50', settings: { ...BASE } },
  { id: 'D02', name: 'ORB30 PE only SL25 TG50', settings: { ...BASE, patternMode: 'orb30_pe' } },
  { id: 'D03', name: 'ORB30 CE only SL25 TG50', settings: { ...BASE, patternMode: 'orb30_ce' } },
  { id: 'D04', name: 'First hour PE SL25 TG50', settings: { ...BASE, patternMode: 'first_hour_pe' } },
  { id: 'D05', name: 'First hour CE SL25 TG50', settings: { ...BASE, patternMode: 'first_hour_ce' } },
  { id: 'D06', name: 'PDH break CE SL25 TG50', settings: { ...BASE, patternMode: 'pdh_ce' } },
  { id: 'D07', name: 'PDL break PE SL18 TG35', settings: { ...BASE, patternMode: 'pdl_pe', stopLossPoints: 18, targetProfitPoints: 35 } },
  { id: 'D08', name: 'PE pack (ORB+PDL+FH+gap) SL25 TG50', settings: { ...BASE, patternMode: 'pe_pack' } },
  { id: 'D09', name: 'CE pack SL25 TG50', settings: { ...BASE, patternMode: 'ce_pack' } },
  { id: 'D10', name: 'ORB30 PE SL18 TG40', settings: { ...BASE, patternMode: 'orb30_pe', stopLossPoints: 18, targetProfitPoints: 40 } },
  { id: 'D11', name: 'First hour PE SL18 TG40', settings: { ...BASE, patternMode: 'first_hour_pe', stopLossPoints: 18, targetProfitPoints: 40 } },
  { id: 'D12', name: 'Combined SL20 TG45', settings: { ...BASE, stopLossPoints: 20, targetProfitPoints: 45 } },
];

/** Best monthly >=5k on 2022–26 matrix (17/53). */
let STRATEGY_SEVEN_PRODUCTION_ID = 'D04';

function getScenarioById(id) {
  return STRATEGY_SEVEN_SCENARIOS.find((s) => s.id === id) || null;
}

module.exports = {
  STRATEGY_SEVEN_SCENARIOS,
  STRATEGY_SEVEN_PRODUCTION_ID,
  getScenarioById,
};

/**
 * Strategy 4 scenario matrix — tune SL/TG + first-hour filters (2023 focus).
 */

const BASE = {
  symbol: 'NIFTY',
  interval: '5',
  strikeMode: 'ATM',
  stopLossPoints: 18,
  targetProfitPoints: 80,
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 1,
  perTradeCost: 100,
  entryFromTime: '10:00',
  entryToTime: '11:00',
  tradeSide: 'both',
};

/** @type {{ id: string, name: string, settings: Record<string, unknown> }[]} */
const STRATEGY_FOUR_SCENARIOS = [
  { id: 'F01', name: 'Production SL18 TG80', settings: { ...BASE } },
  { id: 'F02', name: 'SL25 TG50', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 50 } },
  { id: 'F03', name: 'SL20 TG45', settings: { ...BASE, stopLossPoints: 20, targetProfitPoints: 45 } },
  { id: 'F04', name: 'SL15 TG60', settings: { ...BASE, stopLossPoints: 15, targetProfitPoints: 60 } },
  { id: 'F05', name: 'SL22 TG70', settings: { ...BASE, stopLossPoints: 22, targetProfitPoints: 70 } },
  { id: 'F06', name: 'SL18 TG50', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 50 } },
  { id: 'F07', name: 'PE only SL18 TG80', settings: { ...BASE, tradeSide: 'pe_only' } },
  { id: 'F08', name: 'CE only SL18 TG80', settings: { ...BASE, tradeSide: 'ce_only' } },
  { id: 'F09', name: 'PE only SL25 TG50', settings: { ...BASE, tradeSide: 'pe_only', stopLossPoints: 25, targetProfitPoints: 50 } },
  { id: 'F10', name: 'Min FH move 0.12% SL18 TG80', settings: { ...BASE, minFirstHourMovePct: 0.12 } },
  { id: 'F11', name: 'Min FH move 0.20% SL18 TG80', settings: { ...BASE, minFirstHourMovePct: 0.2 } },
  { id: 'F12', name: 'Min FH move 12pts SL18 TG80', settings: { ...BASE, minFirstHourMovePoints: 12 } },
  { id: 'F13', name: 'Min FH range 30pts SL18 TG80', settings: { ...BASE, minFirstHourRangePoints: 30 } },
  { id: 'F14', name: 'Min FH range 45pts SL18 TG80', settings: { ...BASE, minFirstHourRangePoints: 45 } },
  {
    id: 'F15',
    name: 'PE min move 0.15% + range 25 SL25 TG50',
    settings: {
      ...BASE,
      tradeSide: 'pe_only',
      minFirstHourMovePct: 0.15,
      minFirstHourRangePoints: 25,
      stopLossPoints: 25,
      targetProfitPoints: 50,
    },
  },
  {
    id: 'F16',
    name: 'PE min move 0.12% SL20 TG45',
    settings: { ...BASE, tradeSide: 'pe_only', minFirstHourMovePct: 0.12, stopLossPoints: 20, targetProfitPoints: 45 },
  },
  { id: 'F17', name: 'Entry 10:15 SL18 TG80', settings: { ...BASE, entryFromTime: '10:15' } },
  { id: 'F18', name: 'Entry 10:05 SL18 TG80', settings: { ...BASE, entryFromTime: '10:05' } },
  { id: 'F19', name: 'Skip gap>0.5% SL18 TG80', settings: { ...BASE, maxGapPct: 0.5 } },
  { id: 'F20', name: 'Skip gap-up PE (fade) SL18 TG80', settings: { ...BASE, skipGapUpPe: true } },
  { id: 'F21', name: 'Skip gap-down CE SL18 TG80', settings: { ...BASE, skipGapDownCe: true } },
  {
    id: 'F22',
    name: 'PE chop filter + SL25 TG50',
    settings: {
      ...BASE,
      tradeSide: 'pe_only',
      minFirstHourMovePct: 0.1,
      minFirstHourRangePoints: 28,
      maxGapPct: 0.45,
      stopLossPoints: 25,
      targetProfitPoints: 50,
    },
  },
  {
    id: 'F23',
    name: 'Both strong FH only SL20 TG50',
    settings: {
      ...BASE,
      minFirstHourMovePct: 0.15,
      minFirstHourRangePoints: 35,
      stopLossPoints: 20,
      targetProfitPoints: 50,
    },
  },
  { id: 'F24', name: 'OTM SL18 TG80', settings: { ...BASE, strikeMode: 'OTM' } },
  { id: 'F25', name: 'Leverage 6 SL18 TG80', settings: { ...BASE, premiumLeverage: 6 } },
  {
    id: 'F26',
    name: '★ SL22 TG70 (best 5yr, softer 2023)',
    settings: { ...BASE, stopLossPoints: 22, targetProfitPoints: 70 },
  },
  {
    id: 'F27',
    name: 'PE needs 0.15% move, CE open SL22 TG70',
    settings: {
      ...BASE,
      peMinFirstHourMovePct: 0.15,
      peMinFirstHourRangePoints: 22,
      stopLossPoints: 22,
      targetProfitPoints: 70,
    },
  },
  {
    id: 'F28',
    name: 'PE needs 0.12% + range 28, CE open SL18 TG80',
    settings: {
      ...BASE,
      peMinFirstHourMovePct: 0.12,
      peMinFirstHourRangePoints: 28,
    },
  },
  {
    id: 'F29',
    name: 'Skip gap-up on PE days SL22 TG70',
    settings: { ...BASE, skipGapUpPe: true, stopLossPoints: 22, targetProfitPoints: 70 },
  },
];

/** Green 2023 + strong 5yr: skip PE when gap-up >0.15%, SL22/TG70. */
let STRATEGY_FOUR_PRODUCTION_ID = 'F29';

function getScenarioById(id) {
  return STRATEGY_FOUR_SCENARIOS.find((s) => s.id === id) || null;
}

module.exports = {
  STRATEGY_FOUR_SCENARIOS,
  STRATEGY_FOUR_PRODUCTION_ID,
  getScenarioById,
};

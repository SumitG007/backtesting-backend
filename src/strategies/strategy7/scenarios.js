/**
 * Strategy 3 — Put & Call buy: SL / target / EOD scenario matrix.
 * targetProfitPoints: 0 = day close only (15:20 IST).
 */

const BASE = {
  symbol: 'NIFTY',
  interval: '5',
  entryTime: '11:15',
  entryFromTime: '11:15',
  entryToTime: '11:15',
  strikeMode: 'ATM',
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 10,
  perTradeCost: 100,
  minDirectionScore: 2,
  stopLossPoints: 15,
  targetProfitPoints: 150,
};

/** @type {{ id: string, name: string, settings: Record<string, unknown> }[]} */
const STRATEGY_THREE_SCENARIOS = [
  { id: 'S01', name: 'SL15 TG150 (production default)', settings: { ...BASE } },
  { id: 'S02', name: 'SL15 TG30', settings: { ...BASE, targetProfitPoints: 30 } },
  { id: 'S03', name: 'SL15 TG50', settings: { ...BASE, targetProfitPoints: 50 } },
  { id: 'S04', name: 'SL15 TG80', settings: { ...BASE, targetProfitPoints: 80 } },
  { id: 'S05', name: 'SL15 TG100', settings: { ...BASE, targetProfitPoints: 100 } },
  { id: 'S06', name: 'SL10 EOD', settings: { ...BASE, stopLossPoints: 10 } },
  { id: 'S07', name: 'SL10 TG40', settings: { ...BASE, stopLossPoints: 10, targetProfitPoints: 40 } },
  { id: 'S08', name: 'SL10 TG80', settings: { ...BASE, stopLossPoints: 10, targetProfitPoints: 80 } },
  { id: 'S09', name: 'SL20 EOD', settings: { ...BASE, stopLossPoints: 20 } },
  { id: 'S10', name: 'SL20 TG50', settings: { ...BASE, stopLossPoints: 20, targetProfitPoints: 50 } },
  { id: 'S11', name: 'SL20 TG100', settings: { ...BASE, stopLossPoints: 20, targetProfitPoints: 100 } },
  { id: 'S12', name: 'SL25 EOD', settings: { ...BASE, stopLossPoints: 25 } },
  { id: 'S13', name: 'SL25 TG50', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 50 } },
  { id: 'S14', name: 'SL25 TG80', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 80 } },
  { id: 'S15', name: 'SL30 EOD', settings: { ...BASE, stopLossPoints: 30 } },
  { id: 'S16', name: 'SL30 TG60', settings: { ...BASE, stopLossPoints: 30, targetProfitPoints: 60 } },
  { id: 'S17', name: 'SL12 TG45', settings: { ...BASE, stopLossPoints: 12, targetProfitPoints: 45 } },
  { id: 'S18', name: 'SL18 TG70', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 70 } },
  { id: 'S19', name: 'SL22 EOD', settings: { ...BASE, stopLossPoints: 22 } },
  { id: 'S20', name: 'SL15 TG150', settings: { ...BASE, targetProfitPoints: 150 } },
];

module.exports = {
  STRATEGY_THREE_BASE: BASE,
  STRATEGY_THREE_SCENARIOS,
};

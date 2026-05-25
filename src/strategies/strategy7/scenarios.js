/**
 * Strategy 5 (Kukki V2) — multi-scenario matrix for 2022–2026 tuning.
 * Primary goal: maximum calendar months with net PnL > 0 (monthly green).
 */

const { STRATEGY_CATALOG } = require('../catalog');

const BASE = { ...STRATEGY_CATALOG[5].defaults };

/** @typedef {{ id: string, name: string, settings: Record<string, unknown> }} ScenarioDef */

/** @type {ScenarioDef[]} */
const HANDCRAFTED = [
  {
    id: 'P01',
    name: 'Production — catalog default (SL20, no TG, 10:30–14:30)',
    settings: { ...BASE },
  },
  {
    id: 'P02',
    name: 'Close only — no SL/TG (legacy default)',
    settings: { ...BASE, stopLossPoints: 0, targetProfitPoints: 0 },
  },
  // --- Entry window (fix mid-year chop) ---
  { id: 'E01', name: 'SL20 TG80 entry 11:00–14:00', settings: { ...BASE, targetProfitPoints: 80, entryFromTime: '11:00', entryToTime: '14:00' } },
  { id: 'E02', name: 'SL20 TG80 entry 10:00–14:00', settings: { ...BASE, targetProfitPoints: 80, entryFromTime: '10:00', entryToTime: '14:00' } },
  { id: 'E03', name: 'SL20 TG60 entry 11:30–14:15', settings: { ...BASE, targetProfitPoints: 60, entryFromTime: '11:30', entryToTime: '14:15' } },
  { id: 'E04', name: 'SL15 TG100 entry 10:30–13:30', settings: { ...BASE, stopLossPoints: 15, targetProfitPoints: 100, entryToTime: '13:30' } },
  { id: 'E05', name: 'SL18 TG80 entry 10:45–14:30', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 80, entryFromTime: '10:45' } },
  // --- Trade frequency ---
  { id: 'F01', name: 'SL20 TG80 max 2 trades/day', settings: { ...BASE, targetProfitPoints: 80, maxTradesPerDay: 2, minBarsBetweenTrades: 4 } },
  { id: 'F02', name: 'SL20 TG80 max 3 trades/day', settings: { ...BASE, targetProfitPoints: 80, maxTradesPerDay: 3, minBarsBetweenTrades: 3 } },
  { id: 'F03', name: 'SL20 TG80 max 1 trade/day', settings: { ...BASE, targetProfitPoints: 80, maxTradesPerDay: 1, minBarsBetweenTrades: 6 } },
  { id: 'F04', name: 'SL25 TG100 max 2/day', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 100, maxTradesPerDay: 2, minBarsBetweenTrades: 4 } },
  // --- Stricter trend / breakout ---
  { id: 'T01', name: 'SL20 TG80 minAdx 25', settings: { ...BASE, targetProfitPoints: 80, minAdx: 25 } },
  { id: 'T02', name: 'SL20 TG80 minAdx 30', settings: { ...BASE, targetProfitPoints: 80, minAdx: 30 } },
  { id: 'T03', name: 'SL20 TG80 break 5 bars', settings: { ...BASE, targetProfitPoints: 80, breakLookbackBars: 5 } },
  { id: 'T04', name: 'SL18 TG100 minAdx 25 break 4', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 100, minAdx: 25, breakLookbackBars: 4 } },
  { id: 'T05', name: 'SL15 TG120 minAdx 28', settings: { ...BASE, stopLossPoints: 15, targetProfitPoints: 120, minAdx: 28 } },
  // --- EMA / MACD sensitivity ---
  { id: 'M01', name: 'SL20 TG80 EMA 8/34', settings: { ...BASE, targetProfitPoints: 80, emaFast: 8, emaSlow: 34 } },
  { id: 'M02', name: 'SL20 TG80 EMA 12/26', settings: { ...BASE, targetProfitPoints: 80, emaFast: 12, emaSlow: 26 } },
  // --- Huge targets (runner hits, fewer day-close exits) ---
  { id: 'H01', name: 'SL20 TG150', settings: { ...BASE, targetProfitPoints: 150 } },
  { id: 'H02', name: 'SL25 TG200', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 200 } },
  { id: 'H03', name: 'SL15 TG200', settings: { ...BASE, stopLossPoints: 15, targetProfitPoints: 200 } },
  { id: 'H04', name: 'SL30 TG250', settings: { ...BASE, stopLossPoints: 30, targetProfitPoints: 250 } },
  { id: 'H05', name: 'SL12 TG180 max 3/day', settings: { ...BASE, stopLossPoints: 12, targetProfitPoints: 180, maxTradesPerDay: 3 } },
  // --- Tight SL + moderate TG (cut losers in bad years) ---
  { id: 'S01', name: 'SL8 TG50', settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 50 } },
  { id: 'S02', name: 'SL10 TG60', settings: { ...BASE, stopLossPoints: 10, targetProfitPoints: 60 } },
  { id: 'S03', name: 'SL12 TG70', settings: { ...BASE, stopLossPoints: 12, targetProfitPoints: 70 } },
  { id: 'S04', name: 'SL15 TG80', settings: { ...BASE, stopLossPoints: 15, targetProfitPoints: 80 } },
  { id: 'S05', name: 'SL18 TG90', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 90 } },
  // --- Wide SL + big TG ---
  { id: 'W01', name: 'SL30 TG80', settings: { ...BASE, stopLossPoints: 30, targetProfitPoints: 80 } },
  { id: 'W02', name: 'SL35 TG120', settings: { ...BASE, stopLossPoints: 35, targetProfitPoints: 120 } },
  { id: 'W03', name: 'SL25 TG150 max 2/day', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 150, maxTradesPerDay: 2 } },
  // --- SL only (no target, ride to close) ---
  { id: 'L01', name: 'SL12 only', settings: { ...BASE, stopLossPoints: 12, targetProfitPoints: 0 } },
  { id: 'L02', name: 'SL18 only', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 0 } },
  { id: 'L03', name: 'SL25 only', settings: { ...BASE, stopLossPoints: 25, targetProfitPoints: 0 } },
  // --- Combined best-guess packs for weak years ---
  {
    id: 'B01',
    name: 'SL15 TG80 11:00–14:00 max2 minAdx25',
    settings: {
      ...BASE,
      stopLossPoints: 15,
      targetProfitPoints: 80,
      entryFromTime: '11:00',
      entryToTime: '14:00',
      maxTradesPerDay: 2,
      minBarsBetweenTrades: 4,
      minAdx: 25,
    },
  },
  {
    id: 'B02',
    name: 'SL18 TG100 10:45–14:00 max3 minAdx25 break4',
    settings: {
      ...BASE,
      stopLossPoints: 18,
      targetProfitPoints: 100,
      entryFromTime: '10:45',
      entryToTime: '14:00',
      maxTradesPerDay: 3,
      minAdx: 25,
      breakLookbackBars: 4,
    },
  },
  {
    id: 'B03',
    name: 'SL20 TG120 11:00–13:45 max2',
    settings: {
      ...BASE,
      targetProfitPoints: 120,
      entryFromTime: '11:00',
      entryToTime: '13:45',
      maxTradesPerDay: 2,
      minBarsBetweenTrades: 4,
    },
  },
];

/** Monthly-green pack — fewer trades, tighter windows (rank by positiveMonths in runner). */
const MONTHLY_BASE = {
  symbol: 'NIFTY',
  interval: '5',
  strikeMode: 'ATM',
  stopLossPoints: 20,
  targetProfitPoints: 80,
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 1,
  perTradeCost: 100,
  entryFromTime: '11:00',
  entryToTime: '14:00',
  maxTradesPerDay: 1,
  minBarsBetweenTrades: 6,
  emaFast: 9,
  emaSlow: 21,
  adxLength: 14,
  adxSmoothing: 10,
  minAdx: 20,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  breakLookbackBars: 3,
  usePatternExits: false,
};

/** @type {ScenarioDef[]} */
const MONTHLY_SCENARIOS = [
  { id: 'Z01', name: 'Monthly E01 max1 (SL20 TG80 11–14)', settings: { ...MONTHLY_BASE } },
  { id: 'Z02', name: 'Monthly SL15 TG60 max1 11–14', settings: { ...MONTHLY_BASE, stopLossPoints: 15, targetProfitPoints: 60 } },
  { id: 'Z03', name: 'Monthly SL18 TG50 max1 11–14', settings: { ...MONTHLY_BASE, stopLossPoints: 18, targetProfitPoints: 50 } },
  { id: 'Z04', name: 'Monthly SL12 TG40 max1 11–14', settings: { ...MONTHLY_BASE, stopLossPoints: 12, targetProfitPoints: 40 } },
  { id: 'Z05', name: 'Monthly SL20 TG50 max1 11–14', settings: { ...MONTHLY_BASE, targetProfitPoints: 50 } },
  { id: 'Z06', name: 'Monthly SL20 TG80 max2 11–14', settings: { ...MONTHLY_BASE, maxTradesPerDay: 2, minBarsBetweenTrades: 4 } },
  { id: 'Z07', name: 'Monthly minAdx25 max1 11–14', settings: { ...MONTHLY_BASE, minAdx: 25 } },
  { id: 'Z08', name: 'Monthly minAdx25 max2 11–14', settings: { ...MONTHLY_BASE, minAdx: 25, maxTradesPerDay: 2, minBarsBetweenTrades: 4 } },
  { id: 'Z09', name: 'Monthly SL20 TG80 11–13:30 max1', settings: { ...MONTHLY_BASE, entryToTime: '13:30' } },
  { id: 'Z10', name: 'Monthly SL20 TG60 11–13:30 max1', settings: { ...MONTHLY_BASE, targetProfitPoints: 60, entryToTime: '13:30' } },
  { id: 'Z11', name: 'Monthly SL20 TG80 11:15–13:45 max1', settings: { ...MONTHLY_BASE, entryFromTime: '11:15', entryToTime: '13:45' } },
  { id: 'Z12', name: 'Monthly SL20 TG100 max1 11–14', settings: { ...MONTHLY_BASE, targetProfitPoints: 100 } },
  { id: 'Z13', name: 'Monthly SL25 TG80 max1 11–14', settings: { ...MONTHLY_BASE, stopLossPoints: 25 } },
  { id: 'Z14', name: 'Monthly B03 window max1 (TG120 11–13:45)', settings: { ...MONTHLY_BASE, targetProfitPoints: 120, entryToTime: '13:45' } },
  { id: 'Z15', name: 'Monthly B03 SL18 TG80 max1', settings: { ...MONTHLY_BASE, stopLossPoints: 18, entryToTime: '13:45' } },
  { id: 'Z16', name: 'Monthly M01 EMA8/34 max1 11–14', settings: { ...MONTHLY_BASE, emaFast: 8, emaSlow: 34 } },
  { id: 'Z17', name: 'Monthly M01 EMA8/34 max2 11–14', settings: { ...MONTHLY_BASE, emaFast: 8, emaSlow: 34, maxTradesPerDay: 2, minBarsBetweenTrades: 4 } },
  { id: 'Z18', name: 'Monthly SL20 TG80 10:30–13:30 max1', settings: { ...MONTHLY_BASE, entryFromTime: '10:30', entryToTime: '13:30' } },
  { id: 'Z19', name: 'Monthly SL15 TG45 11–13:45 max1', settings: { ...MONTHLY_BASE, stopLossPoints: 15, targetProfitPoints: 45, entryToTime: '13:45' } },
  { id: 'Z20', name: 'Monthly SL10 TG50 11–13:45 max1', settings: { ...MONTHLY_BASE, stopLossPoints: 10, targetProfitPoints: 50, entryToTime: '13:45' } },
  { id: 'Z21', name: 'Monthly SL20 TG80 break5 max1', settings: { ...MONTHLY_BASE, breakLookbackBars: 5 } },
  { id: 'Z22', name: 'Monthly SL18 TG70 max1 11:30–13:30', settings: { ...MONTHLY_BASE, stopLossPoints: 18, targetProfitPoints: 70, entryFromTime: '11:30', entryToTime: '13:30' } },
  { id: 'Z23', name: 'Monthly SL20 TG80 charges80 max1', settings: { ...MONTHLY_BASE, perTradeCost: 80 } },
  { id: 'Z24', name: 'Monthly SL8 TG35 max1 11–13:45', settings: { ...MONTHLY_BASE, stopLossPoints: 8, targetProfitPoints: 35, entryToTime: '13:45' } },
];

/** SL × TG grid (premium points). */
const SL_TG_PAIRS = [
  [5, 40],
  [5, 80],
  [8, 50],
  [8, 80],
  [8, 120],
  [10, 40],
  [10, 60],
  [10, 80],
  [10, 100],
  [10, 150],
  [12, 50],
  [12, 80],
  [12, 120],
  [15, 60],
  [15, 90],
  [15, 120],
  [18, 50],
  [18, 80],
  [18, 100],
  [18, 150],
  [20, 40],
  [20, 60],
  [20, 80],
  [20, 100],
  [20, 120],
  [20, 150],
  [20, 200],
  [22, 80],
  [22, 120],
  [25, 60],
  [25, 80],
  [25, 100],
  [25, 150],
  [28, 100],
  [28, 150],
  [30, 80],
  [30, 120],
  [30, 150],
  [30, 200],
  [35, 150],
  [40, 200],
];

/** @type {ScenarioDef[]} */
const GRID_SCENARIOS = SL_TG_PAIRS.map(([sl, tg], i) => ({
  id: `G${String(i + 1).padStart(2, '0')}`,
  name: `Grid SL${sl} TG${tg}`,
  settings: { ...BASE, stopLossPoints: sl, targetProfitPoints: tg },
}));

/** @type {ScenarioDef[]} */
const STRATEGY_FIVE_KUKKI_SCENARIOS = [...HANDCRAFTED, ...MONTHLY_SCENARIOS, ...GRID_SCENARIOS];

let STRATEGY_FIVE_PRODUCTION_ID = 'Z16';

function setProductionScenarioId(id) {
  if (STRATEGY_FIVE_KUKKI_SCENARIOS.some((s) => s.id === id)) {
    STRATEGY_FIVE_PRODUCTION_ID = id;
  }
}

function getProductionScenario() {
  return (
    STRATEGY_FIVE_KUKKI_SCENARIOS.find((s) => s.id === STRATEGY_FIVE_PRODUCTION_ID) ||
    STRATEGY_FIVE_KUKKI_SCENARIOS[0]
  );
}

module.exports = {
  BASE,
  STRATEGY_FIVE_KUKKI_SCENARIOS,
  STRATEGY_FIVE_PRODUCTION_ID,
  setProductionScenarioId,
  getProductionScenario,
};

/**
 * Strategy 6 backtest scenarios — genuine PE model, 1 trade/day enforced in engine.
 */

const { STRATEGY_CATALOG } = require('../catalog');

const BASE = { ...STRATEGY_CATALOG[4].defaults };

/** Best honest matrix: SL18/TG80 — highest 5yr net + most months >=5k. */
let STRATEGY_SIX_PRODUCTION_ID = 'C02';

/** @typedef {{ id: string, name: string, settings: Record<string, unknown> }} ScenarioDef */

/** @type {ScenarioDef[]} */
const STRATEGY_SIX_SCENARIOS = [
  // --- Current production baseline ---
  {
    id: 'P10',
    name: 'Production — balanced SL18 TG80 (catalog default)',
    settings: { ...BASE },
  },
  { id: 'C02', name: 'Balanced SL18 TG80 (best matrix)', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 80 } },
  // --- SL / target grid (1 trade/day, balanced) ---
  { id: 'N01', name: 'Balanced SL5 TG50', settings: { ...BASE, stopLossPoints: 5, targetProfitPoints: 50 } },
  { id: 'N02', name: 'Balanced SL5 TG80', settings: { ...BASE, stopLossPoints: 5, targetProfitPoints: 80 } },
  { id: 'N03', name: 'Balanced SL6 TG60', settings: { ...BASE, stopLossPoints: 6, targetProfitPoints: 60 } },
  { id: 'N04', name: 'Balanced SL8 TG80', settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80 } },
  { id: 'N05', name: 'Balanced SL8 TG100', settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 100 } },
  { id: 'N06', name: 'Balanced SL10 TG100', settings: { ...BASE, stopLossPoints: 10, targetProfitPoints: 100 } },
  { id: 'N07', name: 'Balanced SL12 TG120', settings: { ...BASE, stopLossPoints: 12, targetProfitPoints: 120 } },
  { id: 'N08', name: 'Balanced SL15 TG90', settings: { ...BASE, stopLossPoints: 15, targetProfitPoints: 90 } },
  { id: 'N09', name: 'Balanced SL18 TG60', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 60 } },
  // --- Signal mode (fewer / different entries) ---
  { id: 'N10', name: 'Wedge-only SL8 TG80', settings: { ...BASE, signalMode: 'wedge', stopLossPoints: 8, targetProfitPoints: 80 } },
  { id: 'N11', name: 'Wedge-only SL5 TG100', settings: { ...BASE, signalMode: 'wedge', stopLossPoints: 5, targetProfitPoints: 100 } },
  { id: 'N12', name: 'Channel-only SL8 TG80', settings: { ...BASE, signalMode: 'channel', stopLossPoints: 8, targetProfitPoints: 80 } },
  { id: 'N13', name: 'Channel-only SL5 TG100', settings: { ...BASE, signalMode: 'channel', stopLossPoints: 5, targetProfitPoints: 100 } },
  // --- Quality filters ---
  {
    id: 'N14',
    name: 'Balanced SL8 TG80 + bearish break candle',
    settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80, requireBearishBreakdownCandle: true },
  },
  {
    id: 'N15',
    name: 'Balanced SL8 TG80 + min rise 24',
    settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80, minRisePoints: 24 },
  },
  {
    id: 'N16',
    name: 'Balanced SL8 TG80 entry 10:30–14:00',
    settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80, entryFromTime: '10:30', entryToTime: '14:00' },
  },
  { id: 'N17', name: 'Balanced SL8 TG80 OTM PE', settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80, strikeMode: 'OTM' } },
  { id: 'N18', name: 'Balanced SL8 TG80 lower leverage 6', settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80, premiumLeverage: 6 } },
  { id: 'N19', name: 'Balanced SL8 TG80 charges 80', settings: { ...BASE, stopLossPoints: 8, targetProfitPoints: 80, perTradeCost: 80 } },
  { id: 'N20', name: 'Wedge strict narrow 5% SL8 TG80', settings: { ...BASE, signalMode: 'wedge', minNarrowingPct: 5, stopLossPoints: 8, targetProfitPoints: 80 } },

  // --- Beast pack: RSI / EMA / channel / scalp targets (entry filters) ---
  {
    id: 'B01',
    name: 'Channel SL10 TG45 + RSI bearish',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 10,
      targetProfitPoints: 45,
      requireBearishBreakdownCandle: true,
      requireRsiOverbought: true,
      rsiMinEntry: 55,
    },
  },
  {
    id: 'B02',
    name: 'Channel SL12 TG50 + RSI + below EMA',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 12,
      targetProfitPoints: 50,
      requireBearishBreakdownCandle: true,
      requireRsiOverbought: true,
      requireBelowEma: true,
      minBreakBodyPct: 0.35,
    },
  },
  {
    id: 'B03',
    name: 'Channel SL8 TG40 + RSI + vol confirm',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 8,
      targetProfitPoints: 40,
      volumeConfirm: true,
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B04',
    name: 'Wedge SL10 TG55 + RSI + rise 20',
    settings: {
      ...BASE,
      signalMode: 'wedge',
      stopLossPoints: 10,
      targetProfitPoints: 55,
      minSetupRisePoints: 20,
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B05',
    name: 'Channel SL15 TG60 + RSI + EMA down',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 15,
      targetProfitPoints: 60,
      requireRsiOverbought: true,
      requireBelowEma: true,
      requireEmaSlopingDown: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B06',
    name: 'Balanced SL10 TG50 + RSI only',
    settings: {
      ...BASE,
      stopLossPoints: 10,
      targetProfitPoints: 50,
      requireRsiOverbought: true,
      rsiMinEntry: 58,
    },
  },
  {
    id: 'B07',
    name: 'Channel SL6 TG35 scalp + strong break',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 6,
      targetProfitPoints: 35,
      requireBearishBreakdownCandle: true,
      minBreakBodyPct: 0.45,
      minCloseInLowerRangePct: 25,
      requireRsiOverbought: true,
    },
  },
  {
    id: 'B08',
    name: 'Channel SL12 TG70 + min rise 28 + RSI',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 12,
      targetProfitPoints: 70,
      minSetupRisePoints: 28,
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B09',
    name: 'Channel SL18 TG55 wide SL quick TG',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 18,
      targetProfitPoints: 55,
      requireRsiOverbought: true,
      requireBelowEma: true,
    },
  },
  {
    id: 'B10',
    name: 'Channel SL10 TG60 entry 10:30–14:00 + RSI',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 10,
      targetProfitPoints: 60,
      entryFromTime: '10:30',
      entryToTime: '14:00',
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B11',
    name: 'Wedge SL8 TG45 + narrow 4% + RSI',
    settings: {
      ...BASE,
      signalMode: 'wedge',
      minNarrowingPct: 4,
      stopLossPoints: 8,
      targetProfitPoints: 45,
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B12',
    name: 'Channel SL14 TG85 + ATR min 8 + RSI',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 14,
      targetProfitPoints: 85,
      minAtrPoints: 8,
      requireRsiOverbought: true,
    },
  },
  {
    id: 'B13',
    name: 'Balanced SL12 TG55 + vol + RSI',
    settings: {
      ...BASE,
      stopLossPoints: 12,
      targetProfitPoints: 55,
      volumeConfirm: true,
      volumeMultiplier: 1.25,
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B14',
    name: 'Channel-only strict slope SL10 TG50',
    settings: {
      ...BASE,
      signalMode: 'channel',
      minRisingSlopePerBar: 0.2,
      minNarrowingPct: 4,
      stopLossPoints: 10,
      targetProfitPoints: 50,
      requireRsiOverbought: true,
      requireBearishBreakdownCandle: true,
    },
  },
  {
    id: 'B15',
    name: 'Channel SL20 TG50 max room SL',
    settings: {
      ...BASE,
      signalMode: 'channel',
      stopLossPoints: 20,
      targetProfitPoints: 50,
      requireRsiOverbought: true,
      requireBelowEma: true,
      minBreakBodyPct: 0.4,
    },
  },

  // --- Tune 2022+ without RSI (wider SL / smaller TG / stricter rise) ---
  { id: 'C01', name: 'Balanced SL18 TG70', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 70 } },
  { id: 'C03', name: 'Balanced SL16 TG55', settings: { ...BASE, stopLossPoints: 16, targetProfitPoints: 55 } },
  { id: 'C04', name: 'Balanced SL20 TG65', settings: { ...BASE, stopLossPoints: 20, targetProfitPoints: 65 } },
  {
    id: 'C05',
    name: 'Balanced min rise 28 SL15 TG90',
    settings: { ...BASE, minRisePoints: 28, minSetupRisePoints: 28 },
  },
  {
    id: 'C06',
    name: 'Balanced min rise 28 SL18 TG60',
    settings: { ...BASE, minRisePoints: 28, minSetupRisePoints: 28, stopLossPoints: 18, targetProfitPoints: 60 },
  },
  {
    id: 'C07',
    name: 'Balanced red-day SL18 TG60',
    settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 60, requireRedDaySoFar: true },
  },
  {
    id: 'C08',
    name: 'Balanced red-day SL15 TG90',
    settings: { ...BASE, requireRedDaySoFar: true },
  },
  {
    id: 'C09',
    name: 'Balanced bearish break SL18 TG60',
    settings: {
      ...BASE,
      stopLossPoints: 18,
      targetProfitPoints: 60,
      requireBearishBreakdownCandle: true,
    },
  },
  { id: 'C10', name: 'Balanced SL18 TG50', settings: { ...BASE, stopLossPoints: 18, targetProfitPoints: 50 } },
];

function getScenarioById(id) {
  return STRATEGY_SIX_SCENARIOS.find((s) => s.id === id) || null;
}

function getProductionSettings() {
  const s = getScenarioById(STRATEGY_SIX_PRODUCTION_ID);
  return s ? { ...s.settings } : { ...BASE };
}

function setProductionScenarioId(id) {
  if (getScenarioById(id)) STRATEGY_SIX_PRODUCTION_ID = id;
}

module.exports = {
  STRATEGY_SIX_SCENARIOS,
  STRATEGY_SIX_PRODUCTION_ID,
  getScenarioById,
  getProductionSettings,
  setProductionScenarioId,
};

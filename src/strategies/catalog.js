/**
 * Strategy catalog — Strategy 6 only (rising wedge breakdown).
 */

const STRATEGY_SIX_KEY = 'strategy6_rising_wedge_breakdown';

const COMMON_DEFAULTS = {
  symbol: 'NIFTY',
  interval: '5',
  strikeMode: 'ATM',
  stopLossPoints: 18,
  targetProfitPoints: 80,
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 1,
  perTradeCost: 100,
  maxTradesPerDay: 1,
  minBarsBetweenTrades: 4,
  usePatternExits: false,
  entryFromTime: '10:00',
  entryToTime: '14:45',
};

/** @type {Record<number, { id: number, key: string, label: string, shortName: string, implemented: boolean, defaultInterval: string, defaults: Record<string, unknown> }>} */
const STRATEGY_CATALOG = {
  6: {
    id: 6,
    key: STRATEGY_SIX_KEY,
    label: 'Strategy 6 - Intraday Bearish Breakdown (Balanced)',
    shortName: 'Bearish Breakdown',
    implemented: true,
    defaultInterval: '5',
    defaults: {
      ...COMMON_DEFAULTS,
      interval: '5',
      signalMode: 'balanced',
      wedgeLookback: 10,
      breakLookbackBars: 4,
      minRisePoints: 18,
      pivotBars: 1,
      minSwingPoints: 2,
      minRisingSlopePerBar: 0.12,
      maxLowerToUpperSlopeRatio: 1.05,
      minNarrowingPct: 3,
      breakdownBufferPoints: 0,
      stopBufferPoints: 6,
      measuredMoveMultiplier: 0.65,
      minBarsBetweenTrades: 6,
      requireBearishBreakdownCandle: false,
      volumeConfirm: false,
      maxTradesPerDay: 1,
    },
  },
};

function getCatalogEntry(strategyId) {
  return STRATEGY_CATALOG[Number(strategyId)] || null;
}

function getImplementedCatalogIds() {
  return Object.values(STRATEGY_CATALOG)
    .filter((e) => e.implemented)
    .map((e) => e.id);
}

module.exports = {
  STRATEGY_CATALOG,
  getCatalogEntry,
  getImplementedCatalogIds,
  STRATEGY_SIX_KEY,
};

/**
 * Catalog strategies — Strategy 4 (bearish breakdown), Strategy 5 (Kukki V2).
 * Mongo keys stay stable so old runs stay readable.
 */

const STRATEGY_FOUR_KEY = 'strategy6_rising_wedge_breakdown';
const STRATEGY_FIVE_KUKKI_KEY = 'strategy5_kukki_v2_intraday';

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
  4: {
    id: 4,
    key: STRATEGY_FOUR_KEY,
    label: 'Strategy 4 - Intraday Bearish Breakdown (Balanced)',
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
  5: {
    id: 5,
    key: STRATEGY_FIVE_KUKKI_KEY,
    label: 'Strategy 5 - Kukki V2 Long + Short Intraday',
    shortName: 'Kukki V2',
    implemented: true,
    defaultInterval: '5',
    defaults: {
      ...COMMON_DEFAULTS,
      interval: '5',
      stopLossPoints: 20,
      targetProfitPoints: 80,
      maxTradesPerDay: 1,
      minBarsBetweenTrades: 6,
      entryFromTime: '11:00',
      entryToTime: '14:00',
      emaFast: 8,
      emaSlow: 34,
      adxLength: 14,
      adxSmoothing: 10,
      minAdx: 20,
      macdFast: 12,
      macdSlow: 26,
      macdSignal: 9,
      breakLookbackBars: 3,
      usePatternExits: false,
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
  STRATEGY_FOUR_KEY,
  STRATEGY_FIVE_KUKKI_KEY,
};

/**
 * Backtest / market-data HTTP surface. Per-strategy handlers stay in small sibling files.
 */

const { health, getCandles, getCandlesDay } = require('./candlesAndHealth');
const {
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
} = require('./intradayTierHandlers');
const {
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
} = require('./strategySevenHandlers');
const {
  runStrategyEight,
  getStrategyEightRunTrades,
  getStrategyEightValidation,
  postStrategyEightValidation,
} = require('./strategyEightHandlers');
const {
  runStrategyNine,
  getStrategyNineRunTrades,
  getStrategyNineValidation,
  postStrategyNineValidation,
} = require('./strategyNineHandlers');
const {
  runStrategyTen,
  getStrategyTenRunTrades,
  getStrategyTenValidation,
  postStrategyTenValidation,
} = require('./strategyTenHandlers');

module.exports = {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
  runStrategyEight,
  getStrategyEightRunTrades,
  getStrategyEightValidation,
  postStrategyEightValidation,
  runStrategyNine,
  getStrategyNineRunTrades,
  getStrategyNineValidation,
  postStrategyNineValidation,
  runStrategyTen,
  getStrategyTenRunTrades,
  getStrategyTenValidation,
  postStrategyTenValidation,
};

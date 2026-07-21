/**
 * Backtest / market-data HTTP surface. Per-strategy handlers stay in small sibling files.
 */

const { health, getCandles, getCandlesDay } = require('./candlesAndHealth');
const {
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  postStrategyShortStraddleValidationYear,
} = require('./intradayTierHandlers');
const {
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
  postStrategySevenValidationYear,
} = require('./strategySevenHandlers');
const {
  runStrategyEight,
  getStrategyEightRunTrades,
  getStrategyEightValidation,
  postStrategyEightValidation,
  postStrategyEightValidationYear,
} = require('./strategyEightHandlers');

module.exports = {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  postStrategyShortStraddleValidationYear,
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
  postStrategySevenValidationYear,
  runStrategyEight,
  getStrategyEightRunTrades,
  getStrategyEightValidation,
  postStrategyEightValidation,
  postStrategyEightValidationYear,
};

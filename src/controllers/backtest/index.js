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
};

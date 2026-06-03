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
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  postStrategyFiveValidation,
} = require('./strategyFiveHandlers');
const {
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
} = require('./strategySevenHandlers');

module.exports = {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  postStrategyFiveValidation,
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
};

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

module.exports = {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  postStrategyShortStraddleValidationYear,
};

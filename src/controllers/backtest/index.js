/**
 * Backtest / market-data HTTP surface. Per-strategy handlers stay in small sibling files.
 */

const { health, getCandles, getCandlesDay, runBacktestStub } = require('./candlesAndHealth');
const {
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  postStrategyOneValidation,
} = require('./strategyOneHandlers');
const {
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
  postStrategyFourValidation,
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
module.exports = {
  health,
  getCandles,
  getCandlesDay,
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  postStrategyOneValidation,
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
  postStrategyFourValidation,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  postStrategyFiveValidation,
  runBacktestStub,
};

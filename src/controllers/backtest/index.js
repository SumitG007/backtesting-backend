/**
 * Backtest / market-data HTTP surface. Per-strategy handlers stay in small sibling files.
 */

const { health, getCandles, getCandlesDay, runBacktestStub } = require('./candlesAndHealth');
const { runStrategyOne, getStrategyOneRunTrades, getStrategyOneValidation } = require('./strategyOneHandlers');
const {
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
} = require('./intradayTierHandlers');
const {
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
} = require('./strategyFiveHandlers');
module.exports = {
  health,
  getCandles,
  getCandlesDay,
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  runBacktestStub,
};

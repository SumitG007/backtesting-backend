/**
 * Backtest / market-data HTTP surface. Per-strategy handlers stay in small sibling files.
 */

const { health, getCandles, runBacktestStub } = require('./candlesAndHealth');
const { runStrategyOne, getStrategyOneRunTrades, getStrategyOneValidation } = require('./strategyOneHandlers');
const { runStrategyTwo, getStrategyTwoRunTrades, getStrategyTwoValidation } = require('./strategyTwoHandlers');
const {
  runStrategyThree,
  getStrategyThreeRunTrades,
  getStrategyThreeValidation,
} = require('./strategyThreeHandlers');

module.exports = {
  health,
  getCandles,
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  runStrategyTwo,
  getStrategyTwoRunTrades,
  getStrategyTwoValidation,
  runStrategyThree,
  getStrategyThreeRunTrades,
  getStrategyThreeValidation,
  runBacktestStub,
};

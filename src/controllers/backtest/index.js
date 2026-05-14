/**
 * Backtest / market-data HTTP surface. Per-strategy handlers stay in small sibling files.
 */

const { health, getCandles, runBacktestStub } = require('./candlesAndHealth');
const { runStrategyOne, getStrategyOneRunTrades, getStrategyOneValidation } = require('./strategyOneHandlers');
const { runStrategyTwo, getStrategyTwoRunTrades, getStrategyTwoValidation } = require('./strategyTwoHandlers');

module.exports = {
  health,
  getCandles,
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  runStrategyTwo,
  getStrategyTwoRunTrades,
  getStrategyTwoValidation,
  runBacktestStub,
};

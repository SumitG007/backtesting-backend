const { createCatalogStrategyHandlers } = require('./strategyHandlerFactory');

const handlers = createCatalogStrategyHandlers(6);

module.exports = {
  runStrategySix: handlers.runStrategy,
  getStrategySixRunTrades: handlers.getRunTrades,
  getStrategySixValidation: handlers.getValidation,
};

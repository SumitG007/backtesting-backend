/**
 * Wire Strategy 6 catalog routes.
 */

const { createCatalogStrategyHandlers } = require('./strategyHandlerFactory');

function registerCatalogStrategyRoutes(router) {
  const { runStrategy, getRunTrades, getValidation } = createCatalogStrategyHandlers(6);
  router.post('/strategy6/run', runStrategy);
  router.get('/strategy6/runs/:runId/trades', getRunTrades);
  router.get('/strategy6/runs/:runId/validation', getValidation);
}

module.exports = { registerCatalogStrategyRoutes };

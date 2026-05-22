/**
 * Wire catalog strategy routes (Strategy 4 = bearish breakdown).
 */

const { createCatalogStrategyHandlers } = require('./strategyHandlerFactory');

function registerCatalogStrategyRoutes(router) {
  for (const id of [4]) {
    const { runStrategy, getRunTrades, getValidation } = createCatalogStrategyHandlers(id);
    router.post(`/strategy${id}/run`, runStrategy);
    router.get(`/strategy${id}/runs/:runId/trades`, getRunTrades);
    router.get(`/strategy${id}/runs/:runId/validation`, getValidation);
  }
}

module.exports = { registerCatalogStrategyRoutes };

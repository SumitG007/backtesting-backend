/**
 * Strategy 1 — HTTP handlers. Implement backtest in `strategies/strategy1/backtest.js`, then wire `runStrategyOne`.
 */

const { STRATEGY_ONE_KEY } = require('../../strategies/keys');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');

async function runStrategyOne(_req, res) {
  return res.status(501).json({
    ok: false,
    code: 'STRATEGY_ONE_NOT_IMPLEMENTED',
    error:
      'Strategy 1 backtest is not wired yet. Add your rules in backend/src/strategies/strategy1/backtest.js and call them from runStrategyOne here.',
  });
}

async function getStrategyOneRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_ONE_KEY);
}

async function getStrategyOneValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_ONE_KEY);
}

module.exports = {
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
};

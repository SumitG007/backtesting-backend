/**
 * Strategy 3 — Option chain OI direction (backtest only; 1m candles for signal).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_THREE_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');

async function runStrategyThree(req, res) {
  try {
    const { symbol = 'NIFTY', year = 2026 } = req.body || {};
    const rawTv = String(parseStringInput(req.body?.tradeViewInterval, '5'));
    const tradeViewInterval = ['1', '5', '15'].includes(rawTv) ? rawTv : '5';
    const settings = {
      symbol: String(symbol).toUpperCase(),
      analysisStartTime: parseStringInput(req.body?.analysisStartTime, '09:16'),
      tradeViewInterval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parseNumberInput(req.body?.stopLossPoints, 20),
      targetProfitPoints: parseNumberInput(req.body?.targetProfitPoints, 50),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    };

    const yearNum = parseNumberInput(year, 2026);
    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: '1',
      year: yearNum,
    });

    const result = await runBacktestInWorker(STRATEGY_THREE_KEY, {
      candles: payload.rows,
      settings,
    });

    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_THREE_KEY,
      symbol: settings.symbol,
      interval: '1',
      year: yearNum,
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: STRATEGY_THREE_KEY,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 3 - Option Chain OI Direction (Backtest)',
      year: yearNum,
      symbol: settings.symbol,
      interval: '1',
      summary: result.summary,
      trades: result.trades.slice(0, pageSize),
      pagination: {
        page: 1,
        pageSize,
        totalRows: result.trades.length,
        totalPages: Math.max(1, Math.ceil(result.trades.length / pageSize)),
      },
      settings,
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({
        ok: false,
        error: 'Dhan API error',
        details: error.response.data,
      });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getStrategyThreeRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_THREE_KEY);
}

async function getStrategyThreeValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_THREE_KEY);
}

module.exports = {
  runStrategyThree,
  getStrategyThreeRunTrades,
  getStrategyThreeValidation,
};

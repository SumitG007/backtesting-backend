/**
 * Strategy 1 — Previous day close retest (backtest only; no live/paper).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_ONE_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');

async function runStrategyOne(req, res) {
  try {
    const { symbol = 'NIFTY', interval = '15', year = 2026 } = req.body || {};
    const settings = {
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      retestPoints: parseNumberInput(req.body?.retestPoints, 1),
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parseNumberInput(req.body?.stopLossPoints, 0),
      targetProfitPoints: parseNumberInput(req.body?.targetProfitPoints, 20),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 1),
    };

    const yearNum = parseNumberInput(year, 2026);
    const [dailyPayload, execPayload] = await Promise.all([
      fetchWithRateLimitRetry({
        symbol: settings.symbol,
        interval: '1',
        year: yearNum,
      }),
      fetchWithRateLimitRetry({
        symbol: settings.symbol,
        interval: String(interval),
        year: yearNum,
      }),
    ]);

    const result = await runBacktestInWorker(STRATEGY_ONE_KEY, {
      dailyCandles: dailyPayload.rows,
      execCandles: execPayload.rows,
      settings,
    });

    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_ONE_KEY,
      symbol: settings.symbol,
      interval: String(interval),
      year: yearNum,
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        mapTradesForInsert(result.trades, runDoc._id, STRATEGY_ONE_KEY),
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 1 - Previous Day Close Retest',
      year: yearNum,
      symbol: settings.symbol,
      interval: String(interval),
      summary: result.summary,
      trades: result.trades.slice(0, pageSize),
      pagination: {
        page: 1,
        pageSize,
        totalRows: result.trades.length,
        totalPages: Math.max(1, Math.ceil(result.trades.length / pageSize)),
      },
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

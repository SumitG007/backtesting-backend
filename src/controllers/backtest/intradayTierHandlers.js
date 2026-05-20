/**
 * HTTP handlers for Strategy 4 (intraday tier backtest).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_FOUR_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');

const TIER = {
  key: STRATEGY_FOUR_KEY,
  runName: 'Strategy 4 - First Hour Open Bias',
  defaultSl: 18,
  defaultTg: 80,
  defaultInterval: '5',
};

function buildSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, TIER.defaultInterval));
  const interval = ['1', '5', '15'].includes(rawIv) ? rawIv : TIER.defaultInterval;

  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parseNumberInput(req.body?.stopLossPoints, TIER.defaultSl),
      targetProfitPoints: parseNumberInput(req.body?.targetProfitPoints, TIER.defaultTg),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategyFour(req, res) {
  try {
    const { settings, yearNum } = buildSettings(req);
    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
    });

    const result = await runBacktestInWorker(TIER.key, {
      candles: payload.rows,
      settings,
    });

    const runDoc = await StrategyRun.create({
      strategyKey: TIER.key,
      symbol: settings.symbol,
      interval: settings.interval,
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
          strategyKey: TIER.key,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        })),
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: TIER.runName,
      year: yearNum,
      symbol: settings.symbol,
      interval: settings.interval,
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

async function getStrategyFourRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_FOUR_KEY);
}

async function getStrategyFourValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_FOUR_KEY);
}

module.exports = {
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
};

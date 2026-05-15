/**
 * Strategy 2 — Short straddle backtest HTTP handlers.
 * Core math: `strategies/strategy2/shortStraddleBacktest.js` (also re-exported from `strategyService`).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_TWO_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput, parseOptionalPositiveNumber } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');

async function runStrategyTwo(req, res) {
  try {
    const { symbol = 'NIFTY', interval = '15', year = 2026 } = req.body || {};
    const skipExpiryDayRaw = req.body?.skipExpiryDay;
    const skipExpiryDay =
      skipExpiryDayRaw === undefined
        ? true
        : skipExpiryDayRaw !== false && skipExpiryDayRaw !== 'false';
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      targetPct: parseOptionalPositiveNumber(req.body?.targetPct),
      stopLossPct: parseOptionalPositiveNumber(req.body?.stopLossPct),
      entryTime: parseStringInput(req.body?.entryTime || req.body?.entryFromTime, '09:30'),
      entryFromTime: parseStringInput(req.body?.entryTime || req.body?.entryFromTime, '09:30'),
      dayCloseTime: parseStringInput(req.body?.dayCloseTime, '09:20'),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      expiryWeekday: parseNumberInput(req.body?.expiryWeekday, 2),
      skipExpiryDay,
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });

    const result = await runBacktestInWorker(STRATEGY_TWO_KEY, { candles: payload.rows, settings });
    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_TWO_KEY,
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: STRATEGY_TWO_KEY,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 2 - Short Straddle (Overnight Hold)',
      year: parseNumberInput(year, 2026),
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

async function getStrategyTwoRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_TWO_KEY);
}

async function getStrategyTwoValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_TWO_KEY);
}

module.exports = {
  runStrategyTwo,
  getStrategyTwoRunTrades,
  getStrategyTwoValidation,
};

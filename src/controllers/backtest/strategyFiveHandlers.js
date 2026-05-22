/**
 * HTTP handlers for Strategy 5 — IV mean reversion (intraday short straddle).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_FIVE_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput, parseOptionalPositiveNumber } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');

const DEFAULTS = {
  defaultInterval: '5',
  ivLookbackDays: 20,
  ivSpikeMultiplier: 1.25,
  maxSpikeMultiplier: 2,
  ivExpandStopMult: 1.5,
  premiumLeverage: 8,
};

function buildSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, DEFAULTS.defaultInterval));
  const interval = ['1', '5', '15'].includes(rawIv) ? rawIv : DEFAULTS.defaultInterval;

  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval,
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, DEFAULTS.premiumLeverage),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      ivLookbackDays: parseNumberInput(req.body?.ivLookbackDays, DEFAULTS.ivLookbackDays),
      ivSpikeMultiplier: parseNumberInput(req.body?.ivSpikeMultiplier, DEFAULTS.ivSpikeMultiplier),
      targetVolCrushPct: parseOptionalPositiveNumber(req.body?.targetVolCrushPct),
      stopVolExpandPct: parseOptionalPositiveNumber(req.body?.stopVolExpandPct),
      ivExpandStopMult: parseNumberInput(req.body?.ivExpandStopMult, DEFAULTS.ivExpandStopMult),
      maxSpikeMultiplier: parseNumberInput(req.body?.maxSpikeMultiplier, DEFAULTS.maxSpikeMultiplier),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategyFive(req, res) {
  try {
    const { settings, yearNum } = buildSettings(req);
    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
    });

    const result = await runBacktestInWorker(STRATEGY_FIVE_KEY, {
      candles: payload.rows,
      settings,
    });

    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_FIVE_KEY,
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        mapTradesForInsert(result.trades, runDoc._id, STRATEGY_FIVE_KEY),
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 5 - IV Mean Reversion',
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

async function getStrategyFiveRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_FIVE_KEY);
}

async function getStrategyFiveValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_FIVE_KEY);
}

module.exports = {
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
};

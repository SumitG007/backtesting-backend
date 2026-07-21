/**
 * HTTP handlers for Strategy 4 (UI) — Opening Price Reversal (API prefix strategy4).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { STRATEGY_EIGHT_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');
const { parseNumberInput, parseStringInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');
const {
  createPostMultiYearValidationHandler,
  createPostSingleYearValidationHandler,
} = require('./postMultiYearValidation');

const TIER = {
  key: STRATEGY_EIGHT_KEY,
  runName: 'Strategy 4 - Opening Price Reversal',
  /** 1m path inside the 09:15–09:30 fifteen-minute window. */
  defaultInterval: '1',
};

function buildSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const stopLossPctRaw = Number(req.body?.stopLossPct);
  const stopLossPct =
    Number.isFinite(stopLossPctRaw) && stopLossPctRaw > 0
      ? Math.min(90, stopLossPctRaw)
      : 15;

  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval: TIER.defaultInterval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPct,
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 5),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategyEight(req, res) {
  try {
    const { settings, yearNum } = buildSettings(req);
    const payload = await fetchYearCandlesByDayCached({
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
    });

    const result = await runBacktestInWorker(TIER.key, {
      candles: payload.rows,
      settings,
    });

    const enriched = await enrichStrategySevenTradesWithRealPremiums({
      trades: result.trades,
      settings,
    });
    const trades = enriched.trades;
    const summary = {
      ...buildStrategyRunSummary(trades),
      skippedDays: result.summary.skippedDays,
      putTrades: result.summary.putTrades,
      callTrades: result.summary.callTrades,
      stopLossPct: result.summary.stopLossPct,
      windowFrom: result.summary.windowFrom,
      windowTo: result.summary.windowTo,
      pathInterval: result.summary.pathInterval,
      realPremiumTrades: enriched.realCount,
      modelPremiumTrades: enriched.modelCount,
    };

    const runDoc = await StrategyRun.create({
      strategyKey: TIER.key,
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
      settings,
      summary,
      status: 'completed',
    });

    if (trades.length > 0) {
      await StrategyTrade.insertMany(mapTradesForInsert(trades, runDoc._id, TIER.key));
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: TIER.runName,
      year: yearNum,
      symbol: settings.symbol,
      interval: settings.interval,
      summary,
      trades: trades.slice(0, pageSize),
      pagination: {
        page: 1,
        pageSize,
        totalRows: trades.length,
        totalPages: Math.max(1, Math.ceil(trades.length / pageSize)),
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

async function getStrategyEightRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_EIGHT_KEY);
}

async function getStrategyEightValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_EIGHT_KEY);
}

const postStrategyEightValidation = createPostMultiYearValidationHandler({
  strategyKey: STRATEGY_EIGHT_KEY,
  buildSettings,
});

const postStrategyEightValidationYear = createPostSingleYearValidationHandler({
  strategyKey: STRATEGY_EIGHT_KEY,
  buildSettings,
});

module.exports = {
  runStrategyEight,
  getStrategyEightRunTrades,
  getStrategyEightValidation,
  postStrategyEightValidation,
  postStrategyEightValidationYear,
};

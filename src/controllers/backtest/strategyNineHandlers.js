/**
 * HTTP handlers for Strategy 5 (UI) — VWAP + EMA trend scalper.
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_NINE_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput, parsePremiumExitPoints } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');
const { createPostMultiYearValidationHandler } = require('./postMultiYearValidation');

const TIER = {
  key: STRATEGY_NINE_KEY,
  runName: 'Strategy 5 - VWAP+EMA trend',
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
      // "One trade/day" mode: only one eligible entry candle per session.
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 1),
      minBarsBetweenTrades: parseNumberInput(req.body?.minBarsBetweenTrades, 1),
      // One-shot entry: configured candle time (default 09:30 IST).
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:30'),
      entryToTime: parseStringInput(req.body?.entryToTime, '12:30'),
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      // SL is controlled by index-structure exit (stopIndex) for this strategy.
      // Premium SL disabled when stopLossPoints = 0.
      stopLossPoints: parsePremiumExitPoints(req.body?.stopLossPoints, 0),
      targetProfitPoints: parsePremiumExitPoints(req.body?.targetProfitPoints, 2),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 10),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      // Big-candle filters for the one-shot entry.
      bigCandleMinBodyPct: parseNumberInput(req.body?.bigCandleMinBodyPct, 0.002), // ~0.2%
      bigCandleMinRangePct: parseNumberInput(req.body?.bigCandleMinRangePct, 0.003), // ~0.3%
      // Spot points buffer for index SL placement.
      slBufferPoints: parseNumberInput(req.body?.slBufferPoints, 8),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategyNine(req, res) {
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
      await StrategyTrade.insertMany(mapTradesForInsert(result.trades, runDoc._id, TIER.key));
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
      meta: result.meta || null,
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

async function getStrategyNineRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_NINE_KEY);
}

async function getStrategyNineValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_NINE_KEY);
}

const postStrategyNineValidation = createPostMultiYearValidationHandler({
  strategyKey: STRATEGY_NINE_KEY,
  buildSettings,
});

module.exports = {
  runStrategyNine,
  getStrategyNineRunTrades,
  getStrategyNineValidation,
  postStrategyNineValidation,
};

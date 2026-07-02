/**
 * HTTP handlers for Strategy 5 (UI) — daily PUT buy at entry time.
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { STRATEGY_NINE_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');
const { parseNumberInput, parseStringInput, parsePremiumExitPoints } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');
const { createPostMultiYearValidationHandler } = require('./postMultiYearValidation');

const TIER = {
  key: STRATEGY_NINE_KEY,
  runName: 'Strategy 5 - Daily PUT buy',
  defaultInterval: '5',
};

function buildSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, TIER.defaultInterval));
  const interval = ['1', '5', '15'].includes(rawIv) ? rawIv : TIER.defaultInterval;
  const entryTime = parseStringInput(req.body?.entryTime ?? req.body?.entryFromTime, '09:20');

  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parsePremiumExitPoints(req.body?.stopLossPoints, 0),
      targetProfitPoints: parsePremiumExitPoints(req.body?.targetProfitPoints, 0),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 10),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      entryTime,
      entryFromTime: parseStringInput(req.body?.entryFromTime, entryTime),
      entryToTime: parseStringInput(req.body?.entryToTime, entryTime),
      barIntervalMinutes: parseNumberInput(req.body?.barIntervalMinutes, Number(interval) || 5),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategyNine(req, res) {
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

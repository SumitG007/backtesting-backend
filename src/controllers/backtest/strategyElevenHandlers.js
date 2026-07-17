/**
 * HTTP handlers for Strategy 6 (UI) — SL Flip (API prefix strategy8).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { STRATEGY_ELEVEN_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');
const {
  parseNumberInput,
  parseStringInput,
  parsePremiumExitPoints,
  parseBooleanInput,
} = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');
const { createPostMultiYearValidationHandler, createPostSingleYearValidationHandler } = require('./postMultiYearValidation');

const TIER = {
  key: STRATEGY_ELEVEN_KEY,
  runName: 'Strategy 6 - SL Flip',
  defaultInterval: '5',
};

function buildSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, TIER.defaultInterval));
  const interval = rawIv === '5' ? '5' : TIER.defaultInterval;
  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parsePremiumExitPoints(req.body?.stopLossPoints, 8),
      targetProfitPoints: parsePremiumExitPoints(
        req.body?.trailingActivationPoints ?? req.body?.targetProfitPoints,
        4,
      ),
      trailingActivationPoints: parseNumberInput(
        req.body?.trailingActivationPoints ?? req.body?.targetProfitPoints,
        4,
      ),
      trailingStepPoints: parseNumberInput(req.body?.trailingStepPoints, 2),
      trailingTargetEnabled: parseBooleanInput(req.body?.trailingTargetEnabled, true),
      moveStopWithProfit: parseBooleanInput(req.body?.moveStopWithProfit, true),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 5),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      entryFromTime: parseStringInput(req.body?.entryFromTime ?? req.body?.entryTime, '09:20'),
      entryToTime: parseStringInput(req.body?.entryToTime, '15:15'),
      eodExitTime: parseStringInput(req.body?.eodExitTime, '15:20'),
      eodExitAtBarOpen: parseBooleanInput(req.body?.eodExitAtBarOpen, true),
      maxTradesPerDay: null,
      maxLossesPerSidePerDay: null,
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategyEleven(req, res) {
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
      slFlips: result.summary.slFlips,
      trailReentries: result.summary.trailReentries,
      maxTradesPerDay: null,
      maxLossesPerSidePerDay: null,
      stopLossPoints: result.summary.stopLossPoints,
      targetProfitPoints: result.summary.targetProfitPoints,
      trailingActivationPoints: result.summary.trailingActivationPoints,
      trailingStepPoints: result.summary.trailingStepPoints,
      moveStopWithProfit: result.summary.moveStopWithProfit ?? true,
      trailingTargetEnabled: true,
      entryFromTime: result.summary.entryFromTime,
      entryToTime: result.summary.entryToTime,
      eodExitTime: result.summary.eodExitTime,
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

async function getStrategyElevenRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_ELEVEN_KEY);
}

async function getStrategyElevenValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_ELEVEN_KEY);
}

const postStrategyElevenValidation = createPostMultiYearValidationHandler({
  strategyKey: STRATEGY_ELEVEN_KEY,
  buildSettings,
});

const postStrategyElevenValidationYear = createPostSingleYearValidationHandler({
  strategyKey: STRATEGY_ELEVEN_KEY,
  buildSettings,
});

module.exports = {
  runStrategyEleven,
  getStrategyElevenRunTrades,
  getStrategyElevenValidation,
  postStrategyElevenValidation,
  postStrategyElevenValidationYear,
};

/**
 * HTTP handlers for Strategy 4 (intraday tier backtest).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_FOUR_KEY, STRATEGY_SIX_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput, parseBooleanInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');
const { createPostMultiYearValidationHandler } = require('./postMultiYearValidation');

const TIER = {
  key: STRATEGY_FOUR_KEY,
  runName: 'Strategy 4 - First Hour Open Bias',
  defaultSl: 20,
  defaultSignal: 70,
  defaultTrail: 30,
  defaultInterval: '5',
};
const TIER_SHORT_STRADDLE = {
  key: STRATEGY_SIX_KEY,
  runName: 'Strategy 4 - Short Straddle (Next Day Exit)',
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
      signalPoints: parseNumberInput(
        req.body?.signalPoints ?? req.body?.targetProfitPoints,
        TIER.defaultSignal,
      ),
      trailPoints: parseNumberInput(req.body?.trailPoints, TIER.defaultTrail),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '10:00'),
      entryToTime: parseStringInput(req.body?.entryToTime, '11:00'),
      tradeSide: parseStringInput(req.body?.tradeSide, 'both'),
      minFirstHourMovePct: parseNumberInput(req.body?.minFirstHourMovePct, 0),
      minFirstHourMovePoints: parseNumberInput(req.body?.minFirstHourMovePoints, 0),
      minFirstHourRangePoints: parseNumberInput(req.body?.minFirstHourRangePoints, 0),
      peMinFirstHourMovePct: parseNumberInput(req.body?.peMinFirstHourMovePct, 0),
      ceMinFirstHourMovePct: parseNumberInput(req.body?.ceMinFirstHourMovePct, 0),
      peMinFirstHourRangePoints: parseNumberInput(req.body?.peMinFirstHourRangePoints, 0),
      maxGapPct: parseNumberInput(req.body?.maxGapPct, 0),
      skipGapUpPe: parseBooleanInput(req.body?.skipGapUpPe, true),
      skipGapDownCe: parseBooleanInput(req.body?.skipGapDownCe, false),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

function buildShortStraddleSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, TIER_SHORT_STRADDLE.defaultInterval));
  const interval = ['1', '5', '15'].includes(rawIv) ? rawIv : TIER_SHORT_STRADDLE.defaultInterval;
  const entryTime = parseStringInput(req.body?.entryTime, '15:20');

  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parseNumberInput(req.body?.stopLossPoints, 0),
      targetProfitPoints: parseNumberInput(req.body?.targetProfitPoints, 0),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      entryTime,
      entryFromTime: parseStringInput(req.body?.entryFromTime, entryTime),
      entryToTime: parseStringInput(req.body?.entryToTime, entryTime),
      nextDayExitTime: parseStringInput(req.body?.nextDayExitTime, '15:15'),
      expiryWeekday: parseStringInput(req.body?.expiryWeekday, 'TUESDAY'),
      thetaDecayPerDayPct: parseNumberInput(req.body?.thetaDecayPerDayPct, 12),
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

async function runStrategyShortStraddleNextDay(req, res) {
  try {
    const { settings, yearNum } = buildShortStraddleSettings(req);
    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
    });

    const result = await runBacktestInWorker(TIER_SHORT_STRADDLE.key, {
      candles: payload.rows,
      settings,
    });

    const runDoc = await StrategyRun.create({
      strategyKey: TIER_SHORT_STRADDLE.key,
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(mapTradesForInsert(result.trades, runDoc._id, TIER_SHORT_STRADDLE.key));
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: TIER_SHORT_STRADDLE.runName,
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

const postStrategyFourValidation = createPostMultiYearValidationHandler({
  strategyKey: STRATEGY_FOUR_KEY,
  buildSettings,
});

async function getStrategyShortStraddleRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_SIX_KEY);
}

async function getStrategyShortStraddleValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_SIX_KEY);
}

const postStrategyShortStraddleValidation = createPostMultiYearValidationHandler({
  strategyKey: STRATEGY_SIX_KEY,
  buildSettings: buildShortStraddleSettings,
});

module.exports = {
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
  postStrategyFourValidation,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
};

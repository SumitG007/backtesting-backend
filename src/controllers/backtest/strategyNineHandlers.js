/**
 * HTTP handlers for Strategy 5 (UI) — Trail Scalp Put/Call.
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { STRATEGY_NINE_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');
const { parseDirectionSettings } = require('../../strategies/strategy7/putBuyDayFilters');
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
  key: STRATEGY_NINE_KEY,
  runName: 'Strategy 5 - Trail Scalp Put/Call',
  defaultInterval: '5',
};

function parseEnabledSignalsFromBody(body, key, fallbackKey) {
  const raw = body?.[key] ?? body?.[fallbackKey];
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map((id) => String(id));
  if (typeof raw === 'object') {
    return Object.entries(raw)
      .filter(([, enabled]) => enabled !== false && enabled !== 'false' && enabled !== 0)
      .map(([id]) => String(id));
  }
  return undefined;
}

function buildSettings(req) {
  const { symbol = 'NIFTY', year = 2026 } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, TIER.defaultInterval));
  const interval = rawIv === '5' ? '5' : TIER.defaultInterval;
  const entryFromTime = parseStringInput(req.body?.entryFromTime ?? req.body?.entryTime, '09:20');
  const rawSettings = {
    symbol: String(symbol).toUpperCase(),
    interval,
    strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
    stopLossPoints: parsePremiumExitPoints(req.body?.stopLossPoints, 8),
    targetProfitPoints: parsePremiumExitPoints(req.body?.targetProfitPoints, 4),
    basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
    premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
    lotCount: parseNumberInput(req.body?.lotCount, 5),
    lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
    strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    entryFromTime,
    entryToTime: parseStringInput(req.body?.entryToTime, '15:15'),
    eodExitTime: parseStringInput(req.body?.eodExitTime, '15:20'),
    maxTradesPerDay: 0,
    maxLossesPerSidePerDay: parseNumberInput(req.body?.maxLossesPerSidePerDay, 2),
    minDirectionScore: parseNumberInput(req.body?.minDirectionScore, 2),
    enabledPeSignals: parseEnabledSignalsFromBody(req.body, 'enabledPeSignals', 'peSignalFilters'),
    enabledCeSignals: parseEnabledSignalsFromBody(req.body, 'enabledCeSignals', 'ceSignalFilters'),
    entryFillMode: parseStringInput(req.body?.entryFillMode, 'signal_close'),
    trailingTargetEnabled: parseBooleanInput(req.body?.trailingTargetEnabled, true),
    trailingActivationPoints: parseNumberInput(req.body?.trailingActivationPoints, 4),
    trailingStepPoints: parseNumberInput(req.body?.trailingStepPoints, 2),
    eodExitAtBarOpen: parseBooleanInput(req.body?.eodExitAtBarOpen, true),
  };
  const normalizedDecision = parseDirectionSettings(rawSettings);

  return {
    settings: {
      ...rawSettings,
      minDirectionScore: normalizedDecision.minDirectionScore,
      enabledPeSignals: normalizedDecision.enabledPeSignals,
      enabledCeSignals: normalizedDecision.enabledCeSignals,
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
      minDirectionScore: result.summary.minDirectionScore,
      putTrades: result.summary.putTrades,
      callTrades: result.summary.callTrades,
      maxTradesPerDay: result.summary.maxTradesPerDay,
      maxLossesPerSidePerDay: result.summary.maxLossesPerSidePerDay,
      stopLossPoints: result.summary.stopLossPoints,
      targetProfitPoints: result.summary.targetProfitPoints,
      entryFromTime: result.summary.entryFromTime,
      entryToTime: result.summary.entryToTime,
      eodExitTime: result.summary.eodExitTime,
      trailingTargetEnabled: result.summary.trailingTargetEnabled,
      trailingStepPoints: result.summary.trailingStepPoints,
      trailingActivationPoints: result.summary.trailingActivationPoints,
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

const postStrategyNineValidationYear = createPostSingleYearValidationHandler({
  strategyKey: STRATEGY_NINE_KEY,
  buildSettings,
});

module.exports = {
  runStrategyNine,
  getStrategyNineRunTrades,
  getStrategyNineValidation,
  postStrategyNineValidation,
  postStrategyNineValidationYear,
};

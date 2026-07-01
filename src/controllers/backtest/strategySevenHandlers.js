/**
 * HTTP handlers for Strategy 3 (UI) — timed put & call buy.
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchYearCandlesByDayCached } = require('../../services/dhanDataService');
const { STRATEGY_SEVEN_KEY } = require('../../strategies/keys');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { enrichStrategySevenTradesWithRealPremiums } = require('../../strategies/strategy7/realOptionPremium');
const { parseNumberInput, parseStringInput, parsePremiumExitPoints } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { mapTradesForInsert } = require('./tradePersistence');
const { createPostMultiYearValidationHandler } = require('./postMultiYearValidation');

const TIER = {
  key: STRATEGY_SEVEN_KEY,
  runName: 'Strategy 3 - Put & Call',
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
  const interval = ['1', '5', '15'].includes(rawIv) ? rawIv : TIER.defaultInterval;
  const entryTime = parseStringInput(req.body?.entryTime ?? req.body?.entryFromTime, '11:15');

  return {
    settings: {
      symbol: String(symbol).toUpperCase(),
      interval,
      strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
      stopLossPoints: parsePremiumExitPoints(req.body?.stopLossPoints, 15),
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
      minDirectionScore: parseNumberInput(req.body?.minDirectionScore, 2),
      enabledPeSignals: parseEnabledSignalsFromBody(req.body, 'enabledPeSignals', 'peSignalFilters'),
      enabledCeSignals: parseEnabledSignalsFromBody(req.body, 'enabledCeSignals', 'ceSignalFilters'),
    },
    yearNum: parseNumberInput(year, 2026),
  };
}

async function runStrategySeven(req, res) {
  try {
    const { settings, yearNum } = buildSettings(req);
    // Live parity: fetch per-day (same single-day request the paper-live engine uses)
    // so the backtest sees the identical day-open Dhan serves live. See dhanDataService.
    const payload = await fetchYearCandlesByDayCached({
      symbol: settings.symbol,
      interval: settings.interval,
      year: yearNum,
    });

    const result = await runBacktestInWorker(TIER.key, {
      candles: payload.rows,
      settings,
    });

    // Live parity: swap the worker's synthetic premiums for REAL option premiums where the
    // contract is still resolvable, then rebuild the summary off the repriced trades.
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

async function getStrategySevenRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_SEVEN_KEY);
}

async function getStrategySevenValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_SEVEN_KEY);
}

const postStrategySevenValidation = createPostMultiYearValidationHandler({
  strategyKey: STRATEGY_SEVEN_KEY,
  buildSettings,
});

module.exports = {
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
};

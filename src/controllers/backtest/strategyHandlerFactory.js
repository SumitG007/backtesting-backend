/**
 * Factory for catalog strategy HTTP handlers (run / trades / validation).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { runBacktestInWorker } = require('../../utils/runBacktestInWorker');
const { parseNumberInput, parseStringInput, parseBooleanInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');
const { getCatalogEntry } = require('../../strategies/catalog');

function mergeSettingsFromBody(body, catalogEntry) {
  const defaults = { ...(catalogEntry?.defaults || {}) };
  const symbol = parseStringInput(body?.symbol, defaults.symbol || 'NIFTY');
  const interval = parseStringInput(body?.interval, catalogEntry?.defaultInterval || defaults.interval || '15');

  const settings = {
    ...defaults,
    symbol: String(symbol).toUpperCase(),
    interval: String(interval),
    strikeMode: parseStringInput(body?.strikeMode, defaults.strikeMode || 'ATM'),
    stopLossPoints: parseNumberInput(body?.stopLossPoints, defaults.stopLossPoints ?? 0),
    targetProfitPoints: parseNumberInput(body?.targetProfitPoints, defaults.targetProfitPoints ?? 0),
    basePremiumPct: parseNumberInput(body?.basePremiumPct, defaults.basePremiumPct ?? 0.5),
    premiumLeverage: parseNumberInput(body?.premiumLeverage, defaults.premiumLeverage ?? 8),
    lotCount: parseNumberInput(body?.lotCount, defaults.lotCount ?? 1),
    lotSize: parseNumberInput(body?.lotSize, getLotSize(symbol)),
    strikeStep: parseNumberInput(body?.strikeStep, getStrikeStep(symbol)),
    perTradeCost: parseNumberInput(body?.perTradeCost, defaults.perTradeCost ?? 100),
    maxTradesPerDay: parseNumberInput(body?.maxTradesPerDay, defaults.maxTradesPerDay ?? 1),
    usePatternExits: parseBooleanInput(body?.usePatternExits, defaults.usePatternExits !== false),
    entryFromTime: parseStringInput(body?.entryFromTime, defaults.entryFromTime || '09:30'),
    entryToTime: parseStringInput(body?.entryToTime, defaults.entryToTime || '14:45'),
  };

  for (const key of Object.keys(defaults)) {
    if (body?.[key] === undefined || body?.[key] === '') continue;
    const def = defaults[key];
    if (typeof def === 'boolean') {
      settings[key] = parseBooleanInput(body[key], def);
    } else if (typeof def === 'number') {
      settings[key] = parseNumberInput(body[key], def);
    } else {
      settings[key] = parseStringInput(body[key], def);
    }
  }

  return settings;
}

function createCatalogStrategyHandlers(strategyId) {
  const catalogEntry = getCatalogEntry(strategyId);
  if (!catalogEntry) {
    throw new Error(`Unknown catalog strategy id: ${strategyId}`);
  }

  async function runStrategy(req, res) {
    if (!catalogEntry.implemented) {
      return res.status(501).json({
        ok: false,
        error: `${catalogEntry.label} is not implemented yet. Coming next in the rollout.`,
      });
    }

    try {
      const { year = 2026 } = req.body || {};
      const settings = mergeSettingsFromBody(req.body, catalogEntry);
      const yearNum = parseNumberInput(year, 2026);

      const execPayload = await fetchWithRateLimitRetry({
        symbol: settings.symbol,
        interval: String(settings.interval),
        year: yearNum,
      });

      const result = await runBacktestInWorker(catalogEntry.key, {
        execCandles: execPayload.rows,
        settings,
      });

      const runDoc = await StrategyRun.create({
        strategyKey: catalogEntry.key,
        symbol: settings.symbol,
        interval: String(settings.interval),
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
            strategyKey: catalogEntry.key,
            entryTime: new Date(t.entryTime),
            exitTime: new Date(t.exitTime),
          }))
        );
      }

      const pageSize = 25;
      return res.json({
        ok: true,
        runId: runDoc._id,
        strategy: catalogEntry.label,
        year: yearNum,
        symbol: settings.symbol,
        interval: String(settings.interval),
        summary: result.summary,
        meta: result.meta || null,
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

  async function getRunTrades(req, res) {
    return getRunTradesByStrategy(req, res, catalogEntry.key);
  }

  async function getValidation(req, res) {
    return getRunValidationByStrategy(req, res, catalogEntry.key);
  }

  return {
    runStrategy,
    getRunTrades,
    getValidation,
    catalogEntry,
  };
}

module.exports = {
  createCatalogStrategyHandlers,
  mergeSettingsFromBody,
};

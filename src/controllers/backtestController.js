const StrategyRun = require('../models/strategyRun');
const StrategyTrade = require('../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../utils/market');
const { getCandlesWithCache, fetchWithRateLimitRetry } = require('../services/dhanDataService');
const { runStrategyBreakoutRetest, runStrategyDowTheory, runStrategyAdxMacdReversal } = require('../services/strategyService');

function health(_req, res) {
  res.json({ ok: true, service: 'backtesting-api' });
}

async function getCandles(req, res) {
  try {
    const symbol = String(req.query.symbol || 'BANKNIFTY').toUpperCase();
    const interval = String(req.query.interval || '1');
    const year = Number(req.query.year || 2025);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(1000, Math.max(50, Number(req.query.pageSize) || 200));
    const refresh = String(req.query.refresh || 'false') === 'true';

    const payload = await getCandlesWithCache({ symbol, interval, year, refresh });
    const totalRows = payload.rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const candles = payload.rows.slice(start, start + pageSize);

    res.json({
      ok: true,
      source: refresh ? 'live-dhan' : 'live/cache',
      symbol,
      interval,
      year,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      pagination: { page: currentPage, pageSize, totalRows, totalPages },
      data: { candles },
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

async function runStrategyOne(req, res) {
  try {
    const { symbol = 'NIFTY', interval = '5', year = 2026 } = req.body || {};
    const hasStopLossInput = String(req.body?.stopLossPct ?? '').trim() !== '';
    const hasTargetInput = String(req.body?.targetPct ?? '').trim() !== '';
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: Number(req.body?.basePremiumPct ?? 0.85),
      lotCount: Number(req.body?.lotCount ?? 1),
      lotSize: Number(req.body?.lotSize ?? getLotSize(symbol)),
      premiumLeverage: Number(req.body?.premiumLeverage ?? 8),
      stopLossPct: hasStopLossInput ? Number(req.body?.stopLossPct) : 12,
      targetPct: hasTargetInput ? Number(req.body?.targetPct) : null,
      maxTradesPerDay: Number(req.body?.maxTradesPerDay ?? 2),
      entryFromTime: String(req.body?.entryFromTime ?? '09:30'),
      entryToTime: String(req.body?.entryToTime ?? '14:00'),
      minBreakoutBodyPct: Number(req.body?.minBreakoutBodyPct ?? 0.5),
      breakoutRangeMult: Number(req.body?.breakoutRangeMult ?? 1.0),
      breakoutVolumeMult: Number(req.body?.breakoutVolumeMult ?? 1.2),
      minTrendAdx: Number(req.body?.minTrendAdx ?? 0),
      atrPeriod: Number(req.body?.atrPeriod ?? 14),
      minAtrPct: Number(req.body?.minAtrPct ?? 0),
      maxAtrPct: Number(req.body?.maxAtrPct ?? 100),
      maxDailyLossAmount: Number(req.body?.maxDailyLossAmount ?? 0),
      maxConsecutiveLosses: Number(req.body?.maxConsecutiveLosses ?? 0),
      strikeStep: Number(req.body?.strikeStep ?? getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: Number(year),
    });

    const result = runStrategyBreakoutRetest({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy1_breakout_retest',
      symbol: settings.symbol,
      interval: String(interval),
      year: Number(year),
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: 'strategy1_breakout_retest',
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 1 - 15M Breakout + First Retest',
      year: Number(year),
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

async function runStrategyTwo(req, res) {
  try {
    const { symbol = 'NIFTY', interval = '5', year = 2026 } = req.body || {};
    const hasStopLossInput = String(req.body?.stopLossPct ?? '').trim() !== '';
    const hasTargetInput = String(req.body?.targetPct ?? '').trim() !== '';
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: Number(req.body?.basePremiumPct ?? 0.85),
      lotCount: Number(req.body?.lotCount ?? 1),
      lotSize: Number(req.body?.lotSize ?? getLotSize(symbol)),
      premiumLeverage: Number(req.body?.premiumLeverage ?? 8),
      stopLossPct: hasStopLossInput ? Number(req.body?.stopLossPct) : 12,
      targetPct: hasTargetInput ? Number(req.body?.targetPct) : null,
      maxTradesPerDay: Number(req.body?.maxTradesPerDay ?? 2),
      entryFromTime: String(req.body?.entryFromTime ?? '09:45'),
      entryToTime: String(req.body?.entryToTime ?? '14:30'),
      trendLookbackCandles: Number(req.body?.trendLookbackCandles ?? 10),
      pullbackLookbackCandles: Number(req.body?.pullbackLookbackCandles ?? 4),
      minBreakoutPct: Number(req.body?.minBreakoutPct ?? 0.001),
      minTrendAdx: Number(req.body?.minTrendAdx ?? 0),
      atrPeriod: Number(req.body?.atrPeriod ?? 14),
      minAtrPct: Number(req.body?.minAtrPct ?? 0),
      maxAtrPct: Number(req.body?.maxAtrPct ?? 100),
      maxDailyLossAmount: Number(req.body?.maxDailyLossAmount ?? 0),
      maxConsecutiveLosses: Number(req.body?.maxConsecutiveLosses ?? 0),
      strikeStep: Number(req.body?.strikeStep ?? getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: Number(year),
    });

    const result = runStrategyDowTheory({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy2_dow_theory',
      symbol: settings.symbol,
      interval: String(interval),
      year: Number(year),
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: 'strategy2_dow_theory',
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 2 - Dow Theory Trend Continuation',
      year: Number(year),
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

async function runStrategyThree(req, res) {
  try {
    const { symbol = 'NIFTY', interval = '5', year = 2026 } = req.body || {};
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: Number(req.body?.basePremiumPct ?? 0.85),
      lotCount: Number(req.body?.lotCount ?? 1),
      lotSize: Number(req.body?.lotSize ?? getLotSize(symbol)),
      premiumLeverage: Number(req.body?.premiumLeverage ?? 8),
      maxTradesPerDay: Number(req.body?.maxTradesPerDay ?? 20),
      entryFromTime: String(req.body?.entryFromTime ?? '09:30'),
      entryToTime: String(req.body?.entryToTime ?? '15:00'),
      adxLength: Number(req.body?.adxLength ?? 14),
      adxSmoothing: Number(req.body?.adxSmoothing ?? 10),
      macdFast: Number(req.body?.macdFast ?? 12),
      macdSlow: Number(req.body?.macdSlow ?? 26),
      macdSignal: Number(req.body?.macdSignal ?? 9),
      minAdx: Number(req.body?.minAdx ?? 0),
      strikeStep: Number(req.body?.strikeStep ?? getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: Number(year),
    });
    const result = runStrategyAdxMacdReversal({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy3_adx_macd_reversal',
      symbol: settings.symbol,
      interval: String(interval),
      year: Number(year),
      settings,
      summary: result.summary,
      status: 'completed',
    });
    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: 'strategy3_adx_macd_reversal',
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 3 - ADX/MACD Reversal Confluence',
      year: Number(year),
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


async function getRunTrades(req, res) {
  try {
    const { runId } = req.params;
    const strategyKey = String(req.query.strategyKey || 'strategy1_breakout_retest');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 25));
    const totalRows = await StrategyTrade.countDocuments({ runId, strategyKey });
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find({ runId, strategyKey })
      .sort({ entryTime: 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    return res.json({
      ok: true,
      runId,
      trades,
      pagination: { page: currentPage, pageSize, totalRows, totalPages },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getRunTradesByStrategy(req, res, strategyKey) {
  const mergedQuery = { ...req.query, strategyKey };
  const reqWithStrategy = { ...req, query: mergedQuery };
  return getRunTrades(reqWithStrategy, res);
}

async function getStrategyOneRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, 'strategy1_breakout_retest');
}

async function getStrategyTwoRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, 'strategy2_dow_theory');
}

async function getStrategyThreeRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, 'strategy3_adx_macd_reversal');
}

function runBacktestStub(req, res) {
  const { symbol, from, to } = req.body || {};
  if (!symbol || !from || !to) {
    return res.status(400).json({ error: 'symbol, from, and to (ISO dates) are required' });
  }
  return res.json({
    message: 'Backtest runner not implemented yet — add strategy logic next.',
    received: { symbol, from, to },
  });
}

module.exports = {
  health,
  getCandles,
  runStrategyOne,
  runStrategyTwo,
  runStrategyThree,
  getStrategyOneRunTrades,
  getStrategyTwoRunTrades,
  getStrategyThreeRunTrades,
  runBacktestStub,
};

const mongoose = require('mongoose');
const StrategyRun = require('../models/strategyRun');
const StrategyTrade = require('../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../utils/market');
const { getCandlesWithCache, fetchWithRateLimitRetry } = require('../services/dhanDataService');
const {
  runStrategyBreakoutRetest,
  runStrategyDowTheory,
  runStrategyAdxMacdReversal,
  runStrategyEmaVwapMacdHistogram,
} = require('../services/strategyService');

function parseNumberInput(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringInput(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = String(value).trim();
  return parsed.length > 0 ? parsed : fallback;
}

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
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.50),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      stopLossPct: hasStopLossInput ? parseNumberInput(req.body?.stopLossPct, 12) : 12,
      targetPct: hasTargetInput ? parseNumberInput(req.body?.targetPct, null) : null,
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 2),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:30'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      minBreakoutBodyPct: parseNumberInput(req.body?.minBreakoutBodyPct, 0.5),
      breakoutRangeMult: parseNumberInput(req.body?.breakoutRangeMult, 1.0),
      breakoutVolumeMult: parseNumberInput(req.body?.breakoutVolumeMult, 1.2),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });

    const result = runStrategyBreakoutRetest({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy1_breakout_retest',
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
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
      year: parseNumberInput(year, 2026),
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
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.50),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      stopLossPct: hasStopLossInput ? parseNumberInput(req.body?.stopLossPct, 12) : 12,
      targetPct: hasTargetInput ? parseNumberInput(req.body?.targetPct, null) : null,
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 2),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:45'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      trendLookbackCandles: parseNumberInput(req.body?.trendLookbackCandles, 10),
      pullbackLookbackCandles: parseNumberInput(req.body?.pullbackLookbackCandles, 4),
      minBreakoutPct: parseNumberInput(req.body?.minBreakoutPct, 0.001),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });

    const result = runStrategyDowTheory({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy2_dow_theory',
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
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
      year: parseNumberInput(year, 2026),
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
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.50),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 1),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:30'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      adxLength: parseNumberInput(req.body?.adxLength, 18),
      adxSmoothing: parseNumberInput(req.body?.adxSmoothing, 14),
      macdFast: parseNumberInput(req.body?.macdFast, 15),
      macdSlow: parseNumberInput(req.body?.macdSlow, 35),
      macdSignal: parseNumberInput(req.body?.macdSignal, 12),
      minAdx: parseNumberInput(req.body?.minAdx, 18),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });
    const result = runStrategyAdxMacdReversal({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy3_adx_macd_reversal',
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
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
      year: parseNumberInput(year, 2026),
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

async function runStrategyFour(req, res) {
  try {
    const { symbol = 'NIFTY', interval = '15', year = 2026 } = req.body || {};
    const hasStopLossInput = String(req.body?.stopLossPct ?? '').trim() !== '';
    const hasTargetInput = String(req.body?.targetPct ?? '').trim() !== '';
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.50),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      stopLossPct: hasStopLossInput ? parseNumberInput(req.body?.stopLossPct, 12) : null,
      targetPct: hasTargetInput ? parseNumberInput(req.body?.targetPct, null) : null,
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 2),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:30'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      emaLength: parseNumberInput(req.body?.emaLength, 9),
      macdFast: parseNumberInput(req.body?.macdFast, 12),
      macdSlow: parseNumberInput(req.body?.macdSlow, 26),
      macdSignal: parseNumberInput(req.body?.macdSignal, 9),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });
    const result = runStrategyEmaVwapMacdHistogram({ candles: payload.rows, settings });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy4_ema_vwap_macd_histogram',
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
      settings,
      summary: result.summary,
      status: 'completed',
    });
    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: 'strategy4_ema_vwap_macd_histogram',
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 4 - EMA9 + VWAP + MACD Histogram',
      year: parseNumberInput(year, 2026),
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
    const month = Number(req.query.month);
    const query = { runId, strategyKey };
    if (Number.isInteger(month) && month >= 1 && month <= 12) {
      const runDoc = await StrategyRun.findById(runId).select('year').lean();
      const year = Number(runDoc?.year);
      if (Number.isFinite(year) && year > 1900) {
        const monthStartUtc = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
        const monthEndUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
        query.entryTime = { $gte: monthStartUtc, $lt: monthEndUtc };
      }
    }

    const totalRows = await StrategyTrade.countDocuments(query);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find(query)
      .sort({ entryTime: 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    const aggMatch = { ...query };
    if (mongoose.Types.ObjectId.isValid(runId)) {
      aggMatch.runId = new mongoose.Types.ObjectId(runId);
    }

    const [summaryAgg] = await StrategyTrade.aggregate([
      { $match: aggMatch },
      {
        $group: {
          _id: null,
          totalTrades: { $sum: 1 },
          wins: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          grossProfit: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, '$pnl', 0] } },
          grossLoss: { $sum: { $cond: [{ $lt: ['$pnl', 0] }, '$pnl', 0] } },
          netPnl: { $sum: '$pnl' },
        },
      },
    ]);

    const totalTradesSummary = Number(summaryAgg?.totalTrades || 0);
    const winsSummary = Number(summaryAgg?.wins || 0);
    const lossesSummary = Math.max(0, totalTradesSummary - winsSummary);
    const summary = {
      totalTrades: totalTradesSummary,
      wins: winsSummary,
      losses: lossesSummary,
      winRate: totalTradesSummary ? Number(((winsSummary / totalTradesSummary) * 100).toFixed(2)) : 0,
      grossProfit: Number(Number(summaryAgg?.grossProfit || 0).toFixed(2)),
      grossLoss: Number(Number(summaryAgg?.grossLoss || 0).toFixed(2)),
      netPnl: Number(Number(summaryAgg?.netPnl || 0).toFixed(2)),
    };

    return res.json({
      ok: true,
      runId,
      trades,
      summary,
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

async function getStrategyFourRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, 'strategy4_ema_vwap_macd_histogram');
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
  runStrategyFour,
  getStrategyOneRunTrades,
  getStrategyTwoRunTrades,
  getStrategyThreeRunTrades,
  getStrategyFourRunTrades,
  runBacktestStub,
};

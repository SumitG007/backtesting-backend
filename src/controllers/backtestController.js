const StrategyRun = require('../models/strategyRun');
const StrategyTrade = require('../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../utils/market');
const { getCandlesWithCache, fetchWithRateLimitRetry } = require('../services/dhanDataService');
const { runStrategyBreakoutRetest } = require('../services/strategyService');

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
    const { symbol = 'NIFTY', interval = '5', year = 2025 } = req.body || {};
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: Number(req.body?.basePremiumPct ?? 0.85),
      lotCount: Number(req.body?.lotCount ?? 1),
      lotSize: Number(req.body?.lotSize ?? getLotSize(symbol)),
      premiumLeverage: Number(req.body?.premiumLeverage ?? 8),
      stopLossPct: Number(req.body?.stopLossPct ?? 10),
      targetPct: Number(req.body?.targetPct ?? 100),
      maxTradesPerDay: Number(req.body?.maxTradesPerDay ?? 1),
      entryFromTime: String(req.body?.entryFromTime ?? '09:30'),
      entryToTime: String(req.body?.entryToTime ?? '15:00'),
      minBreakoutBodyPct: Number(req.body?.minBreakoutBodyPct ?? 0.5),
      breakoutRangeMult: Number(req.body?.breakoutRangeMult ?? 1.0),
      minOpeningRangePct: Number(req.body?.minOpeningRangePct ?? 0.07),
      retestBufferPct: Number(req.body?.retestBufferPct ?? 0.08),
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

async function getRunTrades(req, res) {
  try {
    const { runId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 25));
    const totalRows = await StrategyTrade.countDocuments({ runId, strategyKey: 'strategy1_breakout_retest' });
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find({ runId, strategyKey: 'strategy1_breakout_retest' })
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
  getRunTrades,
  runBacktestStub,
};

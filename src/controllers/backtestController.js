const mongoose = require('mongoose');
const StrategyRun = require('../models/strategyRun');
const StrategyTrade = require('../models/strategyTrade');
const { getLotSize, getStrikeStep } = require('../utils/market');
const { getIstClock } = require('../utils/dateTime');
const { getCandlesWithCache, fetchWithRateLimitRetry } = require('../services/dhanDataService');
const {
  runStrategyConfirmationBreakout,
  runStrategyShortStraddle,
} = require('../services/strategyService');

// Mongo strategyKey constants are kept stable so historical runs and live trades remain readable.
const STRATEGY_ONE_KEY = 'strategy2_confirmation_breakout';
const STRATEGY_TWO_KEY = 'strategy3_short_straddle';

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
    const { symbol = 'NIFTY', interval = '15', year = 2026 } = req.body || {};
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.50),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
      targetPct: parseNumberInput(req.body?.targetPct, 12),
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 2),
      confirmationCandles: parseNumberInput(req.body?.confirmationCandles, 3),
      confirmationWindow: parseNumberInput(req.body?.confirmationWindow, 2),
      breakoutBufferPct: parseNumberInput(req.body?.breakoutBufferPct, 0.08),
      minRefRangePct: parseNumberInput(req.body?.minRefRangePct, 0.15),
      premiumStopLossCapPct: parseNumberInput(req.body?.premiumStopLossCapPct, 3),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:30'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });

    const result = runStrategyConfirmationBreakout({ candles: payload.rows, settings });
    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_ONE_KEY,
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
          strategyKey: STRATEGY_ONE_KEY,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 1 - Confirmation Breakout (Ref High/Low SL)',
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
    const { symbol = 'NIFTY', interval = '15', year = 2026 } = req.body || {};
    const skipExpiryDayRaw = req.body?.skipExpiryDay;
    const skipExpiryDay =
      skipExpiryDayRaw === undefined
        ? true
        : skipExpiryDayRaw !== false && skipExpiryDayRaw !== 'false';
    const settings = {
      symbol: String(symbol).toUpperCase(),
      basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      targetPct: parseNumberInput(req.body?.targetPct, 50),
      stopLossPct: parseNumberInput(req.body?.stopLossPct, 30),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '09:30'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      dayCloseTime: parseStringInput(req.body?.dayCloseTime, '09:20'),
      strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
      expiryWeekday: parseNumberInput(req.body?.expiryWeekday, 4),
      skipExpiryDay,
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    };

    const payload = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: String(interval),
      year: parseNumberInput(year, 2026),
    });

    const result = runStrategyShortStraddle({ candles: payload.rows, settings });
    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_TWO_KEY,
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
          strategyKey: STRATEGY_TWO_KEY,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 2 - Short Straddle (Overnight Hold)',
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
    const strategyKey = String(req.query.strategyKey || STRATEGY_ONE_KEY);
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

function buildValidationReport(trades) {
  const ordered = [...trades].sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  const monthlyMap = new Map();

  for (const trade of ordered) {
    const pnl = Number(trade.pnl || 0);
    equity += pnl;
    peak = Math.max(peak, equity);
    const dd = peak - equity;
    maxDrawdown = Math.max(maxDrawdown, dd);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (dd / peak) * 100);
    }

    if (pnl > 0) {
      wins += 1;
      grossProfit += pnl;
      winStreak += 1;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else if (pnl < 0) {
      losses += 1;
      grossLoss += pnl;
      lossStreak += 1;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }

    const ist = getIstClock(trade.entryTime);
    const monthKey = String(ist.dateKey || '').slice(0, 7);
    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, { month: monthKey, pnl: 0, trades: 0, wins: 0, losses: 0 });
    }
    const monthStats = monthlyMap.get(monthKey);
    monthStats.pnl += pnl;
    monthStats.trades += 1;
    if (pnl > 0) monthStats.wins += 1;
    if (pnl < 0) monthStats.losses += 1;
  }

  const totalTrades = ordered.length;
  const netPnl = equity;
  const avgWin = wins ? grossProfit / wins : 0;
  const avgLoss = losses ? Math.abs(grossLoss) / losses : 0;
  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const profitFactor = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? 999 : 0;
  const expectancy = totalTrades ? netPnl / totalTrades : 0;
  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      ...m,
      pnl: Number(m.pnl.toFixed(2)),
      winRate: m.trades ? Number(((m.wins / m.trades) * 100).toFixed(2)) : 0,
    }));

  return {
    assumptions: [
      'Backtest uses candle-level execution and modeled option premium movement.',
      'Real fills, slippage, spread, IV/theta shifts, and charges can reduce live performance.',
    ],
    stats: {
      totalTrades,
      wins,
      losses,
      winRate: Number(winRate.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      maxWinStreak,
      maxLossStreak,
    },
    monthly,
  };
}

async function getRunValidationByStrategy(req, res, strategyKey) {
  try {
    const { runId } = req.params;
    const query = { runId, strategyKey };
    const trades = await StrategyTrade.find(query).sort({ entryTime: 1 }).lean();
    const report = buildValidationReport(trades);
    return res.json({ ok: true, runId, strategyKey, validation: report });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getStrategyOneRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_ONE_KEY);
}

async function getStrategyOneValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_ONE_KEY);
}

async function getStrategyTwoRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_TWO_KEY);
}

async function getStrategyTwoValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_TWO_KEY);
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
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  getStrategyTwoRunTrades,
  getStrategyTwoValidation,
  runBacktestStub,
};

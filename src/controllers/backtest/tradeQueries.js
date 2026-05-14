const mongoose = require('mongoose');
const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getIstClock } = require('../../utils/dateTime');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { STRATEGY_TWO_KEY } = require('../../strategies/keys');

async function getRunTrades(req, res) {
  try {
    const { runId } = req.params;
    const strategyKey = String(req.query.strategyKey || STRATEGY_TWO_KEY);
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

    const summaryRows = await StrategyTrade.find(aggMatch).select('pnl charges reason').lean();
    const runForCosts = await StrategyRun.findById(runId).select('settings.perTradeCost').lean();
    const runPerTradeCost = Number(runForCosts?.settings?.perTradeCost);
    let rowsForSummary = summaryRows.map((r) => ({
      pnl: r.pnl,
      charges: Number.isFinite(Number(r.charges)) ? Number(r.charges) : 0,
      reason: r.reason,
    }));
    const allChargesMissing =
      rowsForSummary.length > 0 &&
      rowsForSummary.every((r) => !Number.isFinite(Number(r.charges)) || Number(r.charges) === 0);
    if (allChargesMissing && Number.isFinite(runPerTradeCost) && runPerTradeCost > 0) {
      rowsForSummary = rowsForSummary.map((r) => ({ ...r, charges: runPerTradeCost }));
    }
    const summary = buildStrategyRunSummary(rowsForSummary);

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

module.exports = {
  getRunTrades,
  getRunTradesByStrategy,
  getRunValidationByStrategy,
};

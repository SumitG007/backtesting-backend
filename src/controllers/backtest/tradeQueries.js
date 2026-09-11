const mongoose = require('mongoose');
const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { buildStrategyRunSummary } = require('../../strategies/shared/summary');
const { STRATEGY_TWO_KEY } = require('../../strategies/keys');
const { runMultiYearValidation } = require('./multiYearValidation');
const { buildValidationReport } = require('./buildValidationReport');
const { createRunBacktestForYear } = require('./runBacktestForYear');

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

async function getRunValidationByStrategy(req, res, strategyKey) {
  try {
    const { runId } = req.params;
    const run = await StrategyRun.findById(runId).select('strategyKey settings').lean();
    if (!run) {
      return res.status(404).json({ ok: false, error: 'Run not found' });
    }
    if (run.strategyKey !== strategyKey) {
      return res.status(400).json({ ok: false, error: 'Run does not match this strategy' });
    }
    const settings = run.settings || {};
    const report = await runMultiYearValidation({
      strategyKey,
      settings,
      runBacktestForYear: createRunBacktestForYear(strategyKey),
    });
    return res.json({
      ok: true,
      runId,
      strategyKey,
      validation: report.validation,
      byYear: report.byYear,
      years: report.years,
      errors: report.errors,
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

module.exports = {
  getRunTrades,
  getRunTradesByStrategy,
  getRunValidationByStrategy,
  buildValidationReport,
};

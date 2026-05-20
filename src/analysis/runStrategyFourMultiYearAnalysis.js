/**
 * Multi-year backtest analysis for Strategy 4 (no DB persist — report only).
 */

const { fetchWithRateLimitRetry } = require('../services/dhanDataService');
const { runBacktestInWorker } = require('../utils/runBacktestInWorker');
const { STRATEGY_FOUR_KEY } = require('../strategies/keys');
const { buildStrategyRunSummary } = require('../strategies/shared/summary');
const { buildValidationReport } = require('../controllers/backtest/tradeQueries');

const DEFAULT_YEARS = [2022, 2023, 2024, 2025, 2026];

function countByType(trades) {
  let pe = 0;
  let ce = 0;
  for (const t of trades) {
    const side = String(t.type || t.closed || '').toUpperCase();
    if (side === 'PE') pe += 1;
    else if (side === 'CE') ce += 1;
  }
  return { pe, ce };
}

function yearRowFromSummary(year, summary, trades, dataMeta) {
  const { pe, ce } = countByType(trades);
  const exits = summary.exitsByReason || {};
  return {
    year,
    candleCount: dataMeta.candleCount,
    dataFrom: dataMeta.fromDate,
    dataTo: dataMeta.toDate,
    totalTrades: summary.totalTrades,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.winRate,
    grossProfit: summary.grossProfit,
    grossLoss: summary.grossLoss,
    netPnl: summary.netPnl,
    profitFactor: summary.profitFactor,
    expectancyPerTrade: summary.expectancyPerTrade,
    avgWin: summary.avgWin,
    avgLoss: summary.avgLoss,
    bestTrade: summary.bestTrade,
    worstTrade: summary.worstTrade,
    totalCharges: summary.totalCharges,
    peTrades: pe,
    ceTrades: ce,
    exitsTarget: exits.TARGET || 0,
    exitsStopLoss: (exits.STOP_LOSS || 0) + (exits.TRAIL_STOP || 0),
    exitsPartial: exits.PARTIAL_TARGET || 0,
    exitsEma: exits.EMA_EXIT || 0,
    exitsTime: exits.TIME_EXIT || 0,
    exitsDayClose: exits.DAY_CLOSE || 0,
    exitsOther: exits.OTHER || 0,
  };
}

/**
 * @param {{ settings: Record<string, unknown>, years?: number[] }} opts
 */
async function runStrategyFourMultiYearAnalysis({ settings, years }) {
  const safeYears = (years?.length ? years : DEFAULT_YEARS).map(Number).filter(Number.isFinite);
  const startedAt = Date.now();
  const yearReports = [];
  const allTrades = [];
  const errors = [];

  for (const year of safeYears) {
    try {
      const payload = await fetchWithRateLimitRetry({
        symbol: settings.symbol,
        interval: settings.interval,
        year,
      });
      const result = await runBacktestInWorker(STRATEGY_FOUR_KEY, {
        candles: payload.rows,
        settings,
      });
      const trades = Array.isArray(result.trades) ? result.trades : [];
      const summary = result.summary || buildStrategyRunSummary(trades);
      allTrades.push(...trades);
      yearReports.push(
        yearRowFromSummary(year, summary, trades, {
          candleCount: payload.rows?.length || 0,
          fromDate: payload.fromDate,
          toDate: payload.toDate,
        }),
      );
    } catch (err) {
      errors.push({ year, error: err.message || String(err) });
      yearReports.push({
        year,
        error: err.message || String(err),
        totalTrades: 0,
        netPnl: 0,
      });
    }
  }

  yearReports.sort((a, b) => a.year - b.year);
  const combinedSummary = buildStrategyRunSummary(allTrades);
  const combinedTypes = countByType(allTrades);
  const validation = buildValidationReport(allTrades);

  const profitableYears = yearReports.filter((y) => !y.error && Number(y.netPnl) > 0).length;
  const losingYears = yearReports.filter((y) => !y.error && Number(y.netPnl) < 0).length;

  return {
    strategy: 'Strategy 4 - First hour open bias',
    symbol: settings.symbol,
    interval: settings.interval,
    years: safeYears,
    settings,
    combined: {
      ...combinedSummary,
      peTrades: combinedTypes.pe,
      ceTrades: combinedTypes.ce,
      profitableYears,
      losingYears,
      yearsWithData: yearReports.filter((y) => !y.error).length,
    },
    byYear: yearReports,
    validation,
    errors,
    meta: {
      durationMs: Date.now() - startedAt,
      totalTradesAllYears: allTrades.length,
      disclaimer:
        'Multi-year report runs the same backtest engine per calendar year. Past performance does not guarantee future results.',
    },
  };
}

module.exports = {
  runStrategyFourMultiYearAnalysis,
  DEFAULT_YEARS,
};

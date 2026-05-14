/**
 * Shared backtest metrics for all strategies (expects `pnl`; optional `charges`, `reason`).
 */

function buildStrategyRunSummary(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const totalTrades = rows.length;
  const winRows = rows.filter((t) => Number(t.pnl) > 0);
  const lossRows = rows.filter((t) => Number(t.pnl) < 0);
  const wins = winRows.length;
  const lossCount = lossRows.length;
  const netPnl = rows.reduce((acc, t) => acc + (Number(t.pnl) || 0), 0);
  const grossProfit = winRows.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const grossLoss = lossRows.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const totalCharges = rows.reduce((a, t) => a + (Number(t.charges) || 0), 0);
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = lossCount > 0 ? grossLoss / lossCount : 0;
  const avgLossAbs = lossCount > 0 ? Math.abs(avgLoss) : 0;
  const payoffRatio =
    wins > 0 && lossCount > 0 && avgLossAbs > 0 ? Number((avgWin / avgLossAbs).toFixed(3)) : null;
  let bestTrade = 0;
  let worstTrade = 0;
  for (const t of rows) {
    const p = Number(t.pnl) || 0;
    if (p > bestTrade) bestTrade = p;
    if (p < worstTrade) worstTrade = p;
  }
  const profitFactor =
    grossLoss < 0 && grossProfit > 0 ? Number((grossProfit / Math.abs(grossLoss)).toFixed(3)) : null;
  const expectancyPerTrade = totalTrades > 0 ? Number((netPnl / totalTrades).toFixed(2)) : 0;
  const grossBracket = grossProfit + Math.abs(grossLoss);
  const costPctOfGross =
    grossBracket > 0 && totalCharges > 0
      ? Number(((totalCharges / grossBracket) * 100).toFixed(2))
      : null;
  const reason = (r) => rows.filter((t) => String(t.reason || '') === r).length;
  const exitsByReason = {
    TARGET: reason('TARGET'),
    STOP_LOSS: reason('STOP_LOSS'),
    DAY_CLOSE: reason('DAY_CLOSE'),
    OTHER: rows.filter((t) => !['TARGET', 'STOP_LOSS', 'DAY_CLOSE'].includes(String(t.reason || ''))).length,
  };

  return {
    totalTrades,
    wins,
    losses: Math.max(0, totalTrades - wins),
    lossCount,
    winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(2)) : 0,
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netPnl: Number(netPnl.toFixed(2)),
    avgWin: wins ? Number(avgWin.toFixed(2)) : 0,
    avgLoss: lossCount ? Number(avgLoss.toFixed(2)) : 0,
    avgLossAbs: lossCount ? Number(avgLossAbs.toFixed(2)) : 0,
    payoffRatio,
    profitFactor,
    expectancyPerTrade,
    totalCharges: Number(totalCharges.toFixed(2)),
    costPctOfGross,
    bestTrade: Number(bestTrade.toFixed(2)),
    worstTrade: Number(worstTrade.toFixed(2)),
    exitsByReason,
  };
}

function getSummaryFromTrades(trades) {
  return buildStrategyRunSummary(trades);
}

module.exports = {
  buildStrategyRunSummary,
  getSummaryFromTrades,
};

const { getIstClock } = require('../../utils/dateTime');

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
  let slTrades = 0;
  let targetTrades = 0;
  let eodTrades = 0;
  const monthlyMap = new Map();

  for (const trade of ordered) {
    const pnl = Number(trade.pnl || 0);
    const reason = String(trade.reason || '').toUpperCase();
    if (reason === 'STOP_LOSS' || reason === 'TRAIL_STOP' || reason === 'BREAKEVEN_STOP') slTrades += 1;
    else if (reason === 'TARGET' || reason === 'PATTERN_TARGET') targetTrades += 1;
    else if (reason === 'DAY_CLOSE' || reason === 'OPENING_15M_CLOSE') eodTrades += 1;

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
      monthlyMap.set(monthKey, { month: monthKey, pnl: 0, trades: 0, wins: 0, losses: 0, slTrades: 0 });
    }
    const monthStats = monthlyMap.get(monthKey);
    monthStats.pnl += pnl;
    monthStats.trades += 1;
    if (pnl > 0) monthStats.wins += 1;
    if (pnl < 0) monthStats.losses += 1;
    if (reason === 'STOP_LOSS') monthStats.slTrades += 1;
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
      profitTrades: wins,
      lossTrades: losses,
      slTrades,
      targetTrades,
      eodTrades,
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

/**
 * Merge per-year validation reports into one combined report (stats + monthly).
 * Max drawdown uses chronological monthly equity; streaks are omitted (not shown in UI).
 * @param {Array<{ stats?: object, monthly?: object[] }>} reports
 * @param {string[]} [assumptions]
 */
function mergeValidationReports(reports, assumptions) {
  const list = (reports || []).filter(Boolean);
  if (list.length === 0) {
    return {
      assumptions: assumptions || [],
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        profitTrades: 0,
        lossTrades: 0,
        slTrades: 0,
        targetTrades: 0,
        eodTrades: 0,
        winRate: 0,
        netPnl: 0,
        grossProfit: 0,
        grossLoss: 0,
        profitFactor: 0,
        expectancy: 0,
        avgWin: 0,
        avgLoss: 0,
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        maxWinStreak: 0,
        maxLossStreak: 0,
      },
      monthly: [],
    };
  }
  if (list.length === 1) return list[0];

  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let slTrades = 0;
  let targetTrades = 0;
  let eodTrades = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netPnl = 0;
  const monthlyMap = new Map();

  for (const report of list) {
    const s = report.stats || {};
    totalTrades += Number(s.totalTrades) || 0;
    wins += Number(s.wins ?? s.profitTrades) || 0;
    losses += Number(s.losses ?? s.lossTrades) || 0;
    slTrades += Number(s.slTrades) || 0;
    targetTrades += Number(s.targetTrades) || 0;
    eodTrades += Number(s.eodTrades) || 0;
    grossProfit += Number(s.grossProfit) || 0;
    grossLoss += Number(s.grossLoss) || 0;
    netPnl += Number(s.netPnl) || 0;

    for (const m of report.monthly || []) {
      const key = m.month;
      if (!monthlyMap.has(key)) {
        monthlyMap.set(key, { month: key, pnl: 0, trades: 0, wins: 0, losses: 0, slTrades: 0 });
      }
      const agg = monthlyMap.get(key);
      agg.pnl += Number(m.pnl) || 0;
      agg.trades += Number(m.trades) || 0;
      agg.wins += Number(m.wins) || 0;
      agg.losses += Number(m.losses) || 0;
      agg.slTrades += Number(m.slTrades) || 0;
    }
  }

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      equity += m.pnl;
      peak = Math.max(peak, equity);
      const dd = peak - equity;
      maxDrawdown = Math.max(maxDrawdown, dd);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (dd / peak) * 100);
      return {
        ...m,
        pnl: Number(m.pnl.toFixed(2)),
        winRate: m.trades ? Number(((m.wins / m.trades) * 100).toFixed(2)) : 0,
      };
    });

  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const profitFactor = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? 999 : 0;
  const expectancy = totalTrades ? netPnl / totalTrades : 0;
  const avgWin = wins ? grossProfit / wins : 0;
  const avgLoss = losses ? Math.abs(grossLoss) / losses : 0;
  const firstAssumptions = list.find((r) => Array.isArray(r.assumptions) && r.assumptions.length)?.assumptions;

  return {
    assumptions: assumptions || firstAssumptions || [],
    stats: {
      totalTrades,
      wins,
      losses,
      profitTrades: wins,
      lossTrades: losses,
      slTrades,
      targetTrades,
      eodTrades,
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
      maxWinStreak: 0,
      maxLossStreak: 0,
    },
    monthly,
  };
}

module.exports = { buildValidationReport, mergeValidationReports };

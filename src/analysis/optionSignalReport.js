const { PATTERN_RULES, runPrototypeBacktest } = require('./suggestedStrategy');

const SL_TG_GRID = [
  { stopLossPoints: 18, targetPoints: 35 },
  { stopLossPoints: 20, targetPoints: 40 },
  { stopLossPoints: 25, targetPoints: 40 },
  { stopLossPoints: 25, targetPoints: 50 },
];

function bestPrototypeForPattern({ days, intraByDay, patternId }) {
  let best = null;
  for (const g of SL_TG_GRID) {
    const bt = runPrototypeBacktest({
      days,
      intraByDay,
      patternId,
      stopLossPoints: g.stopLossPoints,
      targetPoints: g.targetPoints,
    });
    const net = Number(bt.summary.netPnl) || 0;
    if (!best || net > best.netPnl) {
      best = {
        stopLossPoints: g.stopLossPoints,
        targetPoints: g.targetPoints,
        netPnl: net,
        winRate: bt.summary.winRate,
        totalTrades: bt.summary.totalTrades,
        profitFactor: bt.summary.profitFactor,
      };
    }
  }
  return best;
}

/**
 * Rank historical patterns by CALL (CE) vs PUT (PE) prototype index-point backtests.
 */
function buildOptionSignalReport({ patterns, days, intraByDay }) {
  const callBuy = [];
  const putBuy = [];

  for (const p of patterns) {
    if (p.tradeable === false || p.skipped || !PATTERN_RULES[p.id]) continue;
    const rule = PATTERN_RULES[p.id];
    const proto = bestPrototypeForPattern({ days, intraByDay, patternId: p.id });
    const row = {
      patternId: p.id,
      label: p.label,
      description: p.description,
      optionType: rule.optionType,
      direction: rule.direction,
      entryIstMinutes: rule.entryMinutes,
      historicalDayWinRate: p.winRate,
      sampleDays: p.sampleSize,
      avgDayPointsWhenMatched: p.avgDayPoints,
      prototype: proto,
    };
    if (rule.optionType === 'CE') callBuy.push(row);
    else putBuy.push(row);
  }

  const byNet = (a, b) => (b.prototype?.netPnl ?? -Infinity) - (a.prototype?.netPnl ?? -Infinity);
  callBuy.sort(byNet);
  putBuy.sort(byNet);

  return {
    note: 'Prototype exits use index points (SL/target intraday), not option premiums. Use for rule selection only.',
    slTgGridTested: SL_TG_GRID,
    callBuy,
    putBuy,
    recommendedCall: callBuy[0] || null,
    recommendedPut: putBuy[0] || null,
  };
}

module.exports = {
  buildOptionSignalReport,
  SL_TG_GRID,
};

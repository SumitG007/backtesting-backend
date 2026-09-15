/** Normalize backtest trade rows for StrategyTrade.insertMany. */
function mapTradesForInsert(trades, runId, strategyKey) {
  return trades.map((t) => ({
    ...t,
    runId,
    strategyKey,
    entryTime: new Date(t.entryTime),
    exitTime: new Date(t.exitTime),
    dayHighTime: t.dayHighTime ? new Date(t.dayHighTime) : null,
    dayLowTime: t.dayLowTime ? new Date(t.dayLowTime) : null,
    patternBarTime: t.patternBarTime ? new Date(t.patternBarTime) : null,
    prevBarTime: t.prevBarTime ? new Date(t.prevBarTime) : null,
    breakoutBarTime: t.breakoutBarTime ? new Date(t.breakoutBarTime) : null,
  }));
}

module.exports = { mapTradesForInsert };

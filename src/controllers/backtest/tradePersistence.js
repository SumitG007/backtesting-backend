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
  }));
}

module.exports = { mapTradesForInsert };

function getIntervalMeta(interval) {
  const m = Number(interval) || 5;
  const labels = { 1: '1 minute', 5: '5 minutes', 15: '15 minutes' };
  let note =
    'Patterns measure day-close bias (green/red) unless you run the index prototype backtest.';
  if (m === 15) {
    note +=
      ' On 15m candles the first 30 minutes are only two bars (9:15 and 9:30); holds and breakouts use each bar high/low, not every tick inside the bar. For opening-range rules, 5m is usually more accurate than 15m.';
  } else if (m === 1) {
    note +=
      ' 1m gives the finest open/break detection but more noise; 5m is a common balance for NIFTY intraday research.';
  }
  return {
    intervalMinutes: m,
    intervalLabel: labels[m] || `${m} minutes`,
    note,
  };
}

module.exports = { getIntervalMeta };

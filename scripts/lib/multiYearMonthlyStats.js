const { getIstClock } = require('../../src/utils/dateTime');
const { getLotSize } = require('../../src/utils/market');

function monthKey(iso) {
  return getIstClock(iso).dateKey.slice(0, 7);
}

function analyzeTrades(trades, symbol = 'NIFTY') {
  const byMonth = new Map();
  let totalInvested = 0;
  let investedCount = 0;

  for (const t of trades) {
    const mk = monthKey(t.entryTime);
    if (!byMonth.has(mk)) {
      byMonth.set(mk, { net: 0, trades: 0, invested: 0, wins: 0, targets: 0, stops: 0 });
    }
    const m = byMonth.get(mk);
    const pnl = Number(t.pnl) || 0;
    const inv = Number(t.invested ?? t.investmentAmount) || 0;
    m.net += pnl;
    m.trades += 1;
    if (inv > 0) {
      m.invested += inv;
      totalInvested += inv;
      investedCount += 1;
    }
    if (pnl > 0) m.wins += 1;
    const r = String(t.reason || '');
    if (r === 'TARGET') m.targets += 1;
    if (r === 'STOP_LOSS') m.stops += 1;
  }

  const months = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, m]) => {
      const avgInvested = m.trades > 0 ? m.invested / m.trades : 0;
      const lotThreshold = avgInvested > 0 ? avgInvested : 120 * getLotSize(symbol);
      return {
        month: key,
        net: Number(m.net.toFixed(2)),
        trades: m.trades,
        avgInvested: Number(avgInvested.toFixed(2)),
        meetsGoal: m.net >= lotThreshold,
        meets5k: m.net >= 5000,
        meets10k: m.net >= 10000,
        winRate: m.trades ? Number(((m.wins / m.trades) * 100).toFixed(1)) : 0,
        targets: m.targets,
        stops: m.stops,
      };
    });

  const greenMonths = months.filter((m) => m.meetsGoal).length;
  const months5k = months.filter((m) => m.meets5k).length;
  const positiveMonths = months.filter((m) => m.net > 0).length;
  const avgMonthlyNet =
    months.length > 0 ? months.reduce((a, m) => a + m.net, 0) / months.length : 0;
  const worstMonth = months.length
    ? months.reduce((w, m) => (m.net < w.net ? m : w), months[0])
    : null;
  const bestMonth = months.length
    ? months.reduce((b, m) => (m.net > b.net ? m : b), months[0])
    : null;

  return {
    months,
    greenMonths,
    months5k,
    positiveMonths,
    totalMonths: months.length,
    pctPositive: months.length ? Number(((positiveMonths / months.length) * 100).toFixed(1)) : 0,
    pct5k: months.length ? Number(((months5k / months.length) * 100).toFixed(1)) : 0,
    avgMonthlyNet: Number(avgMonthlyNet.toFixed(2)),
    worstMonth,
    bestMonth,
  };
}

function countExits(trades) {
  const exits = { TARGET: 0, STOP_LOSS: 0, DAY_CLOSE: 0, OTHER: 0 };
  for (const t of trades) {
    const r = String(t.reason || 'OTHER');
    if (exits[r] != null) exits[r] += 1;
    else exits.OTHER += 1;
  }
  return exits;
}

module.exports = {
  monthKey,
  analyzeTrades,
  countExits,
};

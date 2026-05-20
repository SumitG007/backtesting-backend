const { getIstClock } = require('../utils/dateTime');

/** Cash session 09:15–15:30 IST, grouped by calendar day. */
function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  }
  return m;
}

/** Daily OHLC from intraday rows (one row per session). */
function buildDailyFromIntraday(intraByDay) {
  const m = new Map();
  for (const [dateKey, bars] of intraByDay) {
    if (!bars.length) continue;
    const open = Number(bars[0][1]);
    let high = -Infinity;
    let low = Infinity;
    let close = Number(bars[bars.length - 1][4]);
    for (const c of bars) {
      high = Math.max(high, Number(c[2]));
      low = Math.min(low, Number(c[3]));
      close = Number(c[4]);
    }
    if (![open, high, low, close].every(Number.isFinite)) continue;
    m.set(dateKey, { open, high, low, close });
  }
  return m;
}

function sortedDateKeys(map) {
  return Array.from(map.keys()).sort();
}

module.exports = {
  buildIntradayByDay,
  buildDailyFromIntraday,
  sortedDateKeys,
};

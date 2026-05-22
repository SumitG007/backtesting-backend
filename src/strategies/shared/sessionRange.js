/**
 * Cash-session day high/low from intraday OHLC bars [ts, o, h, l, c, v?].
 */

function computeSessionHighLow(dayBars) {
  let dayHigh = null;
  let dayLow = null;
  let dayHighTime = null;
  let dayLowTime = null;
  for (const bar of dayBars || []) {
    const hi = Number(bar[2]);
    const lo = Number(bar[3]);
    if (Number.isFinite(hi) && (dayHigh == null || hi >= dayHigh)) {
      dayHigh = hi;
      dayHighTime = bar[0];
    }
    if (Number.isFinite(lo) && (dayLow == null || lo <= dayLow)) {
      dayLow = lo;
      dayLowTime = bar[0];
    }
  }
  return {
    dayHigh: dayHigh != null ? Number(dayHigh.toFixed(2)) : null,
    dayLow: dayLow != null ? Number(dayLow.toFixed(2)) : null,
    dayHighTime: dayHighTime || null,
    dayLowTime: dayLowTime || null,
  };
}

module.exports = { computeSessionHighLow };

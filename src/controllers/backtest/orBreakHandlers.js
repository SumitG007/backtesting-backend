const fs = require('fs');
const path = require('path');
const {
  runOrBreakReport,
  runYearlyBreakdown,
  DEFAULT,
} = require('../../strategies/orBreakMidday/engine');
const { DISK_CACHE_DIR } = require('../../analysis/loadCandlesMultiYear');

const SYMBOL = 'NIFTY';
const INTERVAL = '5';
const AVAILABLE_YEARS = [2021, 2022, 2023, 2024, 2025, 2026];

function diskCachePath(year) {
  return path.join(DISK_CACHE_DIR, `${SYMBOL}-${INTERVAL}-${year}.json`);
}

function listCachedYears() {
  return AVAILABLE_YEARS.filter((y) => fs.existsSync(diskCachePath(y)));
}

function loadCachedRows(years) {
  const rows = [];
  for (const year of years) {
    const fp = diskCachePath(year);
    if (!fs.existsSync(fp)) continue;
    rows.push(...JSON.parse(fs.readFileSync(fp, 'utf8')));
  }
  rows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return rows;
}

function lastDayOfMonth(year, month) {
  const d = new Date(Date.UTC(Number(year), Number(month), 0));
  const day = String(d.getUTCDate()).padStart(2, '0');
  const m = String(month).padStart(2, '0');
  return `${year}-${m}-${day}`;
}

function getOrBreakMeta(req, res) {
  try {
    const years = listCachedYears();
    return res.json({
      ok: true,
      symbol: SYMBOL,
      interval: INTERVAL,
      years,
      settings: DEFAULT,
      strategy: {
        name: 'OR Break Midday Chase',
        description:
          'Opening range 9:15–9:45 break · entry 11:00–13:30 · structural SL · 3× ATR trail · max 1 trade/day',
        bestStats: '42/56 green months · +5,535 pts (2022–Aug 2026) from 16k+ scenario search',
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function postOrBreakRun(req, res) {
  try {
    const years = listCachedYears();
    if (!years.length) {
      return res.status(404).json({
        ok: false,
        error: 'No NIFTY candle cache found. Run: node scripts/saveCandleCache.js NIFTY 5',
      });
    }

    const allYears = req.body?.allYears === true;
    const year = Number(req.body?.year);
    const month = String(req.body?.month || '').trim();

    if (allYears && !year && !month) {
      const rows = loadCachedRows(years);
      const yearly = runYearlyBreakdown(rows, years);
      const totals = yearly.reduce(
        (acc, y) => ({
          trades: acc.trades + y.trades,
          wins: acc.wins + y.wins,
          netPoints: Number((acc.netPoints + y.netPoints).toFixed(2)),
          bigWin3R: acc.bigWin3R + y.bigWin3R,
        }),
        { trades: 0, wins: 0, netPoints: 0, bigWin3R: 0 },
      );
      totals.winRate = totals.trades
        ? Number(((totals.wins / totals.trades) * 100).toFixed(1))
        : 0;

      const allMonthly = yearly.flatMap((y) => y.monthly || []);
      const positiveMonths = allMonthly.filter((m) => m.netPoints > 0).length;

      return res.json({
        ok: true,
        mode: 'all-years',
        symbol: SYMBOL,
        interval: INTERVAL,
        years,
        totals: { ...totals, positiveMonths, totalMonths: allMonthly.length },
        yearly: yearly.map((y) => ({
          year: y.year,
          trades: y.trades,
          wins: y.wins,
          winRate: y.winRate,
          netPoints: y.netPoints,
          bigWin3R: y.bigWin3R,
          avgR: y.avgR,
          monthly: y.monthly,
        })),
      });
    }

    const targetYear = Number.isFinite(year) ? year : years[years.length - 1];
    if (!years.includes(targetYear)) {
      return res.status(400).json({ ok: false, error: `No cache for year ${targetYear}` });
    }

    let fromDate = `${targetYear}-01-01`;
    let toDate = `${targetYear}-12-31`;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      fromDate = `${month}-01`;
      toDate = lastDayOfMonth(month.slice(0, 4), month.slice(5, 7));
    }

    const rows = loadCachedRows([targetYear]);
    const report = runOrBreakReport(rows, { fromDate, toDate });

    return res.json({
      ok: true,
      mode: month ? 'month' : 'year',
      symbol: SYMBOL,
      interval: INTERVAL,
      year: targetYear,
      month: month || null,
      fromDate,
      toDate,
      ...report,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOrBreakMeta,
  postOrBreakRun,
};

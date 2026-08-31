const fs = require('fs');
const path = require('path');
const { getCandlesWithCache } = require('./dhanDataService');
const { getIstClock } = require('../utils/dateTime');

const DISK_CACHE_DIR = path.join(__dirname, '../../scripts/candle-cache');

function diskCachePath(symbol, interval, year) {
  return path.join(DISK_CACHE_DIR, `${symbol}-${interval}-${year}.json`);
}

function istYearToday() {
  const clock = getIstClock(new Date());
  return {
    year: Number(String(clock.dateKey).slice(0, 4)),
    dateKey: clock.dateKey,
  };
}

function lastRowDateKey(rows) {
  if (!rows?.length) return null;
  try {
    return getIstClock(rows[rows.length - 1][0]).dateKey;
  } catch {
    return null;
  }
}

function writeDiskCache(symbol, interval, year, rows) {
  fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
  const fp = diskCachePath(symbol, interval, year);
  fs.writeFileSync(fp, JSON.stringify(rows));
  return fp;
}

/**
 * Load one calendar year of NIFTY 5m candles.
 * Past years: prefer disk cache.
 * Current IST year: always refresh from Dhan through today (stale disk was stopping at May).
 */
async function loadYearCandles({ symbol = 'NIFTY', interval = '5', year, refresh = false }) {
  const y = Number(year);
  if (!Number.isFinite(y) || y < 2018 || y > 2030) {
    throw new Error(`Invalid year: ${year}`);
  }

  const { year: currentIstYear, dateKey: todayIst } = istYearToday();
  const isCurrentYear = y === currentIstYear;
  const fp = diskCachePath(symbol, interval, y);

  // Past years: use disk if present (unless forced refresh)
  if (!isCurrentYear && !refresh && fs.existsSync(fp)) {
    const rows = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`Empty candle cache for ${symbol} ${interval}m ${y}`);
    }
    return {
      rows,
      year: y,
      symbol,
      interval: String(interval),
      source: 'disk-cache',
      barCount: rows.length,
      fromDate: rows[0]?.[0] || null,
      toDate: rows[rows.length - 1]?.[0] || null,
      throughDateKey: lastRowDateKey(rows),
    };
  }

  // Current year (or refresh): fetch from Dhan through today, then update disk.
  console.log(
    `[LIQ BACKTEST] fetching ${symbol} ${interval}m ${y} from Dhan through ${isCurrentYear ? todayIst : 'year-end'}…`,
  );
  try {
    const payload = await getCandlesWithCache({
      symbol,
      interval: String(interval),
      year: y,
      refresh: true, // always bypass in-memory year cache for current year
    });
    const rows = payload?.rows || [];
    if (!rows.length) {
      throw new Error('Dhan returned empty candle set');
    }

    try {
      writeDiskCache(symbol, interval, y, rows);
      console.log(
        `[LIQ BACKTEST] saved disk cache ${symbol}-${interval}-${y}.json · ${rows.length} bars · through ${lastRowDateKey(rows)}`,
      );
    } catch (err) {
      console.warn('[LIQ BACKTEST] disk save failed', err.message);
    }

    return {
      rows,
      year: y,
      symbol,
      interval: String(interval),
      source: 'dhan-refresh',
      barCount: rows.length,
      fromDate: payload.fromDate || rows[0]?.[0] || null,
      toDate: payload.toDate || rows[rows.length - 1]?.[0] || null,
      throughDateKey: lastRowDateKey(rows),
    };
  } catch (err) {
    if (fs.existsSync(fp)) {
      const diskRows = JSON.parse(fs.readFileSync(fp, 'utf8'));
      console.warn(
        `[LIQ BACKTEST] Dhan refresh failed (${err.message}) — using stale disk through ${lastRowDateKey(diskRows)}`,
      );
      return {
        rows: diskRows,
        year: y,
        symbol,
        interval: String(interval),
        source: 'disk-cache-stale',
        barCount: diskRows.length,
        fromDate: diskRows[0]?.[0] || null,
        toDate: diskRows[diskRows.length - 1]?.[0] || null,
        throughDateKey: lastRowDateKey(diskRows),
        refreshError: err.message,
      };
    }
    throw new Error(
      `No candles for ${symbol} ${interval}m ${y}. ${err.message}`,
    );
  }
}

function listCachedYears(symbol = 'NIFTY', interval = '5') {
  const years = [];
  if (!fs.existsSync(DISK_CACHE_DIR)) return years;
  for (const name of fs.readdirSync(DISK_CACHE_DIR)) {
    const m = new RegExp(`^${symbol}-${interval}-(\\d{4})\\.json$`).exec(name);
    if (m) years.push(Number(m[1]));
  }
  return years.sort((a, b) => a - b);
}

module.exports = {
  loadYearCandles,
  listCachedYears,
  diskCachePath,
};

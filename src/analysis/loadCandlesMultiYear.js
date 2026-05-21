const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getCandlesWithCache } = require('../services/dhanDataService');

const DEFAULT_YEARS = [2022, 2023, 2024, 2025, 2026];
const DISK_CACHE_DIR = path.join(__dirname, '../../scripts/candle-cache');

function diskCachePath(symbol, interval, year) {
  return path.join(DISK_CACHE_DIR, `${symbol}-${interval}-${year}.json`);
}

async function loadViaDisk({ symbol, interval, years }) {
  const yearStats = {};
  const allRows = [];
  for (const year of years) {
    const fp = diskCachePath(symbol, interval, year);
    if (!fs.existsSync(fp)) throw new Error(`Missing disk cache: ${fp}`);
    const rows = JSON.parse(fs.readFileSync(fp, 'utf8'));
    yearStats[year] = { candleCount: rows.length, fromDate: null, toDate: null };
    allRows.push(...rows);
  }
  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { allRows, yearStats, source: 'disk-cache' };
}

function diskCacheComplete(symbol, interval, years) {
  return years.every((y) => fs.existsSync(diskCachePath(symbol, interval, y)));
}

async function loadViaDhan({ symbol, interval, years }) {
  const yearStats = {};
  const allRows = [];
  for (const year of years) {
    const payload = await getCandlesWithCache({
      symbol,
      interval: String(interval),
      year: Number(year),
      refresh: false,
    });
    yearStats[year] = {
      candleCount: payload.rows.length,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
    };
    allRows.push(...payload.rows);
  }
  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { allRows, yearStats, source: 'dhan-cache' };
}

async function loadViaApi({ symbol, interval, years, baseUrl }) {
  const BASE = baseUrl || process.env.DISCOVERY_API || 'http://localhost:3001/api';
  await axios.get(`${BASE}/health`, { timeout: 8000 });

  const yearStats = {};
  const allRows = [];
  for (const year of years) {
    let page = 1;
    let totalPages = 1;
    const rows = [];
    while (page <= totalPages) {
      const { data } = await axios.get(`${BASE}/data/candles`, {
        params: { symbol, interval, year, page, pageSize: 1000 },
        timeout: 120000,
      });
      if (!data.ok) throw new Error(data.error || `candles failed ${year}`);
      rows.push(...(data.data?.candles || []));
      totalPages = data.pagination?.totalPages || 1;
      page += 1;
    }
    yearStats[year] = { candleCount: rows.length, fromDate: null, toDate: null };
    allRows.push(...rows);
  }
  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { allRows, yearStats, source: 'api' };
}

function isCredentialError(err) {
  const m = String(err?.message || err || '');
  return m.includes('credentials missing') || m.includes('DHAN_CLIENT_ID');
}

/**
 * @param {{ symbol: string, interval: string, years: number[], preferApi?: boolean }} opts
 */
async function loadCandlesMultiYear({ symbol, interval, years, preferApi = false }) {
  const safeYears = (years?.length ? years : DEFAULT_YEARS).map(Number).filter(Number.isFinite);
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const intv = String(interval || '5');

  if (diskCacheComplete(sym, intv, safeYears)) {
    return loadViaDisk({ symbol: sym, interval: intv, years: safeYears });
  }
  if (preferApi || process.env.DISCOVERY_API) {
    try {
      return await loadViaApi({ symbol: sym, interval: intv, years: safeYears });
    } catch (apiErr) {
      if (diskCacheComplete(sym, intv, safeYears)) {
        return loadViaDisk({ symbol: sym, interval: intv, years: safeYears });
      }
      throw apiErr;
    }
  }
  try {
    return await loadViaDhan({ symbol: sym, interval: intv, years: safeYears });
  } catch (err) {
    if (!isCredentialError(err)) throw err;
    try {
      return await loadViaApi({ symbol: sym, interval: intv, years: safeYears });
    } catch (apiErr) {
      throw new Error(
        `${err.message}\nAlso failed API fallback: ${apiErr.message}\nSave candles: npm run cache:candles (backend + Dhan up)`
      );
    }
  }
}

async function saveCandlesToDisk({ symbol, interval, years, preferApi = true }) {
  const loaded = await loadCandlesMultiYear({ symbol, interval, years, preferApi });
  fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
  const sym = String(symbol || 'NIFTY').toUpperCase();
  const intv = String(interval || '5');
  const byYear = {};
  for (const row of loaded.allRows) {
    const y = new Date(row[0]).getUTCFullYear();
    if (!byYear[y]) byYear[y] = [];
    byYear[y].push(row);
  }
  for (const year of years) {
    const rows = byYear[year] || [];
    fs.writeFileSync(diskCachePath(sym, intv, year), JSON.stringify(rows));
  }
  return { savedYears: years, dir: DISK_CACHE_DIR, total: loaded.allRows.length };
}

module.exports = {
  loadCandlesMultiYear,
  saveCandlesToDisk,
  DEFAULT_YEARS,
  DISK_CACHE_DIR,
};

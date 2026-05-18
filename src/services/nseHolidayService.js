const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { isWeekendDateKey, getIstClock } = require('../utils/dateTime');

const NSE_HOME_URL = 'https://www.nseindia.com';
const NSE_HOLIDAY_URL = 'https://www.nseindia.com/api/holiday-master?type=trading';
/** NIFTY F&O — same trading holidays as equity cash for full-day closures. */
const HOLIDAY_SEGMENT = 'FO';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FALLBACK_FILE = path.join(__dirname, '../../data/nse-fo-trading-holidays.json');

const holidayByDateKey = new Map();
let lastFetchedAt = 0;
let refreshInFlight = null;
let dailyTimer = null;

function parseNseTradingDate(tradingDate) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(tradingDate || '').trim());
  if (!match) return null;
  const months = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const month = months[match[2]];
  if (!month) return null;
  const day = String(match[1]).padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function ingestHolidayRows(rows) {
  holidayByDateKey.clear();
  for (const row of rows || []) {
    const dateKey = parseNseTradingDate(row.tradingDate);
    if (!dateKey || isWeekendDateKey(dateKey)) continue;
    holidayByDateKey.set(dateKey, String(row.description || 'NSE trading holiday'));
  }
}

function readFallbackFile() {
  try {
    if (!fs.existsSync(FALLBACK_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    const rows = Array.isArray(raw?.rows) ? raw.rows : raw;
    if (!Array.isArray(rows) || rows.length < 1) return false;
    ingestHolidayRows(rows);
    lastFetchedAt = Number(raw?.fetchedAt) || Date.now();
    return true;
  } catch {
    return false;
  }
}

function writeFallbackFile(rows) {
  try {
    const dir = path.dirname(FALLBACK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const nextRowsJson = JSON.stringify(rows);
    if (fs.existsSync(FALLBACK_FILE)) {
      try {
        const existing = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
        if (JSON.stringify(existing?.rows) === nextRowsJson) return;
      } catch {
        /* rewrite corrupt fallback */
      }
    }
    fs.writeFileSync(
      FALLBACK_FILE,
      JSON.stringify({ fetchedAt: Date.now(), segment: HOLIDAY_SEGMENT, rows }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.warn('[NSE Holidays] Could not write fallback file:', err.message);
  }
}

async function fetchTradingHolidaysFromNse() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.nseindia.com/',
  };
  await axios.get(NSE_HOME_URL, { headers, timeout: 20000 });
  const response = await axios.get(NSE_HOLIDAY_URL, { headers, timeout: 20000 });
  const rows = response.data?.[HOLIDAY_SEGMENT];
  if (!Array.isArray(rows) || rows.length < 1) {
    throw new Error(`NSE holiday API returned no ${HOLIDAY_SEGMENT} rows`);
  }
  return rows;
}

async function refreshNseHolidayCache({ force = false } = {}) {
  if (!force && holidayByDateKey.size > 0 && Date.now() - lastFetchedAt < CACHE_TTL_MS) {
    return { ok: true, source: 'memory', count: holidayByDateKey.size };
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const rows = await fetchTradingHolidaysFromNse();
      ingestHolidayRows(rows);
      lastFetchedAt = Date.now();
      writeFallbackFile(rows);
      console.log(`[NSE Holidays] Loaded ${holidayByDateKey.size} weekday F&O holidays from NSE`);
      return { ok: true, source: 'nse', count: holidayByDateKey.size };
    } catch (err) {
      if (holidayByDateKey.size > 0 && !force) {
        console.warn('[NSE Holidays] Refresh failed, using cached holidays:', err.message);
        return { ok: true, source: 'memory-stale', count: holidayByDateKey.size };
      }
      if (readFallbackFile()) {
        console.warn('[NSE Holidays] Using fallback file after NSE error:', err.message);
        return { ok: true, source: 'fallback-file', count: holidayByDateKey.size };
      }
      console.error('[NSE Holidays] Failed to load holidays:', err.message);
      return { ok: false, error: err.message };
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function ensureNseHolidaysLoaded() {
  if (holidayByDateKey.size > 0 && Date.now() - lastFetchedAt < CACHE_TTL_MS) return true;
  const result = await refreshNseHolidayCache();
  return result.ok;
}

function isNseTradingHoliday(dateKey) {
  return holidayByDateKey.has(String(dateKey || '').trim());
}

function getNseHolidayDescription(dateKey) {
  return holidayByDateKey.get(String(dateKey || '').trim()) || null;
}

function isNseCashTradingDay(dateKey) {
  const key = String(dateKey || '').trim();
  if (!key) return false;
  if (isWeekendDateKey(key)) return false;
  if (isNseTradingHoliday(key)) return false;
  return true;
}

function listNseTradingHolidays({ year } = {}) {
  const y = year != null ? Number(year) : null;
  return Array.from(holidayByDateKey.entries())
    .filter(([dateKey]) => (Number.isFinite(y) ? dateKey.startsWith(`${y}-`) : true))
    .map(([dateKey, description]) => ({ dateKey, description }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

function scheduleNseHolidayRefresh() {
  const run = () => {
    refreshNseHolidayCache({ force: true }).catch(() => {});
  };
  const now = getIstClock(new Date());
  const msUntilMidnight = ((24 * 60) - now.minutes) * 60 * 1000;
  setTimeout(() => {
    run();
    if (dailyTimer) clearInterval(dailyTimer);
    dailyTimer = setInterval(run, 24 * 60 * 60 * 1000);
  }, msUntilMidnight + 5 * 60 * 1000);
  setTimeout(run, 3000);
}

module.exports = {
  ensureNseHolidaysLoaded,
  refreshNseHolidayCache,
  scheduleNseHolidayRefresh,
  isNseTradingHoliday,
  isNseCashTradingDay,
  getNseHolidayDescription,
  listNseTradingHolidays,
  parseNseTradingDate,
};

const { getIstClock } = require('../utils/dateTime');
const { listAllSymbolsByProduct } = require('./volumeInstrumentCatalog');
const { loadMetricsMap } = require('./volumeMetricsStore');

const ALLOWED_REFRESH_MINUTES = [5, 10, 15];
const DEFAULT_REFRESH_MINUTES = 5;
const BOOT_DELAY_MS = 30 * 1000;
const EXPIRY_SYMBOL = 'NIFTY';
const LOOKBACK_CYCLE = [5, 10, 30];
const DEFAULT_LOOKBACK_DAYS = 30;
const DISCOVERY_EVERY_N_TICKS = 6;

let refreshTimer = null;
let refreshInFlight = false;
let currentIntervalMs = DEFAULT_REFRESH_MINUTES * 60 * 1000;
let tickCount = 0;

function isNseSessionOpen(now = new Date()) {
  const clock = getIstClock(now);
  if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return false;
  const mins = clock.hour * 60 + clock.minute;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

function normalizeRefreshMinutes(raw) {
  const n = Number(raw);
  return ALLOWED_REFRESH_MINUTES.includes(n) ? n : DEFAULT_REFRESH_MINUTES;
}

function getRefreshIntervalMinutes() {
  return Math.round(currentIntervalMs / 60000);
}

function restartRefreshTimer() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = setInterval(tickFuturesRefresh, currentIntervalMs);
}

function setRefreshIntervalMinutes(minutes) {
  const safe = normalizeRefreshMinutes(minutes);
  const nextMs = safe * 60 * 1000;
  if (nextMs === currentIntervalMs) return safe;
  currentIntervalMs = nextMs;
  restartRefreshTimer();
  console.log(`[VOLUME SCAN] Live refresh interval set to ${safe} min`);
  return safe;
}

async function resolveActiveFutureExpiry() {
  const { getFutureExpiriesForSymbol } = require('./volumeAnalysisService');
  const data = await getFutureExpiriesForSymbol(EXPIRY_SYMBOL);
  const list = data?.expiries || [];
  return list[0]?.expiry || null;
}

async function resolveSymbolsToRefresh({ lookbackDays, expiryDate, fullScan = false }) {
  const listing = await listAllSymbolsByProduct({ product: 'future', q: '' });
  if (fullScan) {
    return { symbols: listing.symbols, mode: 'full' };
  }

  const metricsMap = await loadMetricsMap({
    product: 'future',
    expiryDate,
    lookbackDays,
    symbols: listing.symbols,
  });

  const { pickTopScannerRows } = require('./volumeAnalysisService');
  const rows = listing.symbols.map((sym) => metricsMap.get(sym)).filter(Boolean);
  const topRows = pickTopScannerRows(rows);

  if (topRows.length > 0) {
    return { symbols: topRows.map((row) => row.symbol), mode: 'top-10' };
  }

  return { symbols: listing.symbols, mode: 'full-fallback' };
}

async function refreshFuturesUniverse({
  lookbackDays = 10,
  expiryDate = null,
  fullScan = false,
} = {}) {
  if (refreshInFlight) return { ok: false, skipped: true, reason: 'refresh already running' };
  refreshInFlight = true;
  try {
    const { refreshSymbolsIntoStore } = require('./volumeAnalysisService');
    const expiry = expiryDate || await resolveActiveFutureExpiry();
    if (!expiry) {
      return { ok: false, error: 'No futures expiry available' };
    }

    const { symbols, mode } = await resolveSymbolsToRefresh({
      lookbackDays,
      expiryDate: expiry,
      fullScan,
    });

    const result = await refreshSymbolsIntoStore({
      symbols,
      product: 'future',
      expiryDate: expiry,
      lookbackDays,
    });
    return { ok: true, expiryDate: expiry, mode, ...result };
  } finally {
    refreshInFlight = false;
  }
}

async function refreshAllLookbackPresets({ expiryDate = null, fullScan = false } = {}) {
  const summary = [];
  for (const lookbackDays of LOOKBACK_CYCLE) {
    const useFull = fullScan && lookbackDays === DEFAULT_LOOKBACK_DAYS;
    const result = await refreshFuturesUniverse({
      lookbackDays,
      expiryDate,
      fullScan: useFull,
    });
    if (result.ok) {
      summary.push(`${lookbackDays}d:${result.updated}/${result.total} (${result.mode})`);
    }
  }
  return summary;
}

async function tickFuturesRefresh() {
  if (!isNseSessionOpen()) return;
  tickCount += 1;
  const fullDiscovery = tickCount % DISCOVERY_EVERY_N_TICKS === 0;
  try {
    const parts = await refreshAllLookbackPresets({ fullScan: fullDiscovery });
    if (parts.length) {
      console.log(`[VOLUME SCAN] Futures refreshed — ${parts.join(', ')}`);
    }
  } catch (err) {
    console.warn('[VOLUME SCAN] Scheduled futures refresh failed:', err.message);
  }
}

function scheduleVolumeScanRefresh() {
  if (refreshTimer) return;
  setTimeout(() => {
    refreshAllLookbackPresets({ fullScan: true })
      .then((parts) => {
        if (parts.length) {
          console.log(`[VOLUME SCAN] Boot warm-up done — ${parts.join(', ')}`);
        }
      })
      .catch((err) => {
        console.warn('[VOLUME SCAN] Boot warm-up failed:', err.message);
      });
  }, BOOT_DELAY_MS);

  refreshTimer = setInterval(tickFuturesRefresh, currentIntervalMs);
  console.log(
    `[VOLUME SCAN] Scheduled futures refresh every ${getRefreshIntervalMinutes()} min `
    + '(top-10 live refresh after boot, market hours).',
  );
}

module.exports = {
  scheduleVolumeScanRefresh,
  refreshFuturesUniverse,
  isNseSessionOpen,
  setRefreshIntervalMinutes,
  getRefreshIntervalMinutes,
  ALLOWED_REFRESH_MINUTES,
};

const { getIstClock } = require('../utils/dateTime');
const { listAllSymbolsByProduct } = require('./volumeInstrumentCatalog');

const FUTURES_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const BOOT_DELAY_MS = 30 * 1000;
const EXPIRY_SYMBOL = 'NIFTY';
const LOOKBACK_CYCLE = [5, 10, 22, 44];

let refreshTimer = null;
let refreshInFlight = false;

function isNseSessionOpen(now = new Date()) {
  const clock = getIstClock(now);
  if (clock.weekday === 'Sat' || clock.weekday === 'Sun') return false;
  const mins = clock.hour * 60 + clock.minute;
  return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
}

async function resolveActiveFutureExpiry() {
  const { getFutureExpiriesForSymbol } = require('./volumeAnalysisService');
  const data = await getFutureExpiriesForSymbol(EXPIRY_SYMBOL);
  const list = data?.expiries || [];
  return list[0]?.expiry || null;
}

async function refreshFuturesUniverse({ lookbackDays = 10, expiryDate = null } = {}) {
  if (refreshInFlight) return { ok: false, skipped: true, reason: 'refresh already running' };
  refreshInFlight = true;
  try {
    const { refreshSymbolsIntoStore } = require('./volumeAnalysisService');
    const expiry = expiryDate || await resolveActiveFutureExpiry();
    if (!expiry) {
      return { ok: false, error: 'No futures expiry available' };
    }
    const listing = await listAllSymbolsByProduct({ product: 'future', q: '' });
    const result = await refreshSymbolsIntoStore({
      symbols: listing.symbols,
      product: 'future',
      expiryDate: expiry,
      lookbackDays,
    });
    return { ok: true, expiryDate: expiry, ...result };
  } finally {
    refreshInFlight = false;
  }
}

async function refreshAllLookbackPresets({ expiryDate = null } = {}) {
  const summary = [];
  for (const lookbackDays of LOOKBACK_CYCLE) {
    const result = await refreshFuturesUniverse({ lookbackDays, expiryDate });
    if (result.ok) {
      summary.push(`${lookbackDays}d:${result.updated}/${result.total}`);
    }
  }
  return summary;
}

async function tickFuturesRefresh() {
  if (!isNseSessionOpen()) return;
  try {
    const parts = await refreshAllLookbackPresets();
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
    refreshAllLookbackPresets()
      .then((parts) => {
        if (parts.length) {
          console.log(`[VOLUME SCAN] Boot warm-up done — ${parts.join(', ')}`);
        }
      })
      .catch((err) => {
        console.warn('[VOLUME SCAN] Boot warm-up failed:', err.message);
      });
  }, BOOT_DELAY_MS);

  refreshTimer = setInterval(tickFuturesRefresh, FUTURES_REFRESH_INTERVAL_MS);
  console.log('[VOLUME SCAN] Scheduled futures refresh every 15 min (5/10/22/44 day lookbacks, market hours).');
}

module.exports = {
  scheduleVolumeScanRefresh,
  refreshFuturesUniverse,
  isNseSessionOpen,
};

const { renewAccessToken, formatDhanRenewError } = require('./dhanAuthService');
const { getAccessToken } = require('./dhanTokenStore');

const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

function scheduleDhanTokenMaintenance() {
  const intervalMs = Math.max(60_000, Number(process.env.DHAN_TOKEN_REFRESH_INTERVAL_MS || TWENTY_HOURS_MS));
  const onStartupRaw =
    process.env.DHAN_TOKEN_RENEW_ON_STARTUP ?? process.env.DHAN_TOKEN_REFRESH_ON_STARTUP ?? 'true';
  const onStartup = String(onStartupRaw).toLowerCase() !== 'false';

  const run = async () => {
    if (!getAccessToken()) return;
    try {
      await renewAccessToken();
      console.log('[DHAN TOKEN] Renewed via RenewToken API.');
    } catch (err) {
      const detail = err?.message || formatDhanRenewError(err);
      console.error('[DHAN TOKEN] Renew failed:', detail);
    }
  };

  if (onStartup) setTimeout(run, 5000);
  setInterval(run, intervalMs);
}

module.exports = { scheduleDhanTokenMaintenance };

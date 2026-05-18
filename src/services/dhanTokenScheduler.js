const { renewAccessToken, formatDhanRenewError } = require('./dhanAuthService');
const { getAccessToken } = require('./dhanTokenStore');
const {
  reloadDhanCredentialsFromMongo,
  shouldAttemptDhanRenew,
  tokenLooksValid,
} = require('./dhanTokenPersistence');

const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

function scheduleDhanTokenMaintenance() {
  const intervalMs = Math.max(60_000, Number(process.env.DHAN_TOKEN_REFRESH_INTERVAL_MS || TWENTY_HOURS_MS));
  const onStartupRaw =
    process.env.DHAN_TOKEN_RENEW_ON_STARTUP ?? process.env.DHAN_TOKEN_REFRESH_ON_STARTUP ?? 'true';
  const onStartup = String(onStartupRaw).toLowerCase() !== 'false';

  const run = async ({ label = 'scheduled' } = {}) => {
    const doc = await reloadDhanCredentialsFromMongo();
    if (!getAccessToken()) return;
    if (!shouldAttemptDhanRenew(doc)) {
      const valid = tokenLooksValid(getAccessToken());
      if (!valid) {
        console.warn(
          `[DHAN TOKEN] Skip renew (${label}): JWT expired in MongoDB. POST /api/dhan/access-token with a fresh token from web.dhan.co.`,
        );
      }
      return;
    }
    try {
      await renewAccessToken();
      console.log(`[DHAN TOKEN] Renewed via RenewToken API (${label}).`);
    } catch (err) {
      const detail = err?.message || formatDhanRenewError(err);
      console.error(`[DHAN TOKEN] Renew failed (${label}):`, detail);
    }
  };

  if (onStartup) setTimeout(() => run({ label: 'startup' }), 5000);
  setInterval(() => run({ label: 'interval' }), intervalMs);
}

module.exports = { scheduleDhanTokenMaintenance };

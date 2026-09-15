const { renewAccessToken, formatDhanRenewError } = require('./dhanAuthService');
const { getAccessToken } = require('./dhanTokenStore');
const {
  reloadDhanCredentialsFromMongo,
  shouldAttemptDhanRenew,
  tokenLooksValid,
  readRenewAgeMs,
} = require('./dhanTokenPersistence');

const DEFAULT_CHECK_MS = 30 * 60 * 1000;

function scheduleDhanTokenMaintenance() {
  const checkMs = Math.max(
    60_000,
    Number(process.env.DHAN_TOKEN_CHECK_INTERVAL_MS || DEFAULT_CHECK_MS),
  );
  const onStartupRaw =
    process.env.DHAN_TOKEN_RENEW_ON_STARTUP ?? process.env.DHAN_TOKEN_REFRESH_ON_STARTUP ?? 'true';
  const onStartup = String(onStartupRaw).toLowerCase() !== 'false';
  const renewAgeHours = readRenewAgeMs() / (60 * 60 * 1000);

  console.log(
    `[DHAN TOKEN] Auto-renew enabled: check every ${Math.round(checkMs / 60_000)} min, renew when token age ≥ ${renewAgeHours}h (while JWT still valid).`,
  );

  const run = async ({ label = 'scheduled' } = {}) => {
    const doc = await reloadDhanCredentialsFromMongo();
    if (!getAccessToken()) return;

    const gate = shouldAttemptDhanRenew(doc);
    if (!gate.ok) {
      if (gate.reason === 'JWT_EXPIRED_NEED_MANUAL_SEED') {
        console.warn(
          `[DHAN TOKEN] (${label}) JWT expired — RenewToken cannot recover. POST /api/dhan/access-token with a fresh token from web.dhan.co.`,
        );
      } else if (gate.reason === 'TOO_EARLY' && label === 'startup') {
        console.log(
          `[DHAN TOKEN] (${label}) Token still fresh; next renew ~${gate.nextRenewAt || 'later'}.`,
        );
      }
      return;
    }

    if (!tokenLooksValid(getAccessToken())) {
      console.warn(`[DHAN TOKEN] (${label}) Skip renew: JWT no longer valid.`);
      return;
    }

    try {
      await renewAccessToken();
      console.log(`[DHAN TOKEN] Renewed via Dhan RenewToken (${label}, reason=${gate.reason}).`);
    } catch (err) {
      const detail = err?.message || formatDhanRenewError(err);
      console.error(`[DHAN TOKEN] Renew failed (${label}):`, detail);
    }
  };

  if (onStartup) setTimeout(() => run({ label: 'startup' }), 5000);
  setInterval(() => run({ label: 'interval' }), checkMs);
}

module.exports = { scheduleDhanTokenMaintenance };

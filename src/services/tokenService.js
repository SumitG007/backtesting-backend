const { getAccessToken } = require('./dhanTokenStore');
const { renewAccessToken } = require('./dhanAuthService');

function readLatestAccessToken() {
  return String(getAccessToken() || '').trim();
}

function isLikelyDhanAuthError(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 401 || status === 403) return true;
  const details = error?.response?.data || {};
  const asText = JSON.stringify(details).toLowerCase();
  return (
    asText.includes('token') ||
    asText.includes('unauthor') ||
    asText.includes('invalid credentials') ||
    asText.includes('session')
  );
}

/**
 * Used after Dhan returns auth errors: exchange JWT via RenewToken and persist to Mongo (same as automate-trade).
 */
async function ensureValidDhanAccessToken(reason = 'ensure-valid') {
  if (!readLatestAccessToken()) {
    throw new Error(
      `Cannot ensure Dhan token (${reason}): no JWT in memory — seed Mongo via POST /api/dhan/access-token`
    );
  }
  await renewAccessToken();
  return readLatestAccessToken();
}

async function renewDhanAccessToken(_reason = 'manual') {
  await renewAccessToken();
  return readLatestAccessToken();
}

module.exports = {
  readLatestAccessToken,
  isLikelyDhanAuthError,
  renewDhanAccessToken,
  ensureValidDhanAccessToken,
};

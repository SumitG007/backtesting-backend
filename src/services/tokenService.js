const { getAccessToken } = require('./dhanTokenStore');
const { renewAccessToken } = require('./dhanAuthService');
const {
  reloadDhanCredentialsFromMongo,
  sanitizeAccessToken,
  tokenLooksValid,
  shouldAttemptDhanRenew,
} = require('./dhanTokenPersistence');

function readLatestAccessToken() {
  return sanitizeAccessToken(getAccessToken());
}

function isLikelyDhanAuthError(error) {
  const status = Number(error?.response?.status || 0);
  if (status === 401 || status === 403) return true;
  const details = error?.response?.data || {};
  const code = String(details.errorCode || details.error_code || '').toUpperCase();
  if (code === 'DH-906' || code === 'DH-905') return true;
  const asText = JSON.stringify(details).toLowerCase();
  return asText.includes('unauthor') || asText.includes('invalid credentials');
}

/**
 * Used after Dhan returns auth errors: exchange JWT via RenewToken and persist to Mongo (same as automate-trade).
 */
async function ensureValidDhanAccessToken(reason = 'ensure-valid') {
  await reloadDhanCredentialsFromMongo();
  const token = readLatestAccessToken();
  if (!token) {
    throw new Error(
      `Cannot ensure Dhan token (${reason}): no JWT in memory — seed Mongo via POST /api/dhan/access-token`,
    );
  }
  if (!tokenLooksValid(token)) {
    throw new Error(
      `Cannot ensure Dhan token (${reason}): JWT expired — generate a new token at web.dhan.co and POST /api/dhan/access-token`,
    );
  }
  const doc = await reloadDhanCredentialsFromMongo();
  const gate = shouldAttemptDhanRenew(doc);
  if (gate.ok) {
    await renewAccessToken();
  }
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

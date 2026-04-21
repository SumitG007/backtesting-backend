const fs = require('fs/promises');
const axios = require('axios');
const { BACKEND_ENV_PATH, TOKEN_RENEW_INTERVAL_MS } = require('../config/constants');

let currentDhanAccessToken = process.env.DHAN_ACCESS_TOKEN || '';
let currentDhanTokenExpiresAt = Number(process.env.DHAN_TOKEN_EXPIRES_AT || 0);
let renewTokenInFlight = null;
const TOKEN_RENEW_BUFFER_MS = 10 * 60 * 1000;

function readLatestAccessToken() {
  return currentDhanAccessToken || process.env.DHAN_ACCESS_TOKEN || '';
}

function getTokenExpiryMs() {
  return Number(currentDhanTokenExpiresAt || process.env.DHAN_TOKEN_EXPIRES_AT || 0);
}

function shouldRenewSoon() {
  const expiresAt = getTokenExpiryMs();
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return true;
  return Date.now() >= expiresAt - TOKEN_RENEW_BUFFER_MS;
}

function extractRenewedToken(payload) {
  return (
    payload?.accessToken ||
    payload?.access_token ||
    payload?.token ||
    payload?.jwtToken ||
    payload?.data?.accessToken ||
    payload?.data?.access_token ||
    ''
  );
}

function extractExpiryMs(payload) {
  const raw = payload?.expiryTime || payload?.data?.expiryTime;
  if (!raw) return Date.now() + 24 * 60 * 60 * 1000;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now() + 24 * 60 * 60 * 1000;
}

async function persistTokenStateToEnv({ token, expiresAt }) {
  try {
    let envContent = '';
    try {
      envContent = await fs.readFile(BACKEND_ENV_PATH, 'utf8');
    } catch (_error) {
      envContent = '';
    }
    const updates = {
      DHAN_ACCESS_TOKEN: token,
      DHAN_TOKEN_EXPIRES_AT: String(expiresAt),
    };
    let next = envContent;
    for (const [key, value] of Object.entries(updates)) {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(next)) {
        next = next.replace(re, `${key}=${value}`);
      } else {
        const suffix = next.endsWith('\n') || next.length === 0 ? '' : '\n';
        next = `${next}${suffix}${key}=${value}\n`;
      }
    }
    await fs.writeFile(BACKEND_ENV_PATH, next, 'utf8');
  } catch (error) {
    console.warn('Could not persist Dhan token state to .env:', error.message);
  }
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

async function setAndPersistTokenState({ token, expiresAt, reason }) {
  currentDhanAccessToken = token;
  currentDhanTokenExpiresAt = expiresAt;
  process.env.DHAN_ACCESS_TOKEN = token;
  process.env.DHAN_TOKEN_EXPIRES_AT = String(expiresAt);
  await persistTokenStateToEnv({ token, expiresAt });
  console.log(`Dhan access token updated (${reason}). Expires at ${new Date(expiresAt).toISOString()}.`);
  return token;
}

async function renewDhanAccessToken(reason = 'manual') {
  if (renewTokenInFlight) return renewTokenInFlight;
  renewTokenInFlight = (async () => {
    const clientId = process.env.DHAN_CLIENT_ID;
    const oldToken = readLatestAccessToken();
    if (!clientId || !oldToken) {
      throw new Error('Cannot renew token: missing DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN');
    }

    const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
    const response = await axios.post(
      `${baseUrl}/RenewToken`,
      {},
      {
        headers: {
          'access-token': oldToken,
          'client-id': clientId,
          dhanClientId: clientId,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    const renewedToken = extractRenewedToken(response.data);
    if (!renewedToken) {
      throw new Error('RenewToken succeeded but no access token found in response');
    }
    const expiresAt = extractExpiryMs(response.data);
    return setAndPersistTokenState({ token: renewedToken, expiresAt, reason });
  })();

  try {
    return await renewTokenInFlight;
  } finally {
    renewTokenInFlight = null;
  }
}

async function ensureValidDhanAccessToken(reason = 'ensure-valid') {
  const hasToken = Boolean(readLatestAccessToken());
  if (!hasToken) {
    throw new Error(`Cannot ensure Dhan token (${reason}): missing DHAN_ACCESS_TOKEN`);
  }
  if (shouldRenewSoon()) {
    return renewDhanAccessToken(`${reason}:expiring`);
  }
  return readLatestAccessToken();
}

function startTokenAutoRenewJob() {
  if (!process.env.DHAN_CLIENT_ID) {
    console.warn('Skipping auto-renew job: missing DHAN_CLIENT_ID.');
    return;
  }
  ensureValidDhanAccessToken('startup').catch((error) => {
    console.warn('Initial Dhan token ensure failed:', error.message);
  });
  const timer = setInterval(() => {
    ensureValidDhanAccessToken('scheduled').catch((error) => {
      console.warn('Scheduled Dhan token ensure failed:', error.message);
    });
  }, TOKEN_RENEW_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  readLatestAccessToken,
  isLikelyDhanAuthError,
  renewDhanAccessToken,
  ensureValidDhanAccessToken,
  startTokenAutoRenewJob,
};

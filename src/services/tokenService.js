const fs = require('fs/promises');
const axios = require('axios');
const { BACKEND_ENV_PATH, TOKEN_RENEW_INTERVAL_MS } = require('../config/constants');

let currentDhanAccessToken = process.env.DHAN_ACCESS_TOKEN || '';
let renewTokenInFlight = null;

function readLatestAccessToken() {
  return currentDhanAccessToken || process.env.DHAN_ACCESS_TOKEN || '';
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

async function persistAccessTokenToEnv(newToken) {
  try {
    const envContent = await fs.readFile(BACKEND_ENV_PATH, 'utf8');
    if (/^DHAN_ACCESS_TOKEN=/m.test(envContent)) {
      const next = envContent.replace(/^DHAN_ACCESS_TOKEN=.*$/m, `DHAN_ACCESS_TOKEN=${newToken}`);
      await fs.writeFile(BACKEND_ENV_PATH, next, 'utf8');
    } else {
      const suffix = envContent.endsWith('\n') || envContent.length === 0 ? '' : '\n';
      await fs.writeFile(BACKEND_ENV_PATH, `${envContent}${suffix}DHAN_ACCESS_TOKEN=${newToken}\n`, 'utf8');
    }
  } catch (error) {
    console.warn('Could not persist renewed DHAN_ACCESS_TOKEN to .env:', error.message);
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

    currentDhanAccessToken = renewedToken;
    process.env.DHAN_ACCESS_TOKEN = renewedToken;
    await persistAccessTokenToEnv(renewedToken);
    console.log(`Dhan access token renewed (${reason}).`);
    return renewedToken;
  })();

  try {
    return await renewTokenInFlight;
  } finally {
    renewTokenInFlight = null;
  }
}

function startTokenAutoRenewJob() {
  if (!process.env.DHAN_CLIENT_ID || !readLatestAccessToken()) {
    console.warn('Skipping auto-renew job: missing Dhan client id or access token.');
    return;
  }
  const timer = setInterval(() => {
    renewDhanAccessToken('scheduled').catch((error) => {
      console.warn('Scheduled Dhan token renew failed:', error.message);
    });
  }, TOKEN_RENEW_INTERVAL_MS);
  timer.unref();
}

module.exports = {
  readLatestAccessToken,
  isLikelyDhanAuthError,
  renewDhanAccessToken,
  startTokenAutoRenewJob,
};

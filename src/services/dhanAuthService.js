const axios = require('axios');
const { getAccessToken, setAccessToken, getDhanClientId, setDhanClientId } = require('./dhanTokenStore');
const { persistDhanTokenToMongo, getDhanTokenDoc } = require('./dhanTokenPersistence');

function pickAccessTokenFromResponse(data) {
  if (!data || typeof data !== 'object') return '';
  const d = data;
  const direct =
    d.accessToken ||
    d.access_token ||
    d.token ||
    (d.data && (d.data.accessToken || d.data.access_token || d.data.token)) ||
    '';
  if (direct) return String(direct).trim();
  for (const v of Object.values(d)) {
    if (v && typeof v === 'object' && (v.accessToken || v.access_token || v.token)) {
      return String(v.accessToken || v.access_token || v.token).trim();
    }
  }
  return '';
}

function renewTokenHeaders(token, clientId, withContentType) {
  const h = {
    'access-token': token,
    dhanClientId: clientId,
  };
  if (withContentType) h['Content-Type'] = 'application/json';
  return h;
}

async function fetchRenewToken(baseUrl, token, clientId) {
  const root = baseUrl.replace(/\/$/, '');
  try {
    return await axios.get(`${root}/RenewToken`, {
      headers: renewTokenHeaders(token, clientId, false),
      timeout: 20000,
    });
  } catch (getErr) {
    const status = Number(getErr?.response?.status || 0);
    if (status !== 405 && status !== 400) throw getErr;
    return axios.post(`${root}/RenewToken`, {}, {
      headers: renewTokenHeaders(token, clientId, true),
      timeout: 20000,
    });
  }
}

let renewInFlight = null;

/**
 * RenewToken — current JWT + dhanClientId in headers; response includes new token + expiry.
 * @see https://dhanhq.co/docs/v2/authentication/
 */
async function renewAccessToken() {
  if (!renewInFlight) {
    renewInFlight = (async () => {
      const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
      const token = getAccessToken();
      const clientId = getDhanClientId();
      if (!token || !clientId) {
        throw new Error(
          'renewAccessToken: missing token or dhanClientId. Seed via POST /api/dhan/access-token (and set DHAN_CLIENT_ID in .env if not stored in Mongo).'
        );
      }

      const response = await fetchRenewToken(baseUrl, token, clientId);
      const raw = response.data || {};

      const next = pickAccessTokenFromResponse(raw);
      if (!next) throw new Error('renewAccessToken: no token in RenewToken response');

      setAccessToken(next);
      await persistDhanTokenToMongo(next, {
        force: true,
        dhanClientId: clientId,
        renewCreateTime: raw.createTime,
        renewExpiryTime: raw.expiryTime,
      });

      return { accessToken: next, raw };
    })().finally(() => {
      renewInFlight = null;
    });
  }
  return renewInFlight;
}

/**
 * First-time seed: store JWT + client id from body, then RenewToken so the active token is Dhan’s.
 */
async function seedAccessTokenFromBody(body) {
  const initialJwt = String(
    body?.accessToken ?? body?.token ?? body?.access_token ?? body?.accessTokenJwt ?? ''
  ).trim();
  const clientId = String(
    body?.dhanClientId ??
      body?.clientId ??
      body?.dhanClientID ??
      body?.dhan_client_id ??
      body?.headers?.dhanClientId ??
      ''
  ).trim() || String(process.env.DHAN_CLIENT_ID ?? '').trim();

  if (!initialJwt) throw new Error('accessToken (or token) is required in JSON body');
  if (!clientId) throw new Error('dhanClientId is required in JSON body (or set DHAN_CLIENT_ID in .env)');

  setAccessToken(initialJwt);
  setDhanClientId(clientId);
  await persistDhanTokenToMongo(initialJwt, { force: true, dhanClientId: clientId });
  const seeded = await getDhanTokenDoc();
  if (!String(seeded?.accessToken || '').trim()) {
    throw new Error('Mongo persist verification failed: token not found after seed');
  }

  try {
    await renewAccessToken();
    return { ok: true, exchanged: true };
  } catch (err) {
    const msg = err?.message || String(err);
    return { ok: true, exchanged: false, warning: msg };
  }
}

module.exports = { renewAccessToken, seedAccessTokenFromBody, pickAccessTokenFromResponse };

const axios = require('axios');
const { getAccessToken, setAccessToken, getDhanClientId, setDhanClientId } = require('./dhanTokenStore');
const {
  persistDhanTokenToMongo,
  getDhanTokenDoc,
  reloadDhanCredentialsFromMongo,
  sanitizeAccessToken,
  tokenLooksValid,
} = require('./dhanTokenPersistence');

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
  // RenewToken uses `dhanClientId` only (not `client-id`); extra headers can trigger DH-905 on POST.
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
    // Only POST fallback on 405. POST on 400 surfaces DH-905 ("bad parameters") from Dhan.
    if (status !== 405) throw getErr;
    return axios.post(`${root}/RenewToken`, {}, {
      headers: renewTokenHeaders(token, clientId, true),
      timeout: 20000,
    });
  }
}

function formatDhanRenewError(err) {
  const status = err?.response?.status;
  const data = err?.response?.data;
  const body =
    data && typeof data === 'object'
      ? JSON.stringify(data)
      : data != null
        ? String(data)
        : '';
  const hint =
    status === 400
      ? ' (Dhan RenewToken: JWT must still be valid and from Dhan Web. If expired, create a new token at web.dhan.co and POST /api/dhan/access-token.)'
      : '';
  return [err?.message || String(err), body && `Response: ${body}`, hint].filter(Boolean).join(' ');
}

let renewInFlight = null;

/**
 * RenewToken — current JWT + dhanClientId in headers; response includes new token + expiry.
 * @see https://dhanhq.co/docs/v2/authentication/
 */
async function renewAccessToken({ force = false } = {}) {
  if (!renewInFlight) {
    renewInFlight = (async () => {
      await reloadDhanCredentialsFromMongo();
      const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
      const token = sanitizeAccessToken(getAccessToken());
      const clientId = getDhanClientId();
      if (!token || !clientId) {
        throw new Error(
          'renewAccessToken: missing token or dhanClientId. Seed via POST /api/dhan/access-token (and set DHAN_CLIENT_ID in .env if not stored in Mongo).'
        );
      }
      if (!force && !tokenLooksValid(token)) {
        throw new Error(
          'renewAccessToken: JWT is already expired. RenewToken only works on an active token — generate a new one at web.dhan.co and POST /api/dhan/access-token.'
        );
      }

      let response;
      try {
        response = await fetchRenewToken(baseUrl, token, clientId);
      } catch (err) {
        throw new Error(formatDhanRenewError(err));
      }
      const raw = response.data || {};

      const next = pickAccessTokenFromResponse(raw);
      if (!next) throw new Error('renewAccessToken: no token in RenewToken response');

      setAccessToken(next);
      await persistDhanTokenToMongo(next, {
        force: true,
        dhanClientId: clientId,
        renewCreateTime: raw.createTime,
        renewExpiryTime: raw.expiryTime,
        markRenewed: true,
      });

      try {
        const { notifyDhanConnectivityRestored } = require('./livePaperEngineRecovery');
        await notifyDhanConnectivityRestored();
      } catch (resumeErr) {
        console.warn('[DHAN TOKEN] Paper-live resume after renew:', resumeErr.message);
      }

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
  const initialJwt = sanitizeAccessToken(
    body?.accessToken ?? body?.token ?? body?.access_token ?? body?.accessTokenJwt ?? '',
  );
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
  try {
    const { notifyDhanConnectivityRestored } = require('./livePaperEngineRecovery');
    await notifyDhanConnectivityRestored();
  } catch (resumeErr) {
    console.warn('[DHAN TOKEN] Paper-live resume after seed:', resumeErr.message);
  }
  const seeded = await getDhanTokenDoc();
  if (!String(seeded?.accessToken || '').trim()) {
    throw new Error('Mongo persist verification failed: token not found after seed');
  }

  if (!tokenLooksValid(initialJwt)) {
    return {
      ok: true,
      exchanged: false,
      warning:
        'Token saved but JWT is already expired. Generate a fresh token at web.dhan.co (valid 24h) and POST again.',
    };
  }

  try {
    await renewAccessToken();
    return { ok: true, exchanged: true };
  } catch (err) {
    const msg = err?.message || String(err);
    return {
      ok: true,
      exchanged: false,
      warning: `${msg} Token is stored and may still work until expiry; fix dhanClientId if mismatched.`,
    };
  }
}

module.exports = {
  renewAccessToken,
  seedAccessTokenFromBody,
  pickAccessTokenFromResponse,
  formatDhanRenewError,
};

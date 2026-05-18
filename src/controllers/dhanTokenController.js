const axios = require('axios');
const { seedAccessTokenFromBody } = require('../services/dhanAuthService');
const {
  getDhanTokenDoc,
  tokenLooksValid,
  decodeJwtMeta,
  sanitizeAccessToken,
  shouldAttemptDhanRenew,
} = require('../services/dhanTokenPersistence');
const { getDhanClientId } = require('../services/dhanTokenStore');

function requireSeedPassword(req, res) {
  const required = String(process.env.APP_LOGIN_PASSWORD || '').trim();
  if (!required) return true;
  const given = String(req.body?.password || '').trim();
  if (given !== required) {
    res.status(401).json({ ok: false, error: 'Invalid or missing password' });
    return false;
  }
  return true;
}

/** Seed Dhan JWT + client id in MongoDB, then call RenewToken. No JWT in .env. */
async function postDhanAccessToken(req, res) {
  try {
    if (!requireSeedPassword(req, res)) return;
    const mergedBody = {
      ...(req.body || {}),
      accessToken: req.body?.accessToken || req.body?.token || req.headers['access-token'],
      dhanClientId:
        req.body?.dhanClientId ||
        req.body?.clientId ||
        req.headers.dhanclientid ||
        req.headers['dhan-client-id'],
    };
    const out = await seedAccessTokenFromBody(mergedBody);
    return res.json({
      ok: true,
      exchanged: out.exchanged,
      ...(out.warning ? { warning: out.warning } : {}),
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || String(error) });
  }
}

async function getDhanTokenStatus(_req, res) {
  try {
    const doc = await getDhanTokenDoc();
    const token = sanitizeAccessToken(doc?.accessToken);
    const jwt = decodeJwtMeta(token);
    const clientId = String(doc?.dhanClientId || getDhanClientId() || '').trim();
    const jwtValid = tokenLooksValid(token);

    let profileOk = null;
    let profileError = null;
    if (token && jwtValid) {
      const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
      try {
        const profile = await axios.get(`${baseUrl}/profile`, {
          headers: { 'access-token': token, 'client-id': clientId },
          timeout: 12000,
        });
        profileOk = true;
        profileError = null;
        if (profile.data?.tokenValidity) {
          jwt.expIso = jwt.expIso || profile.data.tokenValidity;
        }
      } catch (err) {
        profileOk = false;
        profileError = err?.response?.data || err?.message || String(err);
      }
    }

    return res.json({
      ok: true,
      hasToken: Boolean(token),
      hasClientId: Boolean(clientId),
      jwtValid,
      jwtExpIso: jwt.expIso,
      renewCreateTime: doc?.renewCreateTime || null,
      renewExpiryTime: doc?.renewExpiryTime || null,
      shouldRenew: shouldAttemptDhanRenew(doc),
      profileOk,
      profileError,
      updatedAt: doc?.updatedAt || null,
      hint: !jwtValid
        ? 'JWT expired. RenewToken will fail with DH-906. Get a new token at web.dhan.co and POST /api/dhan/access-token (do not paste only into Mongo while server is running).'
        : null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}

module.exports = { postDhanAccessToken, getDhanTokenStatus };

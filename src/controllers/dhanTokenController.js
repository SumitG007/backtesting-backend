const axios = require('axios');
const { seedAccessTokenFromBody } = require('../services/dhanAuthService');
const {
  getDhanTokenDoc,
  tokenLooksValid,
  decodeJwtMeta,
  sanitizeAccessToken,
  shouldAttemptDhanRenew,
  getDhanRenewScheduleMeta,
} = require('../services/dhanTokenPersistence');
const { getDhanClientId } = require('../services/dhanTokenStore');

/** Seed Dhan JWT + client id in MongoDB, then call RenewToken. Requires platform JWT. */
async function postDhanAccessToken(req, res) {
  try {
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

    const renewGate = shouldAttemptDhanRenew(doc);
    const schedule = getDhanRenewScheduleMeta(doc);

    return res.json({
      ok: true,
      hasToken: Boolean(token),
      hasClientId: Boolean(clientId),
      jwtValid,
      jwtExpIso: jwt.expIso,
      renewCreateTime: doc?.renewCreateTime || null,
      renewExpiryTime: doc?.renewExpiryTime || null,
      lastRenewedAt: doc?.lastRenewedAt || null,
      shouldRenew: renewGate.ok,
      renewSkipReason: renewGate.ok ? null : renewGate.reason,
      nextScheduledRenewAt: schedule.nextScheduledRenewAt,
      renewAgeHours: schedule.renewAgeHours,
      profileOk,
      profileError,
      updatedAt: doc?.updatedAt || null,
      hint: !jwtValid
        ? 'JWT expired. RenewToken will fail with DH-906. Get a new token at web.dhan.co and POST /api/dhan/access-token once (then auto-renew every ~20h while server runs).'
        : renewGate.ok
          ? 'Renew recommended now (age or near expiry). Scheduler will call Dhan RenewToken.'
          : `Auto-renew active. Next check when token is ~${schedule.renewAgeHours}h old or <${schedule.renewBeforeExpiryHours}h to JWT expiry.`,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}

module.exports = { postDhanAccessToken, getDhanTokenStatus };

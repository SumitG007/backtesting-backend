const { seedAccessTokenFromBody } = require('../services/dhanAuthService');
const { getDhanTokenDoc } = require('../services/dhanTokenPersistence');

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
    return res.json({
      ok: true,
      hasToken: Boolean(String(doc?.accessToken || '').trim()),
      hasClientId: Boolean(String(doc?.dhanClientId || '').trim()),
      renewCreateTime: doc?.renewCreateTime || null,
      renewExpiryTime: doc?.renewExpiryTime || null,
      updatedAt: doc?.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}

module.exports = { postDhanAccessToken, getDhanTokenStatus };

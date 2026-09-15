const {
  loginWithCredentials,
  getAuthStatus,
  verifyAccessToken,
  verifyPasswordForUser,
} = require('../services/adminAuthService');

async function postLogin(req, res) {
  try {
    const email = req.body?.email ?? req.body?.username ?? req.body?.admin;
    const password = req.body?.password;
    const result = await loginWithCredentials(email, password);
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: result.error });
    }
    return res.json({
      ok: true,
      token: result.token,
      user: result.user,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}

/** Public — no emails, Mongo details, or env hints. */
function getAuthConfig(_req, res) {
  return res.json({ ok: true, loginRequired: true });
}

/** Authenticated — diagnostic status for the logged-in admin only. */
async function getAuthStatusHandler(_req, res) {
  try {
    const status = await getAuthStatus();
    return res.json({ ok: true, ...status });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}

async function getMe(req, res) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = verifyAccessToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  return res.json({ ok: true, user });
}

function postLogout(_req, res) {
  return res.json({ ok: true, message: 'Logged out — discard token on client' });
}

async function postVerifyPassword(req, res) {
  try {
    const password = req.body?.password;
    const result = await verifyPasswordForUser(req.user?.email, password);
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
}

module.exports = {
  postLogin,
  getAuthConfig,
  getAuthStatusHandler,
  getMe,
  postLogout,
  postVerifyPassword,
};

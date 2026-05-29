const {
  loginWithCredentials,
  getAuthStatus,
  verifyAccessToken,
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

async function getAuthConfig(_req, res) {
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

module.exports = { postLogin, getAuthConfig, getMe, postLogout };

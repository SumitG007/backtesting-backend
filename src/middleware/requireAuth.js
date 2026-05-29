const { verifyAccessToken } = require('../services/adminAuthService');

const PUBLIC_PATHS = new Set(['/health', '/auth/login', '/auth/config']);

function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (PUBLIC_PATHS.has(req.path)) return next();

  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const user = verifyAccessToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: 'Unauthorized — login required' });
  }
  req.user = user;
  return next();
}

module.exports = { requireAuth };

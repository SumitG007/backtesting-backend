/**
 * Resolve CORS origin(s) from CORS_ORIGIN.
 * Never defaults to reflect-any-origin (cors `true`).
 * Production with unset CORS_ORIGIN → deny cross-origin.
 * Development with unset → localhost Vite / preview only.
 */
function resolveCorsOrigin(value = process.env.CORS_ORIGIN) {
  const raw = String(value || '').trim();
  if (!raw) {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    if (isProd) {
      console.warn('[CORS] CORS_ORIGIN is unset in production — denying browser cross-origin requests');
      return false;
    }
    console.warn('[CORS] CORS_ORIGIN unset — allowing local Vite/preview origins only');
    return [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ];
  }

  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return item.replace(/\/+$/, '');
      }
    });

  if (origins.length === 0) return false;
  return origins.length === 1 ? origins[0] : origins;
}

module.exports = { resolveCorsOrigin };

const DhanTokenCache = require('../models/DhanTokenCache');
const { setAccessToken, setDhanClientId, getAccessToken, getDhanClientId } = require('./dhanTokenStore');

/** Strip common copy-paste noise from web.dhan.co tokens. */
function sanitizeAccessToken(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '').trim();
  if (
    (t.startsWith('"') && t.endsWith('"'))
    || (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** Best-effort JWT exp check without verifying signature. */
function tokenLooksValid(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    const expMs = Number(payload.exp) * 1000;
    if (!Number.isFinite(expMs)) return true;
    return expMs > Date.now() + 2 * 60 * 1000;
  } catch {
    return false;
  }
}

function decodeJwtMeta(token) {
  const t = sanitizeAccessToken(token);
  const parts = t.split('.');
  if (parts.length < 2) return { exp: null, expIso: null };
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    const expSec = Number(payload.exp);
    if (!Number.isFinite(expSec)) return { exp: null, expIso: null };
    const expMs = expSec * 1000;
    return { exp: expMs, expIso: new Date(expMs).toISOString() };
  } catch {
    return { exp: null, expIso: null };
  }
}

function parseDhanApiDate(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Load Dhan JWT from Mongo only. Optional `DHAN_CLIENT_ID` in .env fills client id when the
 * cache document has none (RenewToken + API headers still work after first seed).
 */
async function hydrateDhanTokenFromMongo() {
  const envCid = String(process.env.DHAN_CLIENT_ID || '').trim();
  try {
    const doc = await DhanTokenCache.findOne({ key: 'singleton' }).lean();
    const dbTok = sanitizeAccessToken(doc?.accessToken);
    if (dbTok) {
      setAccessToken(dbTok);
      const meta = decodeJwtMeta(dbTok);
      const valid = tokenLooksValid(dbTok);
      console.log(
        `[DHAN TOKEN] Restored JWT from MongoDB (${valid ? 'active' : 'expired'}${meta.expIso ? `, exp ${meta.expIso}` : ''}).`,
      );
      if (!valid) {
        console.warn(
          '[DHAN TOKEN] Stored JWT is expired. RenewToken cannot fix this — generate a new token at web.dhan.co and POST /api/dhan/access-token.',
        );
      }
    }
    const dbClient = String(doc?.dhanClientId || '').trim();
    if (dbClient) {
      setDhanClientId(dbClient);
      console.log('[DHAN TOKEN] Restored dhanClientId from MongoDB.');
    } else if (envCid) {
      setDhanClientId(envCid);
      console.log('[DHAN TOKEN] Using DHAN_CLIENT_ID from .env (not stored on token doc yet).');
    }
    if (!dbTok) {
      console.warn(
        '[DHAN TOKEN] No JWT in MongoDB. POST /api/dhan/access-token with { "accessToken", "dhanClientId", "password" } (password required if APP_LOGIN_PASSWORD is set).'
      );
    }
  } catch (err) {
    console.error('[DHAN TOKEN] Mongo hydrate failed:', err?.message || err);
  }
}

/**
 * @param {string} token
 * @param {{
 *   force?: boolean,
 *   dhanClientId?: string,
 *   renewCreateTime?: Date | string | null,
 *   renewExpiryTime?: Date | string | null,
 * }} [options]
 */
/** Reload JWT + client id from Mongo into memory (use after manual DB edits). */
async function reloadDhanCredentialsFromMongo() {
  try {
    const doc = await DhanTokenCache.findOne({ key: 'singleton' }).lean();
    const dbTok = sanitizeAccessToken(doc?.accessToken);
    if (dbTok) setAccessToken(dbTok);
    const dbClient = String(doc?.dhanClientId || '').trim();
    if (dbClient) setDhanClientId(dbClient);
    return doc;
  } catch (err) {
    console.error('[DHAN TOKEN] Mongo reload failed:', err?.message || err);
    return null;
  }
}

/**
 * RenewToken only works while the current JWT is still valid (Dhan docs).
 * Skip scheduled renew when JWT is dead or Dhan expiry is still far out.
 */
function shouldAttemptDhanRenew(doc) {
  const token = sanitizeAccessToken(getAccessToken());
  if (!token || !getDhanClientId()) return false;
  if (!tokenLooksValid(token)) return false;

  const renewExpiry = parseDhanApiDate(doc?.renewExpiryTime);
  if (renewExpiry && renewExpiry.getTime() > Date.now() + 3 * 60 * 60 * 1000) {
    return false;
  }

  const jwtExp = decodeJwtMeta(token).exp;
  if (jwtExp && jwtExp > Date.now() + 3 * 60 * 60 * 1000) {
    return false;
  }

  return true;
}

async function persistDhanTokenToMongo(token, options = {}) {
  const t = sanitizeAccessToken(token);
  if (!t) return;
  if (!options.force && !tokenLooksValid(t)) return;

  const $set = { accessToken: t };
  const cid = String(options.dhanClientId || '').trim();
  if (cid) $set.dhanClientId = cid;

  const rc = parseDhanApiDate(options.renewCreateTime);
  if (rc) $set.renewCreateTime = rc;
  const re = parseDhanApiDate(options.renewExpiryTime);
  if (re) $set.renewExpiryTime = re;

  try {
    const doc = await DhanTokenCache.findOneAndUpdate(
      { key: 'singleton' },
      { $set },
      { upsert: true, returnDocument: 'after' }
    );
    return doc;
  } catch (err) {
    console.error('[DHAN TOKEN] Mongo persist failed:', err?.message || err);
    throw err;
  }
}

async function getDhanTokenDoc() {
  return DhanTokenCache.findOne({ key: 'singleton' }).lean();
}

module.exports = {
  hydrateDhanTokenFromMongo,
  reloadDhanCredentialsFromMongo,
  persistDhanTokenToMongo,
  getDhanTokenDoc,
  tokenLooksValid,
  sanitizeAccessToken,
  decodeJwtMeta,
  shouldAttemptDhanRenew,
};

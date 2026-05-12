const DhanTokenCache = require('../models/DhanTokenCache');
const { setAccessToken, setDhanClientId } = require('./dhanTokenStore');

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
    const dbTok = String(doc?.accessToken || '').trim();
    if (dbTok) {
      setAccessToken(dbTok);
      console.log('[DHAN TOKEN] Restored JWT from MongoDB.');
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
async function persistDhanTokenToMongo(token, options = {}) {
  const t = String(token || '').trim();
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
  persistDhanTokenToMongo,
  getDhanTokenDoc,
  tokenLooksValid,
};

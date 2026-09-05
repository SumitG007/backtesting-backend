const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PlatformAdmin = require('../models/PlatformAdmin');

const SINGLETON_KEY = 'singleton';

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET missing or too short — set at least 16 characters in backend .env');
  }
  return secret;
}

function getJwtExpiresIn() {
  return String(process.env.JWT_EXPIRES_IN || '7d').trim() || '7d';
}

/**
 * Boot check only — admin email/password live in MongoDB (PlatformAdmin).
 * Does not read or overwrite from ADMIN / ADMIN_PASSWORD env vars.
 */
async function ensurePlatformAdmin() {
  const doc = await PlatformAdmin.findOne({ key: SINGLETON_KEY }).lean();
  if (!doc?.email || !doc?.passwordHash) {
    throw new Error(
      'Platform admin missing in MongoDB (PlatformAdmin key=singleton). Seed once in DB, then restart.',
    );
  }
  console.log(`[AUTH] Platform admin ready (${doc.email}).`);
  return doc;
}

async function findAdminByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return PlatformAdmin.findOne({ key: SINGLETON_KEY, email: normalized }).lean();
}

async function loginWithCredentials(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const plainPassword = String(password || '');
  if (!normalizedEmail || !plainPassword) {
    return { ok: false, error: 'Email and password are required' };
  }

  const admin = await PlatformAdmin.findOne({ key: SINGLETON_KEY }).lean();
  if (!admin) {
    return { ok: false, error: 'Platform admin not configured' };
  }

  if (admin.email !== normalizedEmail) {
    return { ok: false, error: 'Invalid email or password' };
  }

  const match = await bcrypt.compare(plainPassword, admin.passwordHash);
  if (!match) {
    return { ok: false, error: 'Invalid email or password' };
  }

  const token = jwt.sign(
    { sub: admin.email, role: 'admin' },
    getJwtSecret(),
    { expiresIn: getJwtExpiresIn() }
  );

  return {
    ok: true,
    token,
    user: { email: admin.email, role: 'admin' },
  };
}

function verifyAccessToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (payload?.role !== 'admin') return null;
    return { email: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

/** Auth-gated diagnostics only — never expose via public routes. */
async function getAuthStatus() {
  const doc = await PlatformAdmin.findOne({ key: SINGLETON_KEY }).lean();
  return {
    storedInMongo: Boolean(doc?.email),
    mongoEmail: doc?.email || null,
    lastSyncedFromEnvAt: doc?.lastSyncedFromEnvAt || null,
  };
}

async function verifyPasswordForUser(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const plainPassword = String(password || '');
  if (!normalizedEmail || !plainPassword) {
    return { ok: false, error: 'Password is required' };
  }

  const admin = await PlatformAdmin.findOne({ key: SINGLETON_KEY }).lean();
  if (!admin || admin.email !== normalizedEmail) {
    return { ok: false, error: 'Invalid password' };
  }

  const match = await bcrypt.compare(plainPassword, admin.passwordHash);
  if (!match) {
    return { ok: false, error: 'Invalid password' };
  }

  return { ok: true };
}

module.exports = {
  ensurePlatformAdmin,
  /** @deprecated use ensurePlatformAdmin — kept for older call sites */
  syncAdminFromEnv: ensurePlatformAdmin,
  loginWithCredentials,
  verifyAccessToken,
  verifyPasswordForUser,
  getAuthStatus,
  findAdminByEmail,
};

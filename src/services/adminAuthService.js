const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PlatformAdmin = require('../models/PlatformAdmin');

const BCRYPT_ROUNDS = 12;
const SINGLETON_KEY = 'singleton';

function readAdminEmailFromEnv() {
  return String(process.env.ADMIN || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

function readAdminPasswordFromEnv() {
  return String(process.env.ADMIN_PASSWORD || '');
}

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

/** Upsert platform admin from ADMIN + ADMIN_PASSWORD in .env into MongoDB. */
async function syncAdminFromEnv() {
  const email = readAdminEmailFromEnv();
  const password = readAdminPasswordFromEnv();
  if (!email || !password) {
    throw new Error('ADMIN and ADMIN_PASSWORD must be set in backend .env');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const doc = await PlatformAdmin.findOneAndUpdate(
    { key: SINGLETON_KEY },
    {
      $set: {
        email,
        passwordHash,
        envEmail: email,
        lastSyncedFromEnvAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  console.log(`[AUTH] Platform admin synced to MongoDB (${email}).`);
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

function getPublicAuthConfig() {
  const envEmail = readAdminEmailFromEnv();
  const envPasswordSet = Boolean(readAdminPasswordFromEnv());
  return {
    adminEmail: envEmail || null,
    envConfigured: Boolean(envEmail && envPasswordSet),
    passwordHint: envPasswordSet ? 'Set in server .env (ADMIN_PASSWORD)' : null,
  };
}

async function getAuthStatus() {
  const pub = getPublicAuthConfig();
  const doc = await PlatformAdmin.findOne({ key: SINGLETON_KEY }).lean();
  return {
    ...pub,
    storedInMongo: Boolean(doc?.email),
    mongoEmail: doc?.email || null,
    lastSyncedFromEnvAt: doc?.lastSyncedFromEnvAt || null,
  };
}

module.exports = {
  syncAdminFromEnv,
  loginWithCredentials,
  verifyAccessToken,
  getPublicAuthConfig,
  getAuthStatus,
  readAdminEmailFromEnv,
};

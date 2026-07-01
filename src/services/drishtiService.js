const axios = require('axios');
const { listOptionStockUnderlyings } = require('./dhanLiveService');
const { getIstClock } = require('../utils/dateTime');

const DRISHTI_BASE = String(process.env.DRISHTI_API_BASE_URL || 'https://developers.manasija.in').replace(/\/$/, '');
const CACHE_TTL_MS = Number(process.env.DRISHTI_CACHE_TTL_MS) > 0
  ? Number(process.env.DRISHTI_CACHE_TTL_MS)
  : 5 * 60 * 1000;

const cache = new Map();

function getApiKey() {
  return String(process.env.DRISHTI_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(getApiKey());
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

function drishtiErrorMessage(error) {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const parts = [data.detail, data.message, data.error].filter(Boolean);
    if (parts.length) return parts.join(' — ');
    try {
      return JSON.stringify(data);
    } catch {
      // ignore
    }
  }
  return error?.message || 'Drishti API request failed';
}

async function drishtiGet(path, params = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    const err = new Error('DRISHTI_API_KEY is not set in backend .env');
    err.code = 'DRISHTI_NOT_CONFIGURED';
    throw err;
  }

  const response = await axios.get(`${DRISHTI_BASE}${path}`, {
    params,
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  return response.data;
}

async function fetchPaginated(path, params = {}, { maxPages = 8, limit = 100 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await drishtiGet(path, { ...params, page, limit });
    const chunk = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...chunk);
    if (!payload?.has_next || chunk.length === 0) break;
  }
  return rows;
}

function parseIsoDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKeyFromIso(iso) {
  const d = parseIsoDate(iso);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function daysFromToday(iso) {
  const targetKey = dateKeyFromIso(iso);
  if (!targetKey) return null;
  const todayKey = getIstClock(new Date()).dateKey;
  const t = new Date(`${todayKey}T00:00:00+05:30`);
  const x = new Date(`${targetKey}T00:00:00+05:30`);
  return Math.round((x - t) / (24 * 60 * 60 * 1000));
}

function normalizeUpcoming(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    company: row.company || row.company_name || null,
    date: row.date || null,
    dateKey: dateKeyFromIso(row.date),
    daysFromToday: daysFromToday(row.date),
    purpose: row.purpose || null,
    quarter: row.quarter || null,
    title: row.title || null,
    summary: row.body || row.bm_desc || null,
  };
}

function normalizeEarning(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    company: row.company_name || null,
    date: row.date || null,
    quarter: row.quarter || null,
    summary: row.summary || null,
  };
}

function normalizeAnnouncement(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    company: row.company_name || null,
    date: row.date || null,
    headline: row.headline || row.title || null,
    category: row.category || null,
    summary: row.summary || null,
  };
}

function normalizeNews(row) {
  return {
    id: row.id,
    symbol: row.symbol || null,
    company: row.company || null,
    title: row.title || row.specific_title || null,
    summary: row.summary || row.long_summary || null,
    sentiment: row.sentiment || null,
    source: row.source || null,
    date: row.date || row.published_at || null,
  };
}

function filterByFno(rows, fnoSet) {
  if (!fnoSet?.size) return rows;
  return rows.filter((row) => fnoSet.has(String(row.symbol || '').toUpperCase()));
}

function sortByDateAsc(rows) {
  return [...rows].sort((a, b) => {
    const ad = parseIsoDate(a.date)?.getTime() || Infinity;
    const bd = parseIsoDate(b.date)?.getTime() || Infinity;
    return ad - bd;
  });
}

function sortByDateDesc(rows) {
  return [...rows].sort((a, b) => {
    const ad = parseIsoDate(a.date)?.getTime() || 0;
    const bd = parseIsoDate(b.date)?.getTime() || 0;
    return bd - ad;
  });
}

async function getDashboardData({ fnoOnly = true } = {}) {
  const cacheKey = `dashboard:${fnoOnly ? 'fno' : 'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const fnoSymbols = await listOptionStockUnderlyings();
  const fnoSet = new Set(fnoSymbols);

  const [
    upcomingRaw,
    recentEarningsRaw,
    announcementsRaw,
    newsRaw,
    usageRaw,
  ] = await Promise.all([
    fetchPaginated('/v1/earnings/upcoming', {}, { maxPages: 6, limit: 50 }).catch(() => []),
    drishtiGet('/v1/earnings', { limit: 20 }).then((r) => r?.data || []).catch(() => []),
    drishtiGet('/v1/announcements', { limit: 20, important: true }).then((r) => r?.data || []).catch(() => []),
    drishtiGet('/v1/news', { limit: 15 }).then((r) => r?.data || []).catch(() => []),
    drishtiGet('/v1/account/usage').then((r) => r?.data || null).catch(() => null),
  ]);

  let upcoming = sortByDateAsc(upcomingRaw.map(normalizeUpcoming));
  let recentEarnings = sortByDateDesc(recentEarningsRaw.map(normalizeEarning));
  let announcements = sortByDateDesc(announcementsRaw.map(normalizeAnnouncement));
  let news = sortByDateDesc(newsRaw.map(normalizeNews));

  const upcomingAllCount = upcoming.length;

  if (fnoOnly) {
    upcoming = filterByFno(upcoming, fnoSet);
    recentEarnings = filterByFno(recentEarnings, fnoSet);
    announcements = filterByFno(announcements, fnoSet);
    news = news.filter((row) => !row.symbol || fnoSet.has(String(row.symbol).toUpperCase()));
  }

  const thisWeek = upcoming.filter((row) => {
    const days = row.daysFromToday;
    return days != null && days >= 0 && days <= 7;
  });

  const payload = {
    configured: true,
    source: 'drishti',
    fetchedAt: new Date().toISOString(),
    fnoOnly: Boolean(fnoOnly),
    fnoStockCount: fnoSymbols.length,
    stats: {
      upcomingTotal: upcoming.length,
      upcomingAllMarket: upcomingAllCount,
      upcomingThisWeek: thisWeek.length,
      recentEarnings: recentEarnings.length,
      announcements: announcements.length,
      news: news.length,
    },
    usage: usageRaw
      ? {
        balance: usageRaw.balance ?? null,
        debitedToday: usageRaw.debited_today ?? null,
        reserved: usageRaw.reserved ?? null,
      }
      : null,
    upcomingEarnings: upcoming.slice(0, 100),
    upcomingThisWeek: thisWeek.slice(0, 30),
    recentEarnings: recentEarnings.slice(0, 20),
    announcements: announcements.slice(0, 20),
    news: news.slice(0, 15),
  };

  cacheSet(cacheKey, payload);
  return payload;
}

function getSetupHint() {
  return {
    configured: false,
    message: 'Add DRISHTI_API_KEY to backend .env (free sandbox key from platform.manasija.in/developer-portal).',
    portalUrl: 'https://platform.manasija.in/developer-portal',
    docsUrl: 'https://drishti.manasija.in/docs',
  };
}

module.exports = {
  isConfigured,
  getDashboardData,
  getSetupHint,
  drishtiErrorMessage,
};

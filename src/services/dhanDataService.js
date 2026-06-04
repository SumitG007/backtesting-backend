const axios = require('axios');
const { CACHE_TTL_MS } = require('../config/constants');
const {
  toIntradayDateTime,
  parseDateOnly,
  formatDateOnly,
  addDays,
  differenceInDaysInclusive,
  normalizeTimestamp,
  sleep,
} = require('../utils/dateTime');
const { resolveSymbolConfig } = require('../utils/market');
const { readLatestAccessToken, isLikelyDhanAuthError, ensureValidDhanAccessToken } = require('./tokenService');
const { getDhanClientId } = require('./dhanTokenStore');

const yearCache = new Map();
const inflightRequests = new Map();

function extractDhanApiError(error) {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const parts = [
      data.errorMessage,
      data.message,
      data.error,
      data.remarks,
      data.status,
    ].filter(Boolean);
    if (parts.length) return parts.join(' — ');
    try {
      return JSON.stringify(data);
    } catch {
      // ignore
    }
  }
  return error?.message || 'Dhan API request failed';
}

function buildDhanHistoricalBody({
  securityId,
  exchangeSegment,
  instrument,
  fromDate,
  toDate,
}) {
  const sid = String(securityId || '').trim();
  if (!sid || !/^\d+$/.test(sid)) {
    throw new Error(`Invalid Dhan securityId "${securityId}" — pick another symbol or expiry`);
  }
  let from = String(fromDate).slice(0, 10);
  let to = String(toDate).slice(0, 10);
  if (!from || !to) {
    throw new Error('Invalid date range for historical data');
  }
  if (from >= to) {
    to = formatDateOnly(addDays(parseDateOnly(from), 1));
  }

  const segment = String(exchangeSegment || '').trim();
  const instr = String(instrument || '').trim();
  const isFno = segment === 'NSE_FNO' || segment === 'BSE_FNO';

  const body = {
    securityId: sid,
    exchangeSegment: segment,
    instrument: instr,
    fromDate: from,
    toDate: to,
  };

  // F&O only — boolean per Dhan v2 docs. Omit expiryCode when using contract securityId.
  if (isFno) {
    body.oi = false;
  }

  return body;
}

function isDh905Error(error) {
  const data = error?.response?.data || error?.cause?.response?.data;
  const code = data?.errorCode || data?.error_code;
  const msg = String(data?.errorMessage || data?.error_message || error?.message || '');
  return code === 'DH-905' || /DH-905|Missing required fields|bad values for parameters/i.test(msg);
}

/** Futures historical fallback: underlying scrip + expiryCode (0=current, 1=next, 2=far). */
function buildDhanHistoricalBodyWithExpiryCode({
  securityId,
  exchangeSegment,
  instrument,
  expiryCode,
  fromDate,
  toDate,
}) {
  const body = buildDhanHistoricalBody({
    securityId,
    exchangeSegment,
    instrument,
    fromDate,
    toDate,
  });
  const code = Math.max(0, Math.min(2, Number(expiryCode) || 0));
  body.expiryCode = code;
  return body;
}

async function postDhanHistorical(requestBody) {
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) {
    throw new Error(
      'Dhan credentials missing: set DHAN_CLIENT_ID in .env (or store dhanClientId when seeding JWT) and POST /api/dhan/access-token.',
    );
  }

  const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';

  const makeRequest = (token) =>
    axios.post(`${baseUrl}/charts/historical`, requestBody, {
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

  try {
    const response = await makeRequest(accessToken);
    return response.data || {};
  } catch (error) {
    if (!isLikelyDhanAuthError(error)) {
      const err = new Error(extractDhanApiError(error));
      err.cause = error;
      err.dhanBody = requestBody;
      throw err;
    }
    const renewedToken = await ensureValidDhanAccessToken('auth-retry');
    try {
      const retryResponse = await makeRequest(renewedToken);
      return retryResponse.data || {};
    } catch (retryErr) {
      const err = new Error(extractDhanApiError(retryErr));
      err.cause = retryErr;
      err.dhanBody = requestBody;
      throw err;
    }
  }
}

async function fetchDhanDailyHistorical({
  fromDate,
  toDate,
  securityId,
  exchangeSegment,
  instrument,
  expiryCode,
}) {
  const requestBody = buildDhanHistoricalBody({
    securityId,
    exchangeSegment,
    instrument,
    fromDate,
    toDate,
  });
  if (expiryCode != null && Number.isFinite(Number(expiryCode))) {
    requestBody.expiryCode = Math.max(0, Math.min(2, Number(expiryCode)));
  }
  return postDhanHistorical(requestBody);
}

async function fetchDhanIntradayChunk({ fromDate, toDate, interval, securityId, exchangeSegment, instrument }) {
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) {
    throw new Error(
      'Dhan credentials missing: set DHAN_CLIENT_ID in .env (or store dhanClientId when seeding JWT) and POST /api/dhan/access-token.'
    );
  }

  const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
  const requestBody = {
    securityId,
    exchangeSegment,
    instrument,
    interval: String(interval),
    oi: false,
    fromDate: toIntradayDateTime(fromDate, false),
    toDate: toIntradayDateTime(toDate, true),
  };
  const makeRequest = (token) =>
    axios.post(`${baseUrl}/charts/intraday`, requestBody, {
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

  try {
    const response = await makeRequest(accessToken);
    return response.data || {};
  } catch (error) {
    if (!isLikelyDhanAuthError(error)) throw error;
    const renewedToken = await ensureValidDhanAccessToken('auth-retry');
    const retryResponse = await makeRequest(renewedToken);
    return retryResponse.data || {};
  }
}

function getYearRange(year) {
  const safeYear = Number(year);
  const now = new Date();
  const currentYear = now.getFullYear();
  return {
    fromDate: `${safeYear}-01-01`,
    toDate: safeYear === currentYear ? now.toISOString().slice(0, 10) : `${safeYear}-12-31`,
  };
}

async function fetchYearCandles({ symbol, interval, year }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol selected');
  }

  const { fromDate, toDate } = getYearRange(year);
  const totalDays = differenceInDaysInclusive(fromDate, toDate);
  const chunkCount = Math.ceil(totalDays / 90);
  const allRows = [];
  let currentFrom = parseDateOnly(fromDate);
  const overallEnd = parseDateOnly(toDate);

  for (let i = 0; i < chunkCount; i += 1) {
    const chunkStart = currentFrom;
    const chunkEndCandidate = addDays(chunkStart, 89);
    const chunkEnd = chunkEndCandidate > overallEnd ? overallEnd : chunkEndCandidate;
    const raw = await fetchDhanIntradayChunk({
      fromDate: formatDateOnly(chunkStart),
      toDate: formatDateOnly(chunkEnd),
      interval,
      securityId: resolved.securityId,
      exchangeSegment: resolved.exchangeSegment,
      instrument: resolved.instrument,
    });
    await sleep(250);

    const timestamps = raw.timestamp || [];
    const opens = raw.open || [];
    const highs = raw.high || [];
    const lows = raw.low || [];
    const closes = raw.close || [];
    const volumes = raw.volume || [];

    for (let j = 0; j < timestamps.length; j += 1) {
      const ts = normalizeTimestamp(timestamps[j]);
      if (Number.isNaN(ts.getTime())) continue;
      allRows.push([ts.toISOString(), opens[j], highs[j], lows[j], closes[j], volumes[j]]);
    }
    currentFrom = addDays(chunkEnd, 1);
  }

  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { rows: allRows, fromDate, toDate };
}

/** Single cash-session calendar day (IST date string YYYY-MM-DD). */
async function fetchTradingDayCandles({ symbol, interval, dateKey }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol selected');
  }
  const raw = await fetchDhanIntradayChunk({
    fromDate: dateKey,
    toDate: dateKey,
    interval: String(interval),
    securityId: resolved.securityId,
    exchangeSegment: resolved.exchangeSegment,
    instrument: resolved.instrument,
  });
  await sleep(150);

  const allRows = [];
  const timestamps = raw.timestamp || [];
  const opens = raw.open || [];
  const highs = raw.high || [];
  const lows = raw.low || [];
  const closes = raw.close || [];
  const volumes = raw.volume || [];

  for (let j = 0; j < timestamps.length; j += 1) {
    const ts = normalizeTimestamp(timestamps[j]);
    if (Number.isNaN(ts.getTime())) continue;
    allRows.push([ts.toISOString(), opens[j], highs[j], lows[j], closes[j], volumes[j]]);
  }
  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { rows: allRows, dateKey };
}

async function fetchWithRateLimitRetry(args) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetchYearCandles(args);
    } catch (error) {
      const errorCode = error?.response?.data?.errorCode;
      if (errorCode === 'DH-904' && attempt < 3) {
        await sleep((attempt + 1) * 2000);
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function getCandlesWithCache({ symbol, interval, year, refresh = false }) {
  const cacheKey = `${symbol}:${interval}:${year}`;
  let payload = yearCache.get(cacheKey);

  if (!payload || refresh || Date.now() - payload.fetchedAt > CACHE_TTL_MS) {
    if (!inflightRequests.has(cacheKey)) {
      inflightRequests.set(
        cacheKey,
        fetchWithRateLimitRetry({ symbol, interval, year }).finally(() => {
          inflightRequests.delete(cacheKey);
        })
      );
    }
    const fresh = await inflightRequests.get(cacheKey);
    payload = { ...fresh, fetchedAt: Date.now() };
    yearCache.set(cacheKey, payload);
  }

  return payload;
}

module.exports = {
  fetchDhanDailyHistorical,
  postDhanHistorical,
  buildDhanHistoricalBody,
  buildDhanHistoricalBodyWithExpiryCode,
  isDh905Error,
  extractDhanApiError,
  fetchWithRateLimitRetry,
  fetchTradingDayCandles,
  getCandlesWithCache,
};

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
const { readLatestAccessToken, isLikelyDhanAuthError, renewDhanAccessToken } = require('./tokenService');

const yearCache = new Map();
const inflightRequests = new Map();

async function fetchDhanIntradayChunk({ fromDate, toDate, interval, securityId, exchangeSegment, instrument }) {
  const clientId = process.env.DHAN_CLIENT_ID;
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) {
    throw new Error('DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN not configured in backend .env');
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
    const renewedToken = await renewDhanAccessToken('auth-retry');
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
  fetchWithRateLimitRetry,
  getCandlesWithCache,
};

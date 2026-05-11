const axios = require('axios');
const WebSocket = require('ws');
const { readLatestAccessToken, isLikelyDhanAuthError, ensureValidDhanAccessToken } = require('./tokenService');
const { resolveSymbolConfig } = require('../utils/market');

const DHAN_BASE = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
const DHAN_WS_URL = 'wss://api-feed.dhan.co';
const INSTRUMENT_CSV_URL =
  process.env.DHAN_INSTRUMENT_CSV || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

// ----------------- Instrument Master (lot sizes, security ids) -----------------

const instrumentCache = {
  rows: null,
  loadedAt: 0,
  ttlMs: 6 * 60 * 60 * 1000,
};

async function loadInstrumentMaster({ force = false } = {}) {
  if (!force && instrumentCache.rows && Date.now() - instrumentCache.loadedAt < instrumentCache.ttlMs) {
    return instrumentCache.rows;
  }
  const response = await axios.get(INSTRUMENT_CSV_URL, { timeout: 60000, responseType: 'text' });
  const text = String(response.data || '');
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error('Empty instrument master CSV');
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = (cols[c] || '').trim();
    }
    rows.push(obj);
  }
  instrumentCache.rows = rows;
  instrumentCache.loadedAt = Date.now();
  return rows;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return null;
}

async function getCurrentLotSize(underlying) {
  const upper = String(underlying || '').toUpperCase();
  try {
    const rows = await loadInstrumentMaster();
    const today = new Date().toISOString().slice(0, 10);
    // Find current futures / options contracts for the underlying.
    const candidates = rows.filter((r) => {
      const instr = (pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '').toUpperCase();
      const ulName = (pickField(r, ['UNDERLYING_SYMBOL', 'SEM_TRADING_SYMBOL', 'SYMBOL_NAME']) || '').toUpperCase();
      if (!(instr === 'FUTIDX' || instr === 'FUTSTK' || instr === 'OPTIDX')) return false;
      // Match strictly by underlying symbol so NIFTY does not accidentally pick up MIDCPNIFTY etc.
      if (instr === 'FUTIDX' || instr === 'FUTSTK') return ulName === upper;
      // For OPTIDX the trading symbol starts with the underlying followed by a separator.
      return ulName === upper || ulName.startsWith(`${upper}-`) || ulName.startsWith(`${upper} `);
    });
    // Prefer the nearest expiry >= today.
    const withExpiry = candidates
      .map((r) => ({
        row: r,
        expiry: pickField(r, ['SEM_EXPIRY_DATE', 'EXPIRY_DATE', 'ExpiryDate']) || '',
        lotSize: Number(pickField(r, ['LOT_SIZE', 'SEM_LOT_UNITS', 'LotSize'])),
      }))
      .filter((c) => Number.isFinite(c.lotSize) && c.lotSize > 0);
    const future = withExpiry.filter((c) => c.expiry && c.expiry.slice(0, 10) >= today);
    const past = withExpiry.filter((c) => !future.includes(c));
    const sortedFuture = future.sort((a, b) => a.expiry.localeCompare(b.expiry));
    const sortedPast = past.sort((a, b) => b.expiry.localeCompare(a.expiry));
    const best = sortedFuture[0] || sortedPast[0];
    if (best) return best.lotSize;
  } catch {
    // ignore and fall back below
  }
  // Sensible 2025+ SEBI defaults if master file is unavailable.
  if (upper === 'NIFTY') return 75;
  if (upper === 'BANKNIFTY') return 30;
  return 1;
}

// ----------------- Option Chain -----------------

async function fetchExpiryList(symbol) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for option chain');
  }
  const clientId = process.env.DHAN_CLIENT_ID;
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const body = {
    UnderlyingScrip: Number(resolved.securityId),
    UnderlyingSeg: resolved.exchangeSegment,
  };
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(`${DHAN_BASE}/optionchain/expirylist`, body, { headers, timeout: 20000 });
    const list = resp.data?.data || [];
    return Array.isArray(list) ? list : [];
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken('optionchain-expiry');
      const retry = await axios.post(
        `${DHAN_BASE}/optionchain/expirylist`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: 20000 }
      );
      const list = retry.data?.data || [];
      return Array.isArray(list) ? list : [];
    }
    throw error;
  }
}

const OPTION_CHAIN_MIN_INTERVAL_MS = 3100;
const optionChainCache = new Map();

async function fetchOptionChain({ symbol, expiry }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for option chain');
  }
  const clientId = process.env.DHAN_CLIENT_ID;
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const body = {
    UnderlyingScrip: Number(resolved.securityId),
    UnderlyingSeg: resolved.exchangeSegment,
    Expiry: String(expiry),
  };
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(`${DHAN_BASE}/optionchain`, body, { headers, timeout: 20000 });
    return resp.data?.data || {};
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken('optionchain-data');
      const retry = await axios.post(
        `${DHAN_BASE}/optionchain`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: 20000 }
      );
      return retry.data?.data || {};
    }
    throw error;
  }
}

/** Dhan rate limit: ~1 option-chain per 3s per underlying+expiry — coalesce all callers. */
async function fetchOptionChainCached({ symbol, expiry }) {
  const key = `${String(symbol).toUpperCase()}|${String(expiry)}`;
  const now = Date.now();
  const cached = optionChainCache.get(key);
  if (cached && now - cached.at < OPTION_CHAIN_MIN_INTERVAL_MS) {
    return cached.data;
  }
  const data = await fetchOptionChain({ symbol, expiry });
  optionChainCache.set(key, { at: now, data });
  return data;
}

async function getNearestWeeklyExpiry(symbol) {
  const list = await fetchExpiryList(symbol);
  if (list.length === 0) return null;
  // Dhan returns expiries as YYYY-MM-DD strings; sort ascending and pick first future expiry.
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...list].sort();
  for (const expiry of sorted) {
    if (expiry >= today) return expiry;
  }
  return sorted[sorted.length - 1];
}

function pickLegHighMark(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const candidates = [
    Number(leg.last_price),
    Number(leg.top_ask_price),
    Number(leg.top_bid_price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function pickLegLowMark(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const candidates = [
    Number(leg.last_price),
    Number(leg.top_bid_price),
    Number(leg.top_ask_price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

async function getAtmPremiums({ symbol, strike, expiry }) {
  const chain = await fetchOptionChainCached({ symbol, expiry });
  const spot = Number(chain.last_price);
  const strikes = chain.oc || {};
  const strikeKey = Object.keys(strikes).find((k) => Math.abs(Number(k) - Number(strike)) < 0.5);
  if (!strikeKey) {
    return {
      spot,
      ceLtp: null,
      peLtp: null,
      ceMarkHigh: null,
      ceMarkLow: null,
      peMarkHigh: null,
      peMarkLow: null,
      chainSpot: spot,
    };
  }
  const row = strikes[strikeKey] || {};
  const ce = row.ce || {};
  const pe = row.pe || {};
  const ceLast = Number(ce.last_price) || null;
  const peLast = Number(pe.last_price) || null;
  return {
    spot,
    ceLtp: ceLast,
    peLtp: peLast,
    ceMarkHigh: pickLegHighMark(ce),
    ceMarkLow: pickLegLowMark(ce),
    peMarkHigh: pickLegHighMark(pe),
    peMarkLow: pickLegLowMark(pe),
    chainSpot: spot,
  };
}

// ----------------- WebSocket (Live Index Ticker) -----------------

const wsState = {
  ws: null,
  subscribers: new Map(),
  lastPrices: new Map(),
  connecting: false,
  reconnectAttempts: 0,
  intentionalClose: false,
};

function packInstrumentSubscription({ securityId, exchangeSegmentCode }) {
  // RequestCode 15 = Ticker packet; Message format per Dhan WS v2:
  // 1 byte feedRequestCode + 1 byte instrumentCount(=1) + 1 byte exchange + 20 bytes securityId
  const buf = Buffer.alloc(23);
  buf.writeUInt8(15, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt8(exchangeSegmentCode, 2);
  buf.write(String(securityId), 3, 20, 'utf8');
  return buf;
}

function exchangeSegmentToCode(seg) {
  // Per Dhan Marketfeed protocol:
  switch (String(seg || '').toUpperCase()) {
    case 'IDX_I':
      return 0;
    case 'NSE_EQ':
      return 1;
    case 'NSE_FNO':
      return 2;
    case 'NSE_CURRENCY':
      return 3;
    case 'BSE_EQ':
      return 4;
    case 'MCX_COMM':
      return 5;
    case 'BSE_CURRENCY':
      return 7;
    case 'BSE_FNO':
      return 8;
    default:
      return 0;
  }
}

function decodeTickerPacket(buffer) {
  // Header (8 bytes) + Ticker payload: LTP (4 byte float) + LTT (4 byte int)
  if (buffer.length < 16) return null;
  const responseCode = buffer.readUInt8(0);
  if (responseCode !== 2) return null;
  const ltp = buffer.readFloatLE(8);
  const ltt = buffer.readInt32LE(12);
  return { ltp, ltt, responseCode };
}

function ensureWsConnection() {
  if (wsState.ws && (wsState.ws.readyState === WebSocket.OPEN || wsState.ws.readyState === WebSocket.CONNECTING)) {
    return wsState.ws;
  }
  if (wsState.connecting) return null;

  const clientId = process.env.DHAN_CLIENT_ID;
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) {
    console.warn('[DhanLive] WS skipped — missing credentials');
    return null;
  }

  wsState.connecting = true;
  wsState.intentionalClose = false;
  const url = `${DHAN_WS_URL}?version=2&token=${accessToken}&clientId=${clientId}&authType=2`;
  const ws = new WebSocket(url);
  wsState.ws = ws;

  ws.on('open', () => {
    console.log('[DhanLive] WS connected');
    wsState.connecting = false;
    wsState.reconnectAttempts = 0;
    for (const sub of wsState.subscribers.values()) {
      try {
        ws.send(packInstrumentSubscription(sub));
      } catch (err) {
        console.error('[DhanLive] WS resub failed:', err.message);
      }
    }
  });

  ws.on('message', (data) => {
    if (!(data instanceof Buffer)) return;
    const decoded = decodeTickerPacket(data);
    if (!decoded || !Number.isFinite(decoded.ltp) || decoded.ltp <= 0) return;
    // We only have one symbol subscribed at a time for the engine — broadcast LTP to all listeners.
    for (const [key, sub] of wsState.subscribers.entries()) {
      wsState.lastPrices.set(key, { ltp: decoded.ltp, ts: Date.now() });
      if (typeof sub.onTick === 'function') {
        try {
          sub.onTick({ ltp: decoded.ltp, ltt: decoded.ltt });
        } catch (err) {
          console.error('[DhanLive] tick handler error:', err.message);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[DhanLive] WS error:', err.message);
  });

  ws.on('close', (code) => {
    console.log('[DhanLive] WS closed', code);
    wsState.ws = null;
    wsState.connecting = false;
    if (wsState.intentionalClose) return;
    if (wsState.subscribers.size === 0) return;
    wsState.reconnectAttempts = Math.min(10, wsState.reconnectAttempts + 1);
    const backoff = Math.min(30000, 1000 * 2 ** wsState.reconnectAttempts);
    setTimeout(() => ensureWsConnection(), backoff);
  });

  return ws;
}

function subscribeLiveSymbol({ key, symbol, onTick }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for live subscription');
  }
  wsState.subscribers.set(key, {
    securityId: resolved.securityId,
    exchangeSegmentCode: exchangeSegmentToCode(resolved.exchangeSegment),
    onTick,
  });
  const ws = ensureWsConnection();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(packInstrumentSubscription({
        securityId: resolved.securityId,
        exchangeSegmentCode: exchangeSegmentToCode(resolved.exchangeSegment),
      }));
    } catch (err) {
      console.error('[DhanLive] WS sub failed:', err.message);
    }
  }
}

function unsubscribeLiveSymbol(key) {
  wsState.subscribers.delete(key);
  wsState.lastPrices.delete(key);
  if (wsState.subscribers.size === 0 && wsState.ws) {
    wsState.intentionalClose = true;
    try {
      wsState.ws.close();
    } catch {
      // ignore
    }
    wsState.ws = null;
  }
}

function getLastPrice(key) {
  return wsState.lastPrices.get(key) || null;
}

module.exports = {
  loadInstrumentMaster,
  getCurrentLotSize,
  fetchExpiryList,
  fetchOptionChain,
  getNearestWeeklyExpiry,
  getAtmPremiums,
  subscribeLiveSymbol,
  unsubscribeLiveSymbol,
  getLastPrice,
};

/**
 * In-process Dhan JWT + client id. Source of truth is MongoDB; hydrated on startup; updated on renew.
 */
let cachedToken = '';
let cachedClientId = '';

function getAccessToken() {
  return String(cachedToken || '').trim();
}

function setAccessToken(token) {
  cachedToken = String(token || '').trim();
}

function getDhanClientId() {
  const fromMem = String(cachedClientId || '').trim();
  if (fromMem) return fromMem;
  return String(process.env.DHAN_CLIENT_ID || '').trim();
}

function setDhanClientId(clientId) {
  cachedClientId = String(clientId || '').trim();
}

module.exports = { getAccessToken, setAccessToken, getDhanClientId, setDhanClientId };

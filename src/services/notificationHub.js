/**
 * Day-scoped live notifications (IST). Cleared automatically on a new calendar day.
 * Broadcast via Socket.IO — safe no-op if the hub is not attached yet.
 */
const { randomUUID } = require('crypto');
const { getIstClock } = require('../utils/dateTime');

const MAX_DAY_ITEMS = 200;

let io = null;
/** @type {{ dateKey: string, items: object[] }} */
let store = { dateKey: '', items: [] };

function todayDateKey() {
  return getIstClock(new Date()).dateKey;
}

function ensureToday() {
  const dateKey = todayDateKey();
  if (store.dateKey !== dateKey) {
    store = { dateKey, items: [] };
  }
  return dateKey;
}

function attachSocketServer(socketIo) {
  io = socketIo || null;
}

function listToday() {
  ensureToday();
  return {
    dateKey: store.dateKey,
    notifications: store.items.slice(),
  };
}

function pushNotification({
  type = 'INFO',
  title,
  body = '',
  strategy = 'System',
  meta = {},
  dedupeKey = null,
} = {}) {
  if (!title) return null;
  const dateKey = ensureToday();
  if (dedupeKey) {
    const key = `${dateKey}:${String(dedupeKey)}`;
    if (store.items.some((n) => n.meta?.dedupeKey === key)) {
      return null;
    }
    meta = { ...meta, dedupeKey: key };
  }
  const item = {
    id: randomUUID(),
    at: new Date().toISOString(),
    dateKey,
    type: String(type || 'INFO').toUpperCase(),
    title: String(title).slice(0, 160),
    body: String(body || '').slice(0, 400),
    strategy: String(strategy || 'System').slice(0, 80),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  store.items.unshift(item);
  if (store.items.length > MAX_DAY_ITEMS) {
    store.items.length = MAX_DAY_ITEMS;
  }
  if (io) {
    try {
      io.emit('notification:new', item);
      io.emit('notification:day', listToday());
    } catch (err) {
      console.warn('[Notifications] emit failed:', err.message);
    }
  }
  return item;
}

function markAllRead() {
  // Client-side unread tracking; server keeps day history only.
  return listToday();
}

module.exports = {
  attachSocketServer,
  listToday,
  pushNotification,
  markAllRead,
  ensureToday,
};

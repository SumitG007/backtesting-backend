const { Server } = require('socket.io');
const { verifyAccessToken } = require('./adminAuthService');
const { attachSocketServer, listToday } = require('./notificationHub');

let ioRef = null;

function normalizeCorsOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  const origins = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return item.replace(/\/+$/, '');
      }
    });
  return origins.length <= 1 ? origins[0] : origins;
}

/**
 * Broadcast to all authenticated sockets. Safe no-op before init / on emit errors.
 */
function broadcast(event, payload) {
  if (!ioRef) return false;
  try {
    ioRef.emit(event, payload);
    return true;
  } catch (err) {
    console.warn('[Realtime] broadcast failed:', err.message);
    return false;
  }
}

const PAPER_LIVE_ROOMS = {
  'manual-console': 'paper-live:manual-console',
  'strategy-14': 'paper-live:strategy-14',
};

function paperLiveRoom(strategyId) {
  return PAPER_LIVE_ROOMS[String(strategyId || '').toLowerCase()] || null;
}

/** Live marks go only to pages that subscribed — not every open tab. */
function broadcastPaperLive(strategyId, payload) {
  const room = paperLiveRoom(strategyId);
  if (!ioRef || !room) return false;
  try {
    ioRef.to(room).emit('paper-live:mark', payload);
    return true;
  } catch (err) {
    console.warn('[Realtime] paper-live emit failed:', err.message);
    return false;
  }
}

/**
 * Attach Socket.IO to the HTTP server without changing Express routes.
 * Uses polling + websocket so AWS ALB / reverse proxies stay compatible.
 */
function initRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: normalizeCorsOrigin(process.env.CORS_ORIGIN),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    try {
      const token = String(
        socket.handshake?.auth?.token
          || socket.handshake?.headers?.authorization?.replace(/^Bearer\s+/i, '')
          || '',
      ).trim();
      const user = verifyAccessToken(token);
      if (!user) return next(new Error('Unauthorized'));
      socket.user = user;
      return next();
    } catch (err) {
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    socket.emit('notification:day', listToday());
    socket.on('notification:list', () => {
      socket.emit('notification:day', listToday());
    });

    // Paper-live MTM / live mark snapshot (EOD OI Walls + Manual Console).
    socket.on('paper-live:subscribe', (msg = {}) => {
      const strategyId = String(msg?.strategyId || '').toLowerCase();
      const room = paperLiveRoom(strategyId);
      if (room) socket.join(room);
      try {
        let engine = null;
        if (strategyId === 'manual-console') {
          engine = require('./manualTradeEngine');
        } else if (strategyId === 'strategy-14') {
          engine = require('./liveEodOiWallsEngine');
        } else {
          return;
        }
        const snap = typeof engine.getLiveMarkSnapshot === 'function'
          ? engine.getLiveMarkSnapshot()
          : null;
        if (snap) socket.emit('paper-live:mark', snap);
      } catch (err) {
        console.warn('[Realtime] paper-live snapshot failed:', err.message);
      }
    });
  });

  ioRef = io;
  attachSocketServer(io);
  console.log('[Realtime] Socket.IO ready at /socket.io');
  return io;
}

module.exports = { initRealtime, broadcast, broadcastPaperLive };

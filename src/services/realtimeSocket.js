const { Server } = require('socket.io');
const { verifyAccessToken } = require('./adminAuthService');
const { attachSocketServer, listToday } = require('./notificationHub');

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
  });

  attachSocketServer(io);
  console.log('[Realtime] Socket.IO ready at /socket.io');
  return io;
}

module.exports = { initRealtime };

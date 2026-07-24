require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { setPlatformReady } = require('./serverState');
const { scheduleDhanTokenMaintenance } = require('./services/dhanTokenScheduler');
const { hydrateDhanTokenFromMongo } = require('./services/dhanTokenPersistence');
const { scheduleNseHolidayRefresh } = require('./services/nseHolidayService');
const { initRealtime } = require('./services/realtimeSocket');
const strategySixPaperEngine = require('./services/liveShortStraddleEngineStrategy6');
const strategySevenPaperEngine = require('./services/livePutBuyEngine');
const strategyTwelvePaperEngine = require('./services/liveMorningOiEngine');
const strategyThirteenPaperEngine = require('./services/liveOiScalpEngine');

/** Legacy Strategy A reopen env — engine retired. */
async function runPendingStrategyAReopenFromEnv() {
  const tradeId = String(process.env.REOPEN_STRATEGY_A_TRADE_ID || '').trim();
  if (!tradeId) return;
  console.warn('[REOPEN] Strategy A paper-live was removed; ignoring REOPEN_STRATEGY_A_TRADE_ID=', tradeId);
  delete process.env.REOPEN_STRATEGY_A_TRADE_ID;
}

async function bootBackgroundServices() {
  try {
    const s6 = require('./services/liveShortStraddleEngineStrategy6');
    const s7 = require('./services/livePutBuyEngine');
    await s6.reconcileOpenTrades();
    await s7.reconcileOpenTrades();
    await require('./services/liveMorningOiEngine').reconcileOpenTrades();
    await require('./services/liveOiScalpEngine').reconcileOpenTrades();
  } catch (err) {
    console.warn('Paper-live open-trade reconcile:', err.message);
  }

  await hydrateDhanTokenFromMongo();
  scheduleDhanTokenMaintenance();
  scheduleNseHolidayRefresh();

  try {
    const LivePaperTrade = require('./models/livePaperTrade');
    await LivePaperTrade.syncIndexes();
  } catch (err) {
    console.warn('LivePaperTrade index sync:', err.message);
  }

  try {
    const manualEngine = require('./services/manualTradeEngine');
    await manualEngine.ensureEngineRunning();
    console.log('Manual trading console engine started');
  } catch (err) {
    console.warn('Manual console engine boot:', err.message);
  }

  try {
    const boot = await strategySixPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Short straddle paper-live engine started (strategy-6)');
    } else {
      console.warn('Short straddle paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Short straddle paper-live engine boot failed:', err.message);
  }

  try {
    const boot = await strategySevenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 3 put buy paper-live engine started (always on)');
    } else {
      console.warn('Strategy 3 put buy paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 3 put buy paper-live engine boot failed:', err.message);
  }

  try {
    const boot = await strategyTwelvePaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('OI Wall Entry paper-live started (strategy-9)');
    } else {
      console.warn('OI Wall Entry paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('OI Wall Entry paper-live boot failed:', err.message);
  }

  try {
    const boot = await strategyThirteenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('OI Scalp paper-live started (strategy-10)');
    } else {
      console.warn('OI Scalp paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('OI Scalp paper-live boot failed:', err.message);
  }

  try {
    const { notifyDhanConnectivityRestored } = require('./services/livePaperEngineRecovery');
    const resume = await notifyDhanConnectivityRestored();
    if (
      resume.strategy6?.resumed
      || resume.strategy7?.resumed
      || resume.strategy12?.resumed
      || resume.strategy13?.resumed
    ) {
      console.log('Paper-live resumed open positions from MongoDB after boot', resume);
    }
  } catch (err) {
    console.warn('Paper-live post-boot resume:', err.message);
  }

  setPlatformReady(true);
  console.log('[SERVER] Platform boot complete (paper-live + Dhan scheduler).');
}

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI missing in backend .env');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');

  await runPendingStrategyAReopenFromEnv();

  try {
    const { syncAdminFromEnv } = require('./services/adminAuthService');
    await syncAdminFromEnv();
  } catch (err) {
    console.error('[AUTH] Admin sync failed:', err.message);
    throw err;
  }

  // HTTP server so Socket.IO can share the same port (AWS / ALB friendly).
  const httpServer = http.createServer(app);
  initRealtime(httpServer);

  // Listen immediately so the frontend proxy never gets ECONNREFUSED during long engine boot.
  await new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
      resolve();
    });
  });

  bootBackgroundServices().catch((err) => {
    console.error('[SERVER] Background boot failed:', err.message);
  });
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});

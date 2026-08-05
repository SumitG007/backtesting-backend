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
const strategySevenPutBuyEngine = require('./services/livePutBuyEngine');
const strategyTwelvePaperEngine = require('./services/liveMorningOiEngine');
const strategyTwelveMultiPaperEngine = require('./services/liveMorningOiMultiEngine');
const strategyFourteenPaperEngine = require('./services/liveEodOiWallsEngine');

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
    await s6.reconcileOpenTrades();
    await require('./services/livePutBuyEngine').reconcileOpenTrades();
    await require('./services/liveMorningOiEngine').reconcileOpenTrades();
    await require('./services/liveMorningOiMultiEngine').reconcileOpenTrades();
    await require('./services/liveEodOiWallsEngine').reconcileOpenTrades();
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
    const manualOiAuto = require('./services/manualOiAutoEngine');
    await manualOiAuto.ensureEngineRunning();
  } catch (err) {
    console.warn('Manual OI auto engine boot:', err.message);
  }

  try {
    const oiFlow = require('./services/oiFlowMinuteEngine');
    const boot = oiFlow.ensureEngineRunning();
    if (boot.ok) {
      console.log('OI flow minute recorder started (current day only)');
    }
  } catch (err) {
    console.warn('OI flow minute engine boot:', err.message);
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
    const boot = await strategySevenPutBuyEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Put & Call buy paper-live started (strategy-3)');
    } else {
      console.warn('Put & Call buy paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Put & Call buy paper-live boot failed:', err.message);
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
    const boot = await strategyTwelveMultiPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('OI Wall Multi paper-live started (strategy-10)');
    } else {
      console.warn('OI Wall Multi paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('OI Wall Multi paper-live boot failed:', err.message);
  }

  try {
    const boot = await strategyFourteenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('EOD OI Walls paper-live started (strategy-14)');
    } else {
      console.warn('EOD OI Walls paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('EOD OI Walls paper-live boot failed:', err.message);
  }

  try {
    const { notifyDhanConnectivityRestored } = require('./services/livePaperEngineRecovery');
    const resume = await notifyDhanConnectivityRestored();
    if (
      resume.strategy3?.resumed
      || resume.strategy6?.resumed
      || resume.strategy12?.resumed
      || resume.strategy12Multi?.resumed
      || resume.strategy14?.resumed
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

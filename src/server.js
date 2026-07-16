require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { setPlatformReady } = require('./serverState');
const { scheduleDhanTokenMaintenance } = require('./services/dhanTokenScheduler');
const { hydrateDhanTokenFromMongo } = require('./services/dhanTokenPersistence');
const { scheduleNseHolidayRefresh } = require('./services/nseHolidayService');
const strategyFourPaperEngine = require('./services/liveShortStraddleEngine');
const strategySixPaperEngine = require('./services/liveShortStraddleEngineStrategy6');
const strategySevenPaperEngine = require('./services/livePutBuyEngine');
const strategyElevenPaperEngine = require('./services/liveSlFlipEngine');

/** One-shot DB restore when REOPEN_STRATEGY_A_TRADE_ID is set (see npm run reopen:strategy-a). */
async function runPendingStrategyAReopenFromEnv() {
  const tradeId = String(process.env.REOPEN_STRATEGY_A_TRADE_ID || '').trim();
  if (!tradeId) return;
  const exitTime = String(process.env.REOPEN_STRATEGY_A_EXIT_TIME || '09:20').trim();
  console.log(`[REOPEN] Restoring Strategy A trade ${tradeId} (exit ${exitTime} IST on next valid day)…`);
  const { reopenStrategyATrade } = require('./services/reopenStrategyATradeService');
  const result = await reopenStrategyATrade(tradeId, { exitTime });
  console.log('[REOPEN] Done:', {
    tradeId: result.tradeId,
    status: result.trade?.status,
    hasExitTime: Boolean(result.trade?.exitTime),
    plannedExitDateKey: result.plannedExitDateKey,
    nextDayExit: result.nextDayExit,
    walletRealizedPnl: result.walletRealizedPnl,
  });
  delete process.env.REOPEN_STRATEGY_A_TRADE_ID;
}

async function bootBackgroundServices() {
  try {
    const s4 = require('./services/liveShortStraddleEngine');
    const s6 = require('./services/liveShortStraddleEngineStrategy6');
    const s7 = require('./services/livePutBuyEngine');
    const s11 = require('./services/liveSlFlipEngine');
    await s4.reconcileOpenTrades();
    await s6.reconcileOpenTrades();
    await s7.reconcileOpenTrades();
    await s11.reconcileOpenTrades();
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
    const boot = await strategyFourPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 2 paper-live engine started (always on)');
    } else {
      console.warn('Strategy 2 paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 2 paper-live engine boot failed:', err.message);
  }

  try {
    const boot = await strategySixPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 6 paper-live engine started (always on)');
    } else {
      console.warn('Strategy 6 paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 6 paper-live engine boot failed:', err.message);
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
    const boot = await strategyElevenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 6 SL Flip paper-live engine started (always on, live id strategy-8)');
    } else {
      console.warn('Strategy 6 SL Flip paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 6 SL Flip paper-live engine boot failed:', err.message);
  }

  try {
    const { notifyDhanConnectivityRestored } = require('./services/livePaperEngineRecovery');
    const resume = await notifyDhanConnectivityRestored();
    if (
      resume.strategy4?.resumed
      || resume.strategy6?.resumed
      || resume.strategy7?.resumed
      || resume.strategy11?.resumed
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

  // Listen immediately so the frontend proxy never gets ECONNREFUSED during long engine boot.
  await new Promise((resolve) => {
    app.listen(PORT, () => {
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

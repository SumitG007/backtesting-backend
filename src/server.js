require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { setPlatformReady } = require('./serverState');
const { scheduleDhanTokenMaintenance } = require('./services/dhanTokenScheduler');
const { hydrateDhanTokenFromMongo } = require('./services/dhanTokenPersistence');
const { scheduleNseHolidayRefresh } = require('./services/nseHolidayService');
const strategyThreePaperEngine = require('./services/liveIvMeanReversionEngine');
const strategyFourPaperEngine = require('./services/liveShortStraddleEngine');
const strategySixPaperEngine = require('./services/liveShortStraddleEngineStrategy6');

async function bootBackgroundServices() {
  try {
    const s4 = require('./services/liveShortStraddleEngine');
    const s6 = require('./services/liveShortStraddleEngineStrategy6');
    const s3 = require('./services/liveIvMeanReversionEngine');
    await s3.reconcileOpenTrades();
    await s4.reconcileOpenTrades();
    await s6.reconcileOpenTrades();
  } catch (err) {
    console.warn('Paper-live open-trade reconcile:', err.message);
  }

  await hydrateDhanTokenFromMongo();
  scheduleDhanTokenMaintenance();
  scheduleNseHolidayRefresh();

  try {
    const boot = await strategyThreePaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 1 paper-live engine started (always on)');
    } else {
      console.warn('Strategy 1 paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 1 paper-live engine boot failed:', err.message);
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
    const { notifyDhanConnectivityRestored } = require('./services/livePaperEngineRecovery');
    const resume = await notifyDhanConnectivityRestored();
    if (resume.strategy3?.resumed || resume.strategy4?.resumed || resume.strategy6?.resumed) {
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

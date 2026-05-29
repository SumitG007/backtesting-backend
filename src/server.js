require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { scheduleDhanTokenMaintenance } = require('./services/dhanTokenScheduler');
const { hydrateDhanTokenFromMongo } = require('./services/dhanTokenPersistence');
const { scheduleNseHolidayRefresh } = require('./services/nseHolidayService');
const strategyThreePaperEngine = require('./services/liveIvMeanReversionEngine');
const strategyFourPaperEngine = require('./services/liveShortStraddleEngine');

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI missing in backend .env');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');
  try {
    const { reconcileOpenTrades } = require('./services/liveShortStraddleEngine');
    await reconcileOpenTrades();
  } catch (err) {
    console.warn('Strategy 4 open-trade reconcile:', err.message);
  }
  await hydrateDhanTokenFromMongo();
  scheduleDhanTokenMaintenance();
  scheduleNseHolidayRefresh();
  try {
    const boot = await strategyThreePaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 3 paper-live engine started (always on)');
    } else {
      console.warn('Strategy 3 paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 3 paper-live engine boot failed:', err.message);
  }
  try {
    const boot = await strategyFourPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Strategy 4 paper-live engine started (always on)');
    } else {
      console.warn('Strategy 4 paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Strategy 4 paper-live engine boot failed:', err.message);
  }
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});

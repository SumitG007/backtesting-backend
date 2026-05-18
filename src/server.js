require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { scheduleDhanTokenMaintenance } = require('./services/dhanTokenScheduler');
const { hydrateDhanTokenFromMongo } = require('./services/dhanTokenPersistence');
const { bootEngineFromDb: bootShortStraddleEngineFromDb } = require('./services/liveShortStraddleEngine');
const { scheduleNseHolidayRefresh } = require('./services/nseHolidayService');

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI missing in backend .env');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');
  await hydrateDhanTokenFromMongo();
  scheduleDhanTokenMaintenance();
  scheduleNseHolidayRefresh();
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
  // Always-on live paper trading engine on NIFTY (short straddle).
  bootShortStraddleEngineFromDb({ symbol: 'NIFTY' })
    .then((result) => {
      if (result?.ok) console.log('[Strategy2LiveEngine] auto-started for NIFTY');
      else console.warn('[Strategy2LiveEngine] auto-start skipped:', result?.error);
    })
    .catch((err) => console.error('[Strategy2LiveEngine] auto-start error:', err.message));
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});

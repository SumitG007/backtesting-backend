require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { startTokenAutoRenewJob } = require('./services/tokenService');
const { bootEngineFromDb } = require('./services/liveTradingEngine');
const { bootEngineFromDb: bootShortStraddleEngineFromDb } = require('./services/liveShortStraddleEngine');

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI missing in backend .env');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');
  startTokenAutoRenewJob();
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
  // Always-on live paper trading engines on NIFTY.
  bootEngineFromDb({ symbol: 'NIFTY' })
    .then((result) => {
      if (result?.ok) console.log('[Strategy1LiveEngine] auto-started for NIFTY');
      else console.warn('[Strategy1LiveEngine] auto-start skipped:', result?.error);
    })
    .catch((err) => console.error('[Strategy1LiveEngine] auto-start error:', err.message));
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

require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { startTokenAutoRenewJob } = require('./services/tokenService');
const { bootEngineFromDb } = require('./services/liveTradingEngine');

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
  // Always-on live paper trading engine (Strategy 2 on NIFTY).
  bootEngineFromDb({ symbol: 'NIFTY' })
    .then((result) => {
      if (result?.ok) console.log('[LiveEngine] auto-started for NIFTY');
      else console.warn('[LiveEngine] auto-start skipped:', result?.error);
    })
    .catch((err) => console.error('[LiveEngine] auto-start error:', err.message));
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});

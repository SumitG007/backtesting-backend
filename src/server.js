require('dotenv').config();
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { startTokenAutoRenewJob } = require('./services/tokenService');

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
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});

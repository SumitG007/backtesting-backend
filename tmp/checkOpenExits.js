require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const T = require('../src/models/livePaperTrade');
  const open = await T.findOne({
    strategyKey: 'strategy13_oi_universe_live',
    exitTime: null,
    status: { $ne: 'CLOSED' },
  })
    .sort({ entryTime: -1 })
    .lean();
  console.log(
    'DB',
    JSON.stringify(
      open
        ? {
            symbol: open.symbol,
            entry: open.entryPremium,
            target: open.targetPremium,
            sl: open.stopLossPremium,
            notes: String(open.notes || '').slice(-160),
          }
        : null,
      null,
      2,
    ),
  );
  const login = await axios.post('http://127.0.0.1:3001/api/auth/login', {
    email: process.env.ADMIN || process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  const s = await axios.get('http://127.0.0.1:3001/api/live/strategy-11/status', {
    headers: { Authorization: `Bearer ${login.data.token}` },
    timeout: 20000,
  });
  const e = s.data.engine || {};
  console.log(
    'API',
    JSON.stringify(
      {
        settings: {
          ti: e.settings?.targetPointsIndex,
          si: e.settings?.stopLossPointsIndex,
          ts: e.settings?.targetPointsStock,
          ss: e.settings?.stopLossPointsStock,
        },
        open: s.data.openTrade
          ? {
              symbol: s.data.openTrade.symbol,
              entry: s.data.openTrade.entryPremium,
              target: s.data.openTrade.targetPremium,
              sl: s.data.openTrade.stopLossPremium,
            }
          : null,
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

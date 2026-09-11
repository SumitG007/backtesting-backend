/**
 * Reset OI Flow E/B paper book + force scalp settings (+5/−5 · day +5/−10).
 * Usage: node scripts/resetOiFlowEbScalp.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');

const STRATEGY_KEY = 'oi_flow_eb_live';
const WALLET_KEY = 'paper_live_oi_flow_eb';
const STRATEGY_ID = 'oi-flow-eb';

const SCALP_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:45',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  stepMin: 15,
  callMinSpotDelta: 5,
  optionSlPts: 5,
  optionTpPts: 5,
  dailyTarget: 5,
  dailyLoss: 10,
  perTradeCost: 100,
};

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI / MONGO_URI missing in .env');
  await mongoose.connect(uri);

  const tradeFilter = {
    $or: [
      { strategyKey: STRATEGY_KEY },
      { strategyId: STRATEGY_ID },
      { notes: /oi_flow_eb/i },
    ],
  };

  const tradeCount = await LivePaperTrade.countDocuments(tradeFilter);
  const tradeRes = await LivePaperTrade.deleteMany(tradeFilter);

  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      cashLedger: false,
      wins: 0,
      losses: 0,
      totalTrades: 0,
      oiFlowEbEngineSettings: { ...SCALP_SETTINGS },
    });
  } else {
    wallet.startingBalance = 0;
    wallet.balance = 0;
    wallet.realizedPnl = 0;
    wallet.wins = 0;
    wallet.losses = 0;
    wallet.totalTrades = 0;
    wallet.oiFlowEbEngineSettings = { ...SCALP_SETTINGS };
    await wallet.save();
  }

  console.log(
    JSON.stringify(
      {
        tradesMatched: tradeCount,
        tradesDeleted: tradeRes.deletedCount,
        walletKey: WALLET_KEY,
        settings: wallet.oiFlowEbEngineSettings,
        realizedPnl: wallet.realizedPnl,
        totalTrades: wallet.totalTrades,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const mongoose = require('mongoose');

const liveWalletSchema = new mongoose.Schema(
  {
    walletKey: { type: String, default: 'default', unique: true, index: true },
    startingBalance: { type: Number, required: true, default: 0 },
    balance: { type: Number, required: true, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    lastResetAt: { type: Date, default: null },
    engineSettings: {
      lotCount: { type: Number, default: 1 },
      premiumStopLossCapPct: { type: Number, default: 3 },
      targetPct: { type: Number, default: 12 },
      maxTradesPerDay: { type: Number, default: 2 },
      perTradeCost: { type: Number, default: 100 },
      entryFromTime: { type: String, default: '09:30' },
      entryToTime: { type: String, default: '14:00' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.LiveWallet || mongoose.model('LiveWallet', liveWalletSchema);

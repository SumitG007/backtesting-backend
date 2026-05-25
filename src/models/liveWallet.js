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
      targetProfitPct: { type: Number, default: 5 },
      stopLossPct: { type: Number, default: 30 },
      premiumLeverage: { type: Number, default: 8 },
      minRefRangePct: { type: Number, default: 0.15 },
      maxTradesPerDay: { type: Number, default: 2 },
      perTradeCost: { type: Number, default: 100 },
      entryFromTime: { type: String, default: '09:30' },
      entryToTime: { type: String, default: '14:00' },
    },
    strategy2EngineSettings: {
      lotCount: { type: Number, default: 1 },
      targetPct: { type: Number, default: null },
      stopLossPct: { type: Number, default: null },
      entryTime: { type: String, default: '09:30' },
      entryWindowMinutes: { type: Number, default: 5 },
      dayCloseTime: { type: String, default: '09:20' },
      skipExpiryDay: { type: Boolean, default: true },
      perTradeCost: { type: Number, default: 100 },
    },
    strategy3EngineSettings: {
      lotCount: { type: Number, default: 1 },
      perTradeCost: { type: Number, default: 100 },
      ivLookbackDays: { type: Number, default: 20 },
      ivSpikeMultiplier: { type: Number, default: 1.15 },
      maxSpikeMultiplier: { type: Number, default: 2.5 },
      minOrHistoryDays: { type: Number, default: 3 },
      entryToTime: { type: String, default: '12:00' },
      spikeMode: { type: String, default: 'either' },
      orPercentileMin: { type: Number, default: 65 },
      targetVolCrushPct: { type: Number, default: null },
      stopVolExpandPct: { type: Number, default: null },
      ivExpandStopMult: { type: Number, default: 1.5 },
      skipExpiryDay: { type: Boolean, default: true },
    },
    strategy3OrHistory: {
      type: [{ dateKey: String, orIv: Number }],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.LiveWallet || mongoose.model('LiveWallet', liveWalletSchema);

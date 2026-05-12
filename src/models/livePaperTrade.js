const mongoose = require('mongoose');

const livePaperTradeSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true, default: 'strategy2_confirmation_breakout' },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['LONG', 'SHORT', 'SELL'], required: true },
    optionType: { type: String, enum: ['CE', 'PE', 'STRADDLE'], required: true },
    strike: { type: Number, required: true },
    expiryDate: { type: String, default: null },
    lotSize: { type: Number, required: true },
    lots: { type: Number, required: true, default: 1 },
    qty: { type: Number, required: true },
    entryPremium: { type: Number, required: true },
    entrySpot: { type: Number, required: true },
    entryTime: { type: Date, required: true },
    stopLossPremium: { type: Number, default: null },
    targetPremium: { type: Number, default: null },
    entryCredit: { type: Number, default: null },
    exitDebit: { type: Number, default: null },
    legs: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    entryDateKey: { type: String, default: null, index: true },
    exitDateKey: { type: String, default: null, index: true },
    refHigh: { type: Number, default: null },
    targetSpot: { type: Number, default: null },
    combinedStopSpot: { type: Number, default: null },
    exitPremium: { type: Number, default: null },
    exitSpot: { type: Number, default: null },
    exitTime: { type: Date, default: null },
    reason: { type: String, default: null },
    investedAmount: { type: Number, required: true },
    finalValue: { type: Number, default: null },
    charges: { type: Number, default: 100 },
    pnl: { type: Number, default: null },
    pnlPct: { type: Number, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true }
);

livePaperTradeSchema.index({ entryTime: -1 });

module.exports =
  mongoose.models.LivePaperTrade || mongoose.model('LivePaperTrade', livePaperTradeSchema);

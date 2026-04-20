const mongoose = require('mongoose');

const strategyTradeSchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    strategyKey: { type: String, required: true, index: true },
    pair: String,
    type: String,
    strike: Number,
    buyPrice: Number,
    sellPrice: Number,
    lots: Number,
    invested: Number,
    finalValue: Number,
    closed: String,
    order: String,
    entryTime: Date,
    exitTime: Date,
    entryPrice: Number,
    exitPrice: Number,
    stopLoss: Number,
    target: Number,
    qty: Number,
    premium: Number,
    lotCount: Number,
    lotSize: Number,
    investmentAmount: Number,
    stopLossAmount: Number,
    targetAmount: Number,
    pnl: Number,
    pnlPct: Number,
    reason: String,
  },
  { timestamps: true }
);

module.exports = mongoose.models.StrategyTrade || mongoose.model('StrategyTrade', strategyTradeSchema);

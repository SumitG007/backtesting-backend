const mongoose = require('mongoose');

const manualTradeActionSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    tradeId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    symbol: { type: String, default: null },
    message: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

manualTradeActionSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.ManualTradeAction
  || mongoose.model('ManualTradeAction', manualTradeActionSchema);

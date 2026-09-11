const mongoose = require('mongoose');

/**
 * Rolling option LTP buffer for OI Flow paper trades.
 * Used for fair entry/exit prints and missed SL/TP catch-up.
 */
const oiFlowOptionTickSchema = new mongoose.Schema(
  {
    tradeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    strategyKey: { type: String, required: true, index: true },
    symbol: { type: String, required: true },
    optionType: { type: String, enum: ['CE', 'PE'], required: true },
    strike: { type: Number, required: true },
    expiryDate: { type: String, default: null },
    securityId: { type: String, default: null },
    ltp: { type: Number, required: true },
    spot: { type: Number, default: null },
    source: { type: String, default: null },
    at: { type: Date, required: true },
    dateKey: { type: String, required: true, index: true },
  },
  { timestamps: true },
);

oiFlowOptionTickSchema.index({ tradeId: 1, at: -1 });
oiFlowOptionTickSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 12 }); // 12h TTL

module.exports =
  mongoose.models.OiFlowOptionTick || mongoose.model('OiFlowOptionTick', oiFlowOptionTickSchema);

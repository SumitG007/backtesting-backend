const mongoose = require('mongoose');

const manualPendingOrderSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    symbol: { type: String, required: true },
    optionType: { type: String, enum: ['CE', 'PE', 'FUT'], required: true },
    /** OPTION (CE/PE long buy) or FUTURE (direct future, LONG/SHORT). */
    product: { type: String, enum: ['OPTION', 'FUTURE'], default: 'OPTION' },
    side: { type: String, enum: ['LONG', 'SHORT'], default: 'LONG' },
    strike: { type: Number, required: true },
    expiryDate: { type: String, required: true },
    orderType: { type: String, enum: ['MARKET', 'LIMIT'], default: 'MARKET' },
    /** Fill when option LTP <= limitPremium (long buy). */
    limitPremium: { type: Number, default: null },
    lots: { type: Number, required: true, default: 1 },
    lotSize: { type: Number, required: true },
    perTradeCost: { type: Number, default: 100 },
    stopLossPoints: { type: Number, default: null },
    targetProfitPoints: { type: Number, default: null },
    /** Risk input mode: PCT, POINTS (exact premium), or AMOUNT (₹ gross P/L). SL & Target share one mode. */
    stopLossMode: { type: String, enum: ['PCT', 'POINTS', 'AMOUNT'], default: null },
    targetMode: { type: String, enum: ['PCT', 'POINTS', 'AMOUNT'], default: null },
    stopLossAmount: { type: Number, default: null },
    targetAmount: { type: Number, default: null },
    stopLossPct: { type: Number, default: null },
    targetPct: { type: Number, default: null },
    status: {
      type: String,
      enum: ['PENDING', 'FILLED', 'CANCELLED', 'EXPIRED'],
      default: 'PENDING',
      index: true,
    },
    tradeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    cancelReason: { type: String, default: null },
    filledAt: { type: Date, default: null },
    sessionDateKey: { type: String, index: true },
    /** Paper cash held when a LIMIT order is placed (released on cancel / adjusted on fill). */
    heldAmount: { type: Number, default: null },
    /** Testing paper fill — not counted in main P/L / calendar. */
    isTesting: { type: Boolean, default: false },
  },
  { timestamps: true },
);

manualPendingOrderSchema.index({ strategyKey: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.ManualPendingOrder
  || mongoose.model('ManualPendingOrder', manualPendingOrderSchema);

const mongoose = require('mongoose');

const livePaperTradeSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['LONG', 'SHORT', 'SELL'], required: true },
    optionType: { type: String, enum: ['CE', 'PE', 'STRADDLE', 'FUT'], required: true },
    /** OPTION (CE/PE) or FUTURE (direct stock/index future). */
    product: { type: String, enum: ['OPTION', 'FUTURE'], default: 'OPTION' },
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
    /** How SL/target were entered: PCT (% of entry) or POINTS (exact absolute premium/price). Shared unit. */
    stopLossMode: { type: String, enum: ['PCT', 'POINTS'], default: null },
    targetMode: { type: String, enum: ['PCT', 'POINTS'], default: null },
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
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    reason: { type: String, default: null },
    /** Short human reason for why the entry was taken (scalp / signals). */
    entryReason: { type: String, default: null },
    investedAmount: { type: Number, required: true },
    creditReceived: { type: Number, default: null },
    finalValue: { type: Number, default: null },
    charges: { type: Number, default: 100 },
    pnl: { type: Number, default: null },
    pnlPct: { type: Number, default: null },
    notes: { type: String, default: null },
    entryIvProxy: { type: Number, default: null },
    medianIvProxy: { type: Number, default: null },
    highSinceEntry: { type: Number, default: null },
    lowSinceEntry: { type: Number, default: null },
    /** Latest open MTM snapshot (refreshed ~every 6s while position is open). */
    openPositionMark: { type: mongoose.Schema.Types.Mixed, default: null },
    openPositionMarkAt: { type: Date, default: null },
  },
  { timestamps: true }
);

livePaperTradeSchema.index({ entryTime: -1 });
livePaperTradeSchema.index({ strategyKey: 1, exitTime: 1 });
// At most one open paper trade per auto-strategy; manual console allows multiple opens.
livePaperTradeSchema.index(
  { strategyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      exitTime: null,
      strategyKey: { $ne: 'manual_console_live' },
    },
  },
);

module.exports =
  mongoose.models.LivePaperTrade || mongoose.model('LivePaperTrade', livePaperTradeSchema);

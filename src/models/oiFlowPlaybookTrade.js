const mongoose = require('mongoose');

/**
 * OI Flow 15m E/B playbook trades — open + closed day book.
 * Survives minute-row wipe for history.
 */
const oiFlowPlaybookTradeSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true, index: true },
    entryMinutes: { type: Number, required: true },
    entryTime: { type: String, required: true },
    exitMinutes: { type: Number, default: null },
    exitTime: { type: String, default: null },
    decision: { type: String, enum: ['CALL BUY', 'PUT BUY'], required: true },
    side: { type: String, enum: ['CALL', 'PUT'], required: true },
    tone: { type: String, enum: ['call', 'put'], required: true },
    patternId: { type: String, default: null },
    patternName: { type: String, default: null },
    shortName: { type: String, default: null },
    strength: { type: String, default: null },
    spotDelta: { type: Number, default: null },
    act: { type: String, default: null },
    entrySpot: { type: Number, required: true },
    exitSpot: { type: Number, default: null },
    markSpot: { type: Number, default: null },
    candleHigh: { type: Number, default: null },
    candleLow: { type: Number, default: null },
    candleRange: { type: Number, default: null },
    rawRisk: { type: Number, default: null },
    riskPts: { type: Number, required: true },
    rewardPts: { type: Number, required: true },
    stopSpot: { type: Number, required: true },
    targetSpot: { type: Number, required: true },
    clamped: { type: Boolean, default: false },
    favorPts: { type: Number, default: 0 },
    mae: { type: Number, default: null },
    mfe: { type: Number, default: null },
    holdMin: { type: Number, default: 0 },
    tpLeft: { type: Number, default: null },
    slLeft: { type: Number, default: null },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    exitReason: {
      type: String,
      enum: ['OPEN', 'TP', 'SL', 'TIME', 'EOD', 'DAY_STOP'],
      default: 'OPEN',
    },
    dayPtsAfter: { type: Number, default: null },
    dayStopReason: { type: String, default: null },
    source: { type: String, enum: ['live', 'backfill'], default: 'live' },
  },
  { timestamps: true },
);

oiFlowPlaybookTradeSchema.index(
  { symbol: 1, dateKey: 1, entryMinutes: 1, decision: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.OiFlowPlaybookTrade
  || mongoose.model('OiFlowPlaybookTrade', oiFlowPlaybookTradeSchema);

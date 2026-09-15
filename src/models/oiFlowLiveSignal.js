const mongoose = require('mongoose');

/**
 * One live OI-Flow signal = one paper trade the engine actually took.
 * Frozen at entry (past + current bar only). Exit/accuracy updated live.
 * Survives minute-row day wipe so calendar history still works.
 */
const tfSchema = {
  label: { type: String, default: '—' },
  tone: { type: String, default: 'flat' },
};

const oiFlowLiveSignalSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true, index: true },
    minutes: { type: Number, required: true },
    time: { type: String, required: true },
    decision: { type: String, enum: ['PUT BUY', 'CALL BUY'], required: true },
    tone: { type: String, enum: ['put', 'call'], required: true },
    optionType: { type: String, enum: ['CE', 'PE'], default: null },
    strike: { type: Number, default: null },
    strikeLabel: { type: String, default: null },
    control: { type: String, default: null },
    spot: { type: Number, default: null },
    callChg: { type: Number, default: null },
    putChg: { type: Number, default: null },
    callOiL: { type: String, default: null },
    putOiL: { type: String, default: null },
    callAct: { type: String, default: null },
    putAct: { type: String, default: null },
    quality: {
      text: { type: String, default: '' },
      tone: { type: String, default: 'flat' },
    },
    tf15: tfSchema,
    tf5: tfSchema,
    tf3: tfSchema,
    tf1: tfSchema,
    spot15: { type: Number, default: null },
    tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'LivePaperTrade', index: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    entryPremium: { type: Number, default: null },
    exitPremium: { type: Number, default: null },
    favorPts: { type: Number, default: null },
    hold: { type: Number, default: null },
    exitMinutes: { type: Number, default: null },
    exitTime: { type: String, default: null },
    exitReason: { type: String, default: 'OPEN' },
    grade: { type: String, default: 'Pending' },
    tpLeft: { type: Number, default: null },
    slLeft: { type: Number, default: null },
    targetPoints: { type: Number, default: 10 },
    stopLossPoints: { type: Number, default: 8 },
  },
  { timestamps: true },
);

oiFlowLiveSignalSchema.index({ dateKey: 1, minutes: 1, decision: 1 }, { unique: true });
oiFlowLiveSignalSchema.index({ symbol: 1, dateKey: 1, minutes: 1 });

module.exports =
  mongoose.models.OiFlowLiveSignal || mongoose.model('OiFlowLiveSignal', oiFlowLiveSignalSchema);

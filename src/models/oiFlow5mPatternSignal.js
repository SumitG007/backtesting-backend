const mongoose = require('mongoose');

/**
 * Closed 5m OI Flow CALL BUY / PUT BUY pattern signals.
 * Survives minute-row day wipe so morning→now history stays available.
 */
const oiFlow5mPatternSignalSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true, index: true },
    minutes: { type: Number, required: true },
    time: { type: String, required: true },
    decision: { type: String, enum: ['CALL BUY', 'PUT BUY'], required: true },
    tone: { type: String, enum: ['call', 'put'], required: true },
    patternId: { type: String, required: true },
    patternName: { type: String, required: true },
    shortName: { type: String, default: null },
    spot: { type: Number, default: null },
    spotDelta: { type: Number, default: null },
    atm: { type: Number, default: null },
    strength: { type: String, default: null },
    strengthScore: { type: Number, default: null },
    streak: { type: Number, default: null },
    act: { type: String, default: null },
    flowBias: { type: String, default: null },
    callAct: { type: String, default: null },
    putAct: { type: String, default: null },
    source: {
      type: String,
      enum: ['live', 'backfill'],
      default: 'live',
    },
  },
  { timestamps: true },
);

oiFlow5mPatternSignalSchema.index(
  { symbol: 1, dateKey: 1, minutes: 1 },
  { unique: true },
);
oiFlow5mPatternSignalSchema.index({ dateKey: 1, decision: 1 });

module.exports =
  mongoose.models.OiFlow5mPatternSignal
  || mongoose.model('OiFlow5mPatternSignal', oiFlow5mPatternSignalSchema);

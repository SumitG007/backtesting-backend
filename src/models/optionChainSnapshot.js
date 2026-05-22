const mongoose = require('mongoose');

const greeksSchema = new mongoose.Schema(
  {
    delta: Number,
    theta: Number,
    gamma: Number,
    vega: Number,
  },
  { _id: false }
);

const optionLegSchema = new mongoose.Schema(
  {
    average_price: Number,
    implied_volatility: Number,
    last_price: Number,
    oi: Number,
    oi_change: Number,
    previous_close_price: Number,
    previous_oi: Number,
    previous_volume: Number,
    security_id: Number,
    top_ask_price: Number,
    top_ask_quantity: Number,
    top_bid_price: Number,
    top_bid_quantity: Number,
    volume: Number,
    greeks: greeksSchema,
  },
  { _id: false }
);

const strikeRowSchema = new mongoose.Schema(
  {
    strike: { type: Number, required: true },
    ce: optionLegSchema,
    pe: optionLegSchema,
  },
  { _id: false }
);

const optionChainSnapshotSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, index: true },
    expiry: { type: String, required: true, index: true },
    capturedAt: { type: Date, required: true, index: true },
    dateKey: { type: String, required: true, index: true },
    spot: Number,
    strikeCount: Number,
    strikes: [strikeRowSchema],
    rawOc: { type: mongoose.Schema.Types.Mixed },
    source: { type: String, default: 'dhan-optionchain' },
    recorderRunId: String,
  },
  { timestamps: true }
);

optionChainSnapshotSchema.index({ symbol: 1, expiry: 1, capturedAt: -1 });
optionChainSnapshotSchema.index({ symbol: 1, expiry: 1, dateKey: 1, capturedAt: -1 });

const OptionChainSnapshot = mongoose.models.OptionChainSnapshot
  || mongoose.model('OptionChainSnapshot', optionChainSnapshotSchema);

async function ensureOptionChainIndexes() {
  await OptionChainSnapshot.syncIndexes();
  return OptionChainSnapshot;
}

module.exports = OptionChainSnapshot;
module.exports.ensureOptionChainIndexes = ensureOptionChainIndexes;

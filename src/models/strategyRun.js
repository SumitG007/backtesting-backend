const mongoose = require('mongoose');

const strategyRunSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    interval: { type: String, required: true },
    year: { type: Number, required: true },
    settings: { type: Object, required: true },
    summary: { type: Object, required: true },
    status: { type: String, default: 'completed' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.StrategyRun || mongoose.model('StrategyRun', strategyRunSchema);

const mongoose = require('mongoose');

/**
 * Day-end OI Flow tape archive — one JSON payload per IST trading date.
 * Survives live-minute purge (today-only minute rows).
 */
const oiFlowDayArchiveSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true, index: true },
    /** Candle interval used to build `payload.rows` (always 1m archive). */
    intervalMin: { type: Number, default: 1 },
    rowCount: { type: Number, default: 0 },
    sourceMinuteCount: { type: Number, default: 0 },
    byteSize: { type: Number, default: 0 },
    archivedAt: { type: Date, default: Date.now },
    /** Compact candle JSON (same shape as former export). */
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

oiFlowDayArchiveSchema.index({ symbol: 1, dateKey: 1, intervalMin: 1 }, { unique: true });

module.exports = mongoose.model('OiFlowDayArchive', oiFlowDayArchiveSchema);

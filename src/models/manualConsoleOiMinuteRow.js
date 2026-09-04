const mongoose = require('mongoose');

/**
 * Manual Console — own OI minute tape collection (separate from OI Flow Tracker).
 * Seeded/mirrored from the live chain capture so this desk can diverge later
 * without touching OiFlowMinuteRow / /api/oi-flow/*.
 */
const manualConsoleOiMinuteRowSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true },
    minutes: { type: Number, required: true },
    time: { type: String, required: true },
    spotPrice: { type: Number, default: null },
    atm: { type: Number, default: null },
    lookaroundStrikes: { type: Number, default: 3 },
    callOiTotal: { type: Number, default: null },
    putOiTotal: { type: Number, default: null },
    dayCallChgOi: { type: Number, default: null },
    dayPutChgOi: { type: Number, default: null },
    callsChgOi: { type: Number, default: null },
    putsChgOi: { type: Number, default: null },
    strikes: {
      type: [
        {
          _id: false,
          strike: { type: Number },
          callOi: { type: Number, default: null },
          putOi: { type: Number, default: null },
          callChgOi: { type: Number, default: null },
          putChgOi: { type: Number, default: null },
        },
      ],
      default: undefined,
    },
    diffInOi: { type: Number, default: null },
    dirOfChng: { type: String, default: null },
    chngInDir: { type: Number, default: null },
    sentiment: { type: String, default: null },
    expiry: { type: String, default: null },
    fetchOk: { type: Boolean, default: true },
    error: { type: String, default: null },
    fetchedAt: { type: Date, default: Date.now },
    /** Provenance — tracker mirror vs future dedicated capture. */
    source: { type: String, default: 'oi_flow_mirror' },
  },
  { timestamps: true, collection: 'manual_console_oi_minute_rows' },
);

manualConsoleOiMinuteRowSchema.index({ symbol: 1, dateKey: 1, minutes: 1 }, { unique: true });

module.exports =
  mongoose.models.ManualConsoleOiMinuteRow
  || mongoose.model('ManualConsoleOiMinuteRow', manualConsoleOiMinuteRowSchema);

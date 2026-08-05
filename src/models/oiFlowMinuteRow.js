const mongoose = require('mongoose');

/**
 * One OI-flow snapshot per IST minute for the current trading day only (LOCKED).
 * Engine deletes older dateKeys when a new session day starts.
 *
 * callOiTotal / putOiTotal = ATM ± 3 strikes OI
 * callsChgOi / putsChgOi   = vs previous 1-minute DB row
 * chngInDir                = Puts chng − Calls chng
 * diffInOi                 = Puts total − Calls total (+ when Puts more)
 * dirOfChng                = up | down | flat from chngInDir
 */
const oiFlowMinuteRowSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true },
    /** Minutes from midnight IST (09:15 = 555 … 15:30 = 930). */
    minutes: { type: Number, required: true },
    time: { type: String, required: true },
    spotPrice: { type: Number, default: null },
    atm: { type: Number, default: null },
    lookaroundStrikes: { type: Number, default: 3 },
    /** Absolute Call / Put OI for ATM ± lookaround strikes. */
    callOiTotal: { type: Number, default: null },
    putOiTotal: { type: Number, default: null },
    /** Day-so-far Call / Put ΔOI from Dhan (reference only). */
    dayCallChgOi: { type: Number, default: null },
    dayPutChgOi: { type: Number, default: null },
    /** Vs previous 1-minute entry. */
    callsChgOi: { type: Number, default: null },
    putsChgOi: { type: Number, default: null },
    /** Puts total − Calls total */
    diffInOi: { type: Number, default: null },
    /** up | down | flat from chngInDir */
    dirOfChng: { type: String, default: null },
    /** Puts chng − Calls chng */
    chngInDir: { type: Number, default: null },
    /** Bull | Bear | Neutral */
    sentiment: { type: String, default: null },
    expiry: { type: String, default: null },
    fetchOk: { type: Boolean, default: true },
    error: { type: String, default: null },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

oiFlowMinuteRowSchema.index({ symbol: 1, dateKey: 1, minutes: 1 }, { unique: true });

module.exports = mongoose.model('OiFlowMinuteRow', oiFlowMinuteRowSchema);

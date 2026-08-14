const mongoose = require('mongoose');

/**
 * One OI-flow snapshot per IST minute for the current trading day only (LOCKED).
 * Engine deletes older dateKeys when a new session day starts.
 *
 * Focus = Change in OI (ΔOI), not absolute standing OI.
 * dayCallChgOi / dayPutChgOi = ATM ± 3 day-so-far ΔOI (our "total OI")
 * callsChgOi / putsChgOi     = interval ΔOI on overlapping strikes only
 * chngInDir                  = Puts chng − Calls chng
 * diffInOi                   = day Put Δ − day Call Δ (+ when Puts building more)
 * callOiTotal / putOiTotal   = absolute OI (reference only)
 * dirOfChng                  = up | down | flat from chngInDir
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
    /** Absolute Call / Put OI for ATM ± lookaround (reference only). */
    callOiTotal: { type: Number, default: null },
    putOiTotal: { type: Number, default: null },
    /** Day-so-far Call / Put ΔOI — our "total OI" for decisions. */
    dayCallChgOi: { type: Number, default: null },
    dayPutChgOi: { type: Number, default: null },
    /** Vs previous 1-minute entry, overlapping ATM-window strikes only. */
    callsChgOi: { type: Number, default: null },
    putsChgOi: { type: Number, default: null },
    /** ATM ± lookaround strike snapshot used for overlap ΔOI. */
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
    /** Day Put Δ − day Call Δ */
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

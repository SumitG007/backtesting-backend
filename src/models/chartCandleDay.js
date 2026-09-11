const mongoose = require('mongoose');

/**
 * One IST trading day's intraday candles (e.g. NIFTY 5m).
 * Liquidity OI Chase chart keeps the current day + last 6 trading days (7 total).
 * Candles: [iso, open, high, low, close, volume]
 */
const chartCandleDaySchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, default: 'NIFTY', index: true },
    interval: { type: String, required: true, default: '5' },
    dateKey: { type: String, required: true },
    candles: {
      type: mongoose.Schema.Types.Mixed,
      default: [],
    },
    barCount: { type: Number, default: 0 },
    source: { type: String, default: 'dhan' },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

chartCandleDaySchema.index({ symbol: 1, interval: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('ChartCandleDay', chartCandleDaySchema);

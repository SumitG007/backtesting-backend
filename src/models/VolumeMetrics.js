const mongoose = require('mongoose');

const priorDaySchema = new mongoose.Schema(
  {
    dateKey: String,
    dayLabel: String,
    volume: Number,
  },
  { _id: false },
);

const volumeMetricsSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, trim: true },
    product: { type: String, required: true, enum: ['cash', 'future'] },
    expiryDate: { type: String, default: '' },
    lookbackDays: { type: Number, required: true },
    ok: { type: Boolean, default: false },
    cashSupported: { type: Boolean, default: false },
    futureSupported: { type: Boolean, default: false },
    avgVolume: { type: Number, default: null },
    todayVolume: { type: Number, default: null },
    ratio: { type: Number, default: null },
    pctVsAvg: { type: Number, default: null },
    signal: { type: String, default: 'UNAVAILABLE' },
    sampleDays: { type: Number, default: 0 },
    todayDate: { type: String, default: '' },
    partialToday: { type: Boolean, default: false },
    priorDays: { type: [priorDaySchema], default: [] },
    prevDayClose: { type: Number, default: null },
    todayPrice: { type: Number, default: null },
    priceChangePct: { type: Number, default: null },
    prevDayDate: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

volumeMetricsSchema.index(
  { symbol: 1, product: 1, expiryDate: 1, lookbackDays: 1 },
  { unique: true },
);
volumeMetricsSchema.index({ product: 1, expiryDate: 1, lookbackDays: 1, pctVsAvg: -1 });
volumeMetricsSchema.index({ product: 1, expiryDate: 1, lookbackDays: 1, updatedAt: -1 });

module.exports = mongoose.models.VolumeMetrics
  || mongoose.model('VolumeMetrics', volumeMetricsSchema);

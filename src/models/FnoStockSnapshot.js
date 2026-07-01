const mongoose = require('mongoose');

const fnoStockSnapshotSchema = new mongoose.Schema(
  {
    instrumentType: { type: String, enum: ['OPTSTK', 'FUTSTK'], required: true },
    dateKey: { type: String, required: true },
    symbols: { type: [String], default: [] },
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);

fnoStockSnapshotSchema.index({ instrumentType: 1, dateKey: 1 }, { unique: true });
fnoStockSnapshotSchema.index({ instrumentType: 1, dateKey: -1 });

module.exports = mongoose.model('FnoStockSnapshot', fnoStockSnapshotSchema);

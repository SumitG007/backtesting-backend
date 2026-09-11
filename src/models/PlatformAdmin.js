const mongoose = require('mongoose');

const platformAdminSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    /** Email copied from .env on last sync (for display / audit). */
    envEmail: { type: String, default: '' },
    lastSyncedFromEnvAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.PlatformAdmin || mongoose.model('PlatformAdmin', platformAdminSchema);

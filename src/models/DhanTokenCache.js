const mongoose = require('mongoose');

const dhanTokenCacheSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'singleton', unique: true },
    accessToken: { type: String, required: true },
    /** Set on seed / env bootstrap; used for RenewToken + API headers when present. */
    dhanClientId: { type: String, default: '' },
    /** From Dhan RenewToken response (server-side validity window). */
    renewCreateTime: { type: Date, default: null },
    renewExpiryTime: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DhanTokenCache', dhanTokenCacheSchema);

const path = require('path');

const PORT = process.env.PORT || 3001;
const BACKEND_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
const TOKEN_RENEW_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

const PRESET_SYMBOLS = {
  NIFTY: { securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  BANKNIFTY: { securityId: '25', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  RELIANCE: { securityId: '2885', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HDFCBANK: { securityId: '1333', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ICICIBANK: { securityId: '4963', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
};

const DEFAULT_LOT_SIZES = {
  NIFTY: 50,
  BANKNIFTY: 65,
};

module.exports = {
  PORT,
  BACKEND_ENV_PATH,
  TOKEN_RENEW_INTERVAL_MS,
  CACHE_TTL_MS,
  PRESET_SYMBOLS,
  DEFAULT_LOT_SIZES,
};

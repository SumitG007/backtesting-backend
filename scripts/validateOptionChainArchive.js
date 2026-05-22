/**
 * Offline checks for option-chain archive (no Dhan API call).
 * Run: node scripts/validateOptionChainArchive.js
 */
require('dotenv').config();
const { PRESET_SYMBOLS } = require('../src/config/constants');
const {
  validateArchiveSetup,
  unwrapDhanChainPayload,
  flattenOptionChain,
  DEFAULT_ARCHIVE_EXPIRIES,
} = require('../src/services/optionChainArchiveService');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

validateArchiveSetup();

const nifty = PRESET_SYMBOLS.NIFTY;
assert(nifty.securityId === '13', 'NIFTY securityId must be 13 per Dhan instrument master');
assert(nifty.exchangeSegment === 'IDX_I', 'NIFTY segment must be IDX_I for option chain API');

const sample = unwrapDhanChainPayload({
  data: {
    last_price: 25642.8,
    oc: {
      '25650': {
        ce: { last_price: 134, oi: 100, previous_oi: 90, volume: 1, greeks: { delta: 0.5 } },
        pe: { last_price: 132, oi: 200, previous_oi: 180, volume: 2, greeks: { delta: -0.4 } },
      },
    },
  },
});
const flat = flattenOptionChain(sample);
assert(flat.strikes.length === 1, 'flatten should parse nested data.oc');
assert(flat.strikes[0].ce.oi_change === 10, 'oi_change = oi - previous_oi');
assert(flat.spot === 25642.8, 'spot from last_price');

console.log('OK — option chain archive config matches Dhan API shape');
console.log('  Expiries:', DEFAULT_ARCHIVE_EXPIRIES.join(', '));
console.log('  NIFTY:', nifty.securityId, nifty.exchangeSegment);

/**
 * Sanity-check Strategy 6 P/L direction (PE must gain when index falls).
 */
const { getOptionPremiumFromSpotMove } = require('../src/utils/market');
const { premiumSideForLongOption } = require('../src/strategies/shared/intradayOptions');
const { runRisingWedgeBacktest } = require('../src/strategies/strategy6/risingWedgeBacktest');
const { getProductionSettings } = require('../src/strategies/strategy6/scenarios');

const entrySpot = 24000;
const entryPremium = 120;
const strike = 24000;

function prem(optionType, spot) {
  return getOptionPremiumFromSpotMove({
    side: premiumSideForLongOption(optionType),
    entrySpot,
    currentSpot: spot,
    entryPremium,
    premiumLeverage: 8,
    strike,
    strikeStep: 100,
  });
}

console.log('=== Premium direction check ===');
console.log('CE spot 24000→24100:', prem('CE', 24100), '(should rise)');
console.log('CE spot 24000→23900:', prem('CE', 23900), '(should fall)');
console.log('PE spot 24000→23900:', prem('PE', 23900), '(should rise)');
console.log('PE spot 24000→24100:', prem('PE', 24100), '(should fall)');

const ok =
  prem('CE', 24100) > entryPremium &&
  prem('CE', 23900) < entryPremium &&
  prem('PE', 23900) > entryPremium &&
  prem('PE', 24100) < entryPremium;

if (!ok) {
  console.error('FAIL: premium directions incorrect');
  process.exit(1);
}
console.log('PASS: CE/PE premium directions OK\n');

console.log('=== Sample trade (needs API candles for full year) ===');
console.log('Run npm run scenarios:s6 after fix to refresh scenario totals.');

module.exports = { ok };

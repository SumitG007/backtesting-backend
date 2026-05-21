/**
 * Save multi-year candles to scripts/candle-cache/ for offline discovery.
 * Needs Dhan in .env OR running backend: DISCOVERY_API=http://localhost:3001/api
 */
require('dotenv').config();
const { saveCandlesToDisk, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const preferApi = process.argv.includes('--api') || process.env.DISCOVERY_API != null;
const symbol = String(args[0] || 'NIFTY').toUpperCase();
const interval = String(args[1] || '5');

async function main() {
  const out = await saveCandlesToDisk({
    symbol,
    interval,
    years: DEFAULT_YEARS,
    preferApi,
  });
  console.log(`Saved ${out.total} candles → ${out.dir}`);
  console.log(`Years: ${out.savedYears.join(', ')}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

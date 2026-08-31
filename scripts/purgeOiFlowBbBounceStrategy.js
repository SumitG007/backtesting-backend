/**
 * Remove OI Flow BB Bounce strategy data from MongoDB.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');

const STRATEGY_KEY = 'oi_flow_bb_bounce_live';
const WALLET_KEY = 'paper_live_oi_flow_bb';

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI missing');

  await mongoose.connect(uri);

  const tradeResult = await LivePaperTrade.deleteMany({ strategyKey: STRATEGY_KEY });
  console.log(`Deleted ${tradeResult.deletedCount} trade(s) for ${STRATEGY_KEY}`);

  const walletResult = await LiveWallet.deleteMany({ walletKey: WALLET_KEY });
  console.log(`Deleted ${walletResult.deletedCount} wallet doc(s) for ${WALLET_KEY}`);

  const unsetResult = await LiveWallet.updateMany(
    {},
    { $unset: { oiFlowBbBounceEngineSettings: '' } },
  );
  console.log(`Cleared oiFlowBbBounceEngineSettings from ${unsetResult.modifiedCount} wallet doc(s)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

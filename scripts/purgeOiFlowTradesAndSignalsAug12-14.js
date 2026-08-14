/**
 * Delete OI Flow Tracker paper trades + live signals for 12/13/14 Aug 2026.
 * Does not delete minute OI rows.
 *
 * Usage: node scripts/purgeOiFlowTradesAndSignalsAug12-14.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const OiFlowLiveSignal = require('../src/models/oiFlowLiveSignal');
const OiFlowOptionTick = require('../src/models/oiFlowOptionTick');
const LiveWallet = require('../src/models/liveWallet');
const { OI_FLOW_TRACKER_LIVE_KEY } = require('../src/strategies/keys');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
const WALLET_KEY = 'paper_live_oi_flow';

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
  await mongoose.connect(process.env.MONGODB_URI);

  const trades = await LivePaperTrade.find({
    strategyKey: OI_FLOW_TRACKER_LIVE_KEY,
    $or: [{ entryDateKey: { $in: DATES } }, { exitDateKey: { $in: DATES } }],
  })
    .select({ _id: 1, entryDateKey: 1, status: 1 })
    .lean();
  const tradeIds = trades.map((t) => t._id);

  const sigDel = await OiFlowLiveSignal.deleteMany({
    $or: [{ dateKey: { $in: DATES } }, { tradeId: { $in: tradeIds } }],
  });
  const tickDel = await OiFlowOptionTick.deleteMany({
    $or: [{ dateKey: { $in: DATES } }, { tradeId: { $in: tradeIds } }],
  });
  const tradeDel = await LivePaperTrade.deleteMany({
    strategyKey: OI_FLOW_TRACKER_LIVE_KEY,
    $or: [
      { entryDateKey: { $in: DATES } },
      { exitDateKey: { $in: DATES } },
      { _id: { $in: tradeIds } },
    ],
  });

  const remaining = await LivePaperTrade.find({
    strategyKey: OI_FLOW_TRACKER_LIVE_KEY,
    exitTime: { $ne: null },
  }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of remaining) {
    const p = Number(t.pnl) || 0;
    realizedPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  const wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (wallet) {
    wallet.realizedPnl = Number(realizedPnl.toFixed(2));
    wallet.balance = wallet.realizedPnl;
    wallet.totalTrades = remaining.length;
    wallet.wins = wins;
    wallet.losses = losses;
    await wallet.save();
  }

  const openLeft = await LivePaperTrade.countDocuments({
    strategyKey: OI_FLOW_TRACKER_LIVE_KEY,
    status: 'OPEN',
    exitTime: null,
  });
  const sigLeft = await OiFlowLiveSignal.countDocuments({ dateKey: { $in: DATES } });

  console.log(
    JSON.stringify(
      {
        dates: DATES,
        deleted: {
          trades: tradeDel.deletedCount,
          signals: sigDel.deletedCount,
          optionTicks: tickDel.deletedCount,
        },
        wallet: wallet
          ? {
              realizedPnl: wallet.realizedPnl,
              totalTrades: wallet.totalTrades,
              wins: wallet.wins,
              losses: wallet.losses,
            }
          : null,
        openTradesLeft: openLeft,
        signalsLeftOnThoseDates: sigLeft,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

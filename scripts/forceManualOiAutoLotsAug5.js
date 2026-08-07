require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');

const STRATEGY_KEY = 'manual_oi_auto_live';
const WALLET_KEY = 'paper_live_manual_oi_auto';
const DATE_KEY = '2026-08-05';
const TARGET_LOTS = 10;

async function main() {
  const dry = process.argv.includes('--dry');
  await mongoose.connect(process.env.MONGODB_URI);

  const trades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ entryDateKey: DATE_KEY }, { exitDateKey: DATE_KEY }],
  }).sort({ entryTime: 1 });

  console.log(`Found ${trades.length} trades for ${DATE_KEY} (${dry ? 'DRY RUN' : 'APPLY'})`);

  let oldPnlSum = 0;
  let newPnlSum = 0;

  for (const t of trades) {
    const lotSize = Math.max(1, Number(t.lotSize) || 65);
    const oldLots = Number(t.lots) || 1;
    const oldQty = Number(t.qty) || lotSize * oldLots;
    const entry = Number(t.entryPremium);
    const exit = Number(t.exitPremium);
    const charges = Math.max(0, Number(t.charges) || 0);
    const oldPnl = Number(t.pnl);

    const newQty = lotSize * TARGET_LOTS;
    const investedAmount = Number((entry * newQty).toFixed(2));
    let finalValue = null;
    let pnl = null;
    let pnlPct = null;

    if (t.status === 'CLOSED' && Number.isFinite(exit)) {
      finalValue = Number((exit * newQty).toFixed(2));
      pnl = Number((finalValue - investedAmount - charges).toFixed(2));
      pnlPct = investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    }

    oldPnlSum += Number.isFinite(oldPnl) ? oldPnl : 0;
    newPnlSum += Number.isFinite(pnl) ? pnl : 0;

    console.log(
      [
        String(t._id),
        t.optionType,
        t.strike,
        `lots ${oldLots}->${TARGET_LOTS}`,
        `qty ${oldQty}->${newQty}`,
        `entry ${entry}`,
        `exit ${exit ?? '—'}`,
        `pnl ${oldPnl ?? '—'} -> ${pnl ?? 'OPEN'}`,
      ].join(' | '),
    );

    if (!dry) {
      t.lots = TARGET_LOTS;
      t.qty = newQty;
      t.investedAmount = investedAmount;
      if (finalValue != null) t.finalValue = finalValue;
      if (pnl != null) {
        t.pnl = pnl;
        t.pnlPct = pnlPct;
      }
      t.notes = [t.notes, `lots_forced=${TARGET_LOTS}; qty=${newQty}; recalc=${DATE_KEY}`]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500);
      await t.save();
    }
  }

  if (!dry) {
    // Recalc auto wallet from ALL closed trades (same as engine).
    const wallet =
      (await LiveWallet.findOne({ walletKey: WALLET_KEY })) ||
      (await LiveWallet.create({
        walletKey: WALLET_KEY,
        startingBalance: 0,
        balance: 0,
        realizedPnl: 0,
        cashLedger: false,
      }));

    const closed = await LivePaperTrade.find({
      strategyKey: STRATEGY_KEY,
      exitTime: { $ne: null },
    }).lean();

    let realizedPnl = 0;
    let wins = 0;
    let losses = 0;
    for (const row of closed) {
      const p = Number(row.pnl) || 0;
      realizedPnl += p;
      if (p > 0) wins += 1;
      else if (p < 0) losses += 1;
    }
    wallet.realizedPnl = Number(realizedPnl.toFixed(2));
    wallet.balance = wallet.realizedPnl;
    wallet.totalTrades = closed.length;
    wallet.wins = wins;
    wallet.losses = losses;
    // Keep lotCount default at 10 going forward.
    const settings = {
      ...(wallet.manualOiAutoEngineSettings?.toObject?.() ||
        wallet.manualOiAutoEngineSettings ||
        {}),
      lotCount: 10,
    };
    wallet.manualOiAutoEngineSettings = settings;
    wallet.markModified('manualOiAutoEngineSettings');
    await wallet.save();
    console.log(
      `Wallet updated: realizedPnl=${wallet.realizedPnl} wins=${wins} losses=${losses} trades=${closed.length}`,
    );
  }

  console.log(`Aug-5 old PnL sum=${oldPnlSum.toFixed(2)} new PnL sum=${newPnlSum.toFixed(2)}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

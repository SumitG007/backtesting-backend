/**
 * Apply ₹100 brokerage to stored OI Wall Scalp + BB Bounce paper trades
 * that were saved with 0 charges. Recalculates closed P/L and both wallets.
 *
 * Usage:
 *   node scripts/cutOiPaperTradeCharges.js --dry-run
 *   node scripts/cutOiPaperTradeCharges.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const {
  MANUAL_OI_AUTO_LIVE_KEY,
  OI_FLOW_BB_BOUNCE_LIVE_KEY,
} = require('../src/strategies/keys');

const DRY = process.argv.includes('--dry-run');
const ADD = 100;
const KEYS = [
  { strategyKey: MANUAL_OI_AUTO_LIVE_KEY, walletKey: 'paper_live_manual_oi_auto', label: 'OI Wall Scalp' },
  { strategyKey: OI_FLOW_BB_BOUNCE_LIVE_KEY, walletKey: 'paper_live_oi_flow_bb', label: 'BB Bounce' },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function recalcClosedPnl(trade, newCharges) {
  const qty = num(trade.qty);
  const entry = num(trade.entryPremium);
  const exit = num(trade.exitPremium);
  if (!(qty > 0) || !(entry > 0) || !(exit > 0)) {
    const oldPnl = Number(trade.pnl);
    if (!Number.isFinite(oldPnl)) return { pnl: trade.pnl, pnlPct: trade.pnlPct };
    const delta = num(trade.charges) - newCharges;
    const pnl = Number((oldPnl + delta).toFixed(2));
    const invested = num(trade.investedAmount) || entry * qty;
    return {
      pnl,
      pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
    };
  }
  const invested = entry * qty;
  const pnl = Number((exit * qty - invested - newCharges).toFixed(2));
  const investedAmount = num(trade.investedAmount) || invested;
  return {
    pnl,
    pnlPct: investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0,
  };
}

async function recalcWallet(strategyKey, walletKey) {
  let wallet = await LiveWallet.findOne({ walletKey });
  if (!wallet) return null;
  const rows = await LivePaperTrade.find({
    strategyKey,
    exitTime: { $ne: null },
  }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of rows) {
    const p = Number(t.pnl) || 0;
    realizedPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = rows.length;
  wallet.wins = wins;
  wallet.losses = losses;
  if (!DRY) await wallet.save();
  return {
    totalTrades: wallet.totalTrades,
    realizedPnl: wallet.realizedPnl,
    wins,
    losses,
  };
}

async function patchDesk({ strategyKey, walletKey, label }) {
  const trades = await LivePaperTrade.find({ strategyKey });
  let patched = 0;
  let skipped = 0;
  let pnlShift = 0;
  for (const trade of trades) {
    const oldCharges = num(trade.charges);
    if (oldCharges >= ADD - 1e-9) {
      skipped += 1;
      continue;
    }
    const newCharges = Number((oldCharges + ADD).toFixed(2));
    const patch = { charges: newCharges };
    const premiumInvested = num(trade.entryPremium) * num(trade.qty);
    if (Math.abs(num(trade.investedAmount) - (premiumInvested + oldCharges)) < 1) {
      patch.investedAmount = Number((premiumInvested + newCharges).toFixed(2));
    }
    if (trade.capitalLocked != null && Math.abs(num(trade.capitalLocked) - (premiumInvested + oldCharges)) < 1) {
      patch.capitalLocked = Number((premiumInvested + newCharges).toFixed(2));
    }
    const closed = Boolean(trade.exitTime) || trade.status === 'CLOSED';
    if (closed) {
      const next = recalcClosedPnl(trade, newCharges);
      patch.pnl = next.pnl;
      patch.pnlPct = next.pnlPct;
      if (Number.isFinite(Number(trade.pnl)) && Number.isFinite(Number(next.pnl))) {
        pnlShift += Number(next.pnl) - Number(trade.pnl);
      }
    }
    patched += 1;
    if (!DRY) {
      Object.assign(trade, patch);
      await trade.save();
    }
  }
  const wallet = await recalcWallet(strategyKey, walletKey);
  return { label, total: trades.length, patched, skipped, pnlShift: Number(pnlShift.toFixed(2)), wallet };
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI missing');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const results = [];
  for (const desk of KEYS) results.push(await patchDesk(desk));
  console.log(DRY ? 'DRY RUN' : 'APPLIED');
  console.log(JSON.stringify(results, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

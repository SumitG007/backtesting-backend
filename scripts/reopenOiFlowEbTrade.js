/**
 * Reopen OI Flow E/B CE trade — option SL/TP only (no TIME / EOD).
 * Usage: node scripts/reopenOiFlowEbTrade.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const LivePaperTrade = require('../src/models/livePaperTrade');
const LiveWallet = require('../src/models/liveWallet');
const { OI_FLOW_EB_LIVE_KEY } = require('../src/strategies/keys');

const WALLET_KEY = 'paper_live_oi_flow_eb';
const OPTION_SL = 12;
const OPTION_TP = 15;

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);

  let trade = await LivePaperTrade.findOne({
    strategyKey: OI_FLOW_EB_LIVE_KEY,
    optionType: 'CE',
    strike: 23950,
    entryPremium: 121.45,
  }).sort({ entryTime: -1 });

  if (!trade) {
    trade = await LivePaperTrade.findOne({
      strategyKey: OI_FLOW_EB_LIVE_KEY,
      optionType: 'CE',
      strike: 23950,
    }).sort({ entryTime: -1 });
  }

  if (!trade) {
    console.error('CE 23950 trade not found');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const openExisting = await LivePaperTrade.findOne({
    strategyKey: OI_FLOW_EB_LIVE_KEY,
    status: 'OPEN',
    exitTime: null,
    _id: { $ne: trade._id },
  });
  if (openExisting) {
    console.error('Another OPEN OI Flow E/B trade already exists:', openExisting._id);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  const entryPrem = Number(trade.entryPremium);
  const stopLossPremium = Number((entryPrem - OPTION_SL).toFixed(2));
  const targetPremium = Number((entryPrem + OPTION_TP).toFixed(2));
  const snap = { ...(trade.signalSnapshot || {}) };
  snap.riskPts = OPTION_SL;
  snap.rewardPts = OPTION_TP;
  snap.optionSlPts = OPTION_SL;
  snap.optionTpPts = OPTION_TP;
  snap.stopLossPremium = stopLossPremium;
  snap.targetPremium = targetPremium;
  delete snap.favorPts;
  delete snap.exitReason;
  delete snap.stopSpot;
  delete snap.targetSpot;
  delete snap.maxHoldMin;
  delete snap.rawRisk;
  delete snap.clamped;
  delete snap.candleHigh;
  delete snap.candleLow;

  trade.status = 'OPEN';
  trade.set('exitPremium', undefined);
  trade.set('exitSpot', undefined);
  trade.exitTime = null;
  trade.set('exitDateKey', undefined);
  trade.set('reason', undefined);
  trade.set('finalValue', undefined);
  trade.set('pnl', undefined);
  trade.set('pnlPct', undefined);
  trade.openPositionMark = null;
  trade.openPositionMarkAt = null;
  trade.combinedStopSpot = null;
  trade.targetSpot = null;
  trade.stopLossPremium = stopLossPremium;
  trade.targetPremium = targetPremium;
  trade.stopLossMode = 'POINTS';
  trade.targetMode = 'POINTS';
  trade.signalSnapshot = snap;
  trade.notes = [
    trade.notes,
    `reopened ${new Date().toISOString()}; strikeOptionSL=${stopLossPremium}; strikeOptionTP=${targetPremium}; exits=SL|TP_only`,
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
  await trade.save();

  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      cashLedger: false,
    });
  }
  const prev = wallet.oiFlowEbEngineSettings?.toObject?.()
    || wallet.oiFlowEbEngineSettings
    || {};
  const nextSettings = {
    ...prev,
    enabled: true,
    optionSlPts: OPTION_SL,
    optionTpPts: OPTION_TP,
  };
  delete nextSettings.riskMin;
  delete nextSettings.riskMax;
  delete nextSettings.slBufferPts;
  delete nextSettings.rMult;
  delete nextSettings.tpCap;
  delete nextSettings.maxHoldMin;
  wallet.oiFlowEbEngineSettings = nextSettings;

  const closed = await LivePaperTrade.find({
    strategyKey: OI_FLOW_EB_LIVE_KEY,
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
    const p = Number(t.pnl) || 0;
    realizedPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = closed.length;
  wallet.wins = wins;
  wallet.losses = losses;
  wallet.markModified('oiFlowEbEngineSettings');
  await wallet.save();

  // Verify OPEN stuck
  const verify = await LivePaperTrade.findById(trade._id).lean();
  console.log(JSON.stringify({
    ok: verify.status === 'OPEN' && !verify.exitTime,
    tradeId: String(trade._id),
    status: verify.status,
    reason: verify.reason || null,
    exitTime: verify.exitTime,
    strike: verify.strike,
    entryPremium: verify.entryPremium,
    stopLossPremium: verify.stopLossPremium,
    targetPremium: verify.targetPremium,
    exitRules: 'STRIKE_OPTION_LTP_SL_OR_TP_ONLY',
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exitCode = 1;
});

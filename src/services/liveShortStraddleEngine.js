const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes } = require('../utils/dateTime');
const { getStrikeStep } = require('../utils/market');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getTradableWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');

const STRATEGY_KEY = 'strategy3_short_straddle';
const CE_SUBSCRIPTION_KEY = 'engine:strategy2:ce';
const PE_SUBSCRIPTION_KEY = 'engine:strategy2:pe';
const POLL_INTERVAL_MS = 15000;
const POSITION_POLL_MS = 3200;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  settings: {
    lotCount: 1,
    targetPct: 50,
    stopLossPct: 30,
    entryTime: '09:30',
    dayCloseTime: '09:20',
    skipExpiryDay: true,
    perTradeCost: 100,
  },
  lotSize: 75,
  expiry: null,
  lastSpot: null,
  lastOptionTicks: { CE: null, PE: null },
  tradeDateKey: null,
  openTradeId: null,
  closingTrade: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
};

function normalizeSettings(settings = {}) {
  const rawPerTradeCost = Number(settings.perTradeCost);
  const skipExpiryDay = settings.skipExpiryDay !== false && settings.skipExpiryDay !== 'false';
  return {
    lotCount: Math.max(1, Number(settings.lotCount) || 1),
    targetPct: Math.max(1, Number(settings.targetPct) || 50),
    stopLossPct: Math.max(1, Number(settings.stopLossPct) || 30),
    entryTime: String(settings.entryTime || settings.entryFromTime || '09:30'),
    dayCloseTime: String(settings.dayCloseTime || '09:20'),
    skipExpiryDay,
    perTradeCost: Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100,
  };
}

function getCombinedFromTrade(trade, chain = null) {
  const ce = Number(chain?.ceLtp);
  const pe = Number(chain?.peLtp);
  if (Number.isFinite(ce) && ce > 0 && Number.isFinite(pe) && pe > 0) {
    return { combined: ce + pe, ce, pe, spot: Number(chain.chainSpot) || null };
  }

  const ceTick = Number(engineState.lastOptionTicks.CE?.ltp);
  const peTick = Number(engineState.lastOptionTicks.PE?.ltp);
  if (Number.isFinite(ceTick) && ceTick > 0 && Number.isFinite(peTick) && peTick > 0) {
    return { combined: ceTick + peTick, ce: ceTick, pe: peTick, spot: engineState.lastSpot };
  }

  const ceEntry = Number(trade.legs?.find((l) => l.optionType === 'CE')?.entryPremium);
  const peEntry = Number(trade.legs?.find((l) => l.optionType === 'PE')?.entryPremium);
  return {
    combined: Math.max(0.05, (Number.isFinite(ceEntry) ? ceEntry : 0) + (Number.isFinite(peEntry) ? peEntry : 0)),
    ce: ceEntry,
    pe: peEntry,
    spot: engineState.lastSpot || trade.entrySpot,
  };
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: 'default' });
  if (!wallet) wallet = await LiveWallet.create({ walletKey: 'default' });
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

async function subscribeOpenStraddle(trade) {
  unsubscribeLiveSymbol(CE_SUBSCRIPTION_KEY);
  unsubscribeLiveSymbol(PE_SUBSCRIPTION_KEY);
  engineState.lastOptionTicks = { CE: null, PE: null };

  const legs = Array.isArray(trade.legs) ? trade.legs : [];
  for (const leg of legs) {
    try {
      const instrument = await resolveOptionInstrument({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
        optionType: leg.optionType,
      });
      subscribeLiveInstrument({
        key: leg.optionType === 'CE' ? CE_SUBSCRIPTION_KEY : PE_SUBSCRIPTION_KEY,
        securityId: instrument.securityId,
        exchangeSegment: instrument.exchangeSegment,
        onTick: (tick) => onOptionTick(leg.optionType, tick),
      });
    } catch (err) {
      engineState.lastError = `Strategy 2 option WS subscribe failed: ${err.message}`;
    }
  }
}

async function getCurrentExpiry(symbol, dateKey) {
  const cachedExpiry = String(engineState.expiry || '').slice(0, 10);
  const shouldAvoidSameDay = engineState.settings.skipExpiryDay;
  const isStale = !cachedExpiry
    || cachedExpiry < dateKey
    || (shouldAvoidSameDay && cachedExpiry === dateKey);
  if (isStale) {
    engineState.expiry = shouldAvoidSameDay
      ? await getTradableWeeklyExpiry(symbol, dateKey)
      : await getNearestWeeklyExpiry(symbol);
  }
  return engineState.expiry;
}

async function shouldEnterNow(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, 570);
  if (clock.minutes !== entryMinutes) return false;
  if (engineState.tradeDateKey === clock.dateKey) return false;
  if (engineState.openTradeId) return false;
  await getCurrentExpiry(engineState.symbol, clock.dateKey);
  return true;
}

async function evaluateEntry() {
  const clock = getIstClock(new Date());
  if (!(await shouldEnterNow(clock))) return;
  await placeShortStraddle(clock);
}

async function placeShortStraddle(clock) {
  try {
    const symbol = engineState.symbol;
    const expiry = await getCurrentExpiry(symbol, clock.dateKey);
    engineState.expiry = expiry;
    const chainForSpot = await getAtmPremiums({ symbol, strike: 0, expiry });
    const spot = Number(chainForSpot.chainSpot || chainForSpot.spot);
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'Strategy 2 entry skipped: live spot unavailable';
      return;
    }
    const strikeStep = getStrikeStep(symbol);
    const strike = Math.round(spot / strikeStep) * strikeStep;
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const ceEntry = Number(premiums.ceLtp);
    const peEntry = Number(premiums.peLtp);
    if (!Number.isFinite(ceEntry) || ceEntry <= 0 || !Number.isFinite(peEntry) || peEntry <= 0) {
      engineState.lastError = `Strategy 2 entry skipped: missing CE/PE premium for ${strike}`;
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 1);
    const qty = lotSize * lots;
    const entryCredit = ceEntry + peEntry;
    const targetPremium = entryCredit * (1 - engineState.settings.targetPct / 100);
    const stopLossPremium = entryCredit * (1 + engineState.settings.stopLossPct / 100);
    const rawCharges = Number(engineState.settings.perTradeCost);
    const charges = Number.isFinite(rawCharges) && rawCharges >= 0 ? rawCharges : 100;

    const tradeDoc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'SELL',
      optionType: 'STRADDLE',
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryCredit.toFixed(2)),
      entryCredit: Number(entryCredit.toFixed(2)),
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      status: 'OPEN',
      investedAmount: Number((entryCredit * qty).toFixed(2)),
      charges: Number(charges.toFixed(2)),
      legs: [
        { optionType: 'CE', entryPremium: Number(ceEntry.toFixed(2)) },
        { optionType: 'PE', entryPremium: Number(peEntry.toFixed(2)) },
      ],
      notes: `btstEntry=${clock.dateKey}; targetPct=${engineState.settings.targetPct}; stopLossPct=${engineState.settings.stopLossPct}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradeDateKey = clock.dateKey;
    engineState.lastSpot = spot;
    engineState.lastSignalAt = new Date();
    await subscribeOpenStraddle(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
  }
}

async function onOptionTick(optionType, { ltp }) {
  engineState.lastOptionTicks[optionType] = { ltp: Number(ltp), ts: Date.now() };
  await checkOpenTrade({ preferTicks: true });
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  if (!engineState.running || !engineState.openTradeId || engineState.closingTrade) return;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.status === 'CLOSED') {
    clearOpenTrade();
    return;
  }

  const clock = getIstClock(new Date());
  if (clock.dateKey === trade.entryDateKey) return;
  const exitMinutes = parseClockMinutes(engineState.settings.dayCloseTime, 560);

  let mark = null;
  if (!preferTicks) {
    try {
      const chain = await getAtmPremiums({ symbol: trade.symbol, strike: trade.strike, expiry: trade.expiryDate });
      mark = getCombinedFromTrade(trade, chain);
      if (Number.isFinite(mark.spot)) engineState.lastSpot = mark.spot;
    } catch (err) {
      engineState.lastError = `Strategy 2 option chain refresh: ${err.message}`;
    }
  }
  if (!mark) mark = getCombinedFromTrade(trade);

  if (Number.isFinite(mark.combined) && mark.combined <= trade.targetPremium) {
    await finalizeTrade(trade, { exitCombined: trade.targetPremium, mark, reason: 'TARGET' });
    return;
  }
  if (Number.isFinite(mark.combined) && mark.combined >= trade.stopLossPremium) {
    await finalizeTrade(trade, { exitCombined: trade.stopLossPremium, mark, reason: 'STOP_LOSS' });
    return;
  }
  if (clock.minutes >= exitMinutes) {
    await finalizeTrade(trade, { exitCombined: mark.combined, mark, reason: 'DAY_CLOSE' });
  }
}

async function finalizeTrade(trade, { exitCombined, mark, reason }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  try {
    const safeExitCombined = Math.max(0.05, Number(exitCombined) || 0.05);
    const exitDebit = safeExitCombined * trade.qty;
    const credit = (Number(trade.entryCredit) || Number(trade.entryPremium) || 0) * trade.qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const rawPnl = credit - exitDebit;
    const pnl = rawPnl - charges;
    const clock = getIstClock(new Date());

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExitCombined.toFixed(2));
    trade.exitDebit = Number(safeExitCombined.toFixed(2));
    trade.exitSpot = Number(Number(mark?.spot || engineState.lastSpot || trade.entrySpot).toFixed(2));
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(exitDebit.toFixed(2));
    trade.charges = Number(charges.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    trade.pnlPct = credit > 0 ? Number(((pnl / credit) * 100).toFixed(2)) : 0;
    await trade.save();

    const wallet = await ensureWallet();
    wallet.balance += pnl;
    wallet.realizedPnl += pnl;
    wallet.totalTrades += 1;
    if (pnl > 0) wallet.wins += 1;
    else if (pnl < 0) wallet.losses += 1;
    await wallet.save();
  } finally {
    clearOpenTrade();
    engineState.closingTrade = false;
  }
}

function clearOpenTrade() {
  stopPositionPoll();
  unsubscribeLiveSymbol(CE_SUBSCRIPTION_KEY);
  unsubscribeLiveSymbol(PE_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.lastOptionTicks = { CE: null, PE: null };
}

function stopPositionPoll() {
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function startPositionPoll() {
  stopPositionPoll();
  if (!engineState.openTradeId) return;
  const tick = () => {
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Strategy 2 position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    evaluateEntry().catch((err) => {
      engineState.lastError = `Strategy 2 entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Strategy 2 exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  if (engineState.running) return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
  engineState.lastError = null;
  try {
    engineState.lotSize = await getCurrentLotSize(engineState.symbol);
    const clock = getIstClock(new Date());
    engineState.expiry = engineState.settings.skipExpiryDay
      ? await getTradableWeeklyExpiry(engineState.symbol, clock.dateKey)
      : await getNearestWeeklyExpiry(engineState.symbol);
  } catch (err) {
    engineState.lastError = `Strategy 2 setup: ${err.message}`;
  }
  try {
    const orphan = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, status: 'OPEN' }).sort({ entryTime: -1 });
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.tradeDateKey = orphan.entryDateKey;
      await subscribeOpenStraddle(orphan);
      startPositionPoll();
    }
  } catch (err) {
    engineState.lastError = `Strategy 2 adopt open trade failed: ${err.message}`;
  }
  engineState.running = true;
  engineState.startedAt = new Date();
  startPoll();
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  if (engineState.pollTimer) {
    clearInterval(engineState.pollTimer);
    engineState.pollTimer = null;
  }
  clearOpenTrade();
  engineState.running = false;
  engineState.startedAt = null;
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  const next = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.settings = next;
  try {
    const wallet = await ensureWallet();
    wallet.strategy2EngineSettings = next;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Strategy 2 settings persist failed: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy2EngineSettings
      ? wallet.strategy2EngineSettings.toObject?.() || wallet.strategy2EngineSettings
      : {};
    return startEngine({ symbol, settings: persisted });
  } catch (err) {
    engineState.lastError = `Strategy 2 boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    symbol: engineState.symbol,
    startedAt: engineState.startedAt,
    lotSize: engineState.lotSize,
    expiry: engineState.expiry,
    settings: engineState.settings,
    lastSpot: engineState.lastSpot,
    lastOptionTicks: engineState.lastOptionTicks,
    tradeDateKey: engineState.tradeDateKey,
    openTradeId: engineState.openTradeId,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
  };
}

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  bootEngineFromDb,
  getEngineSnapshot,
  ensureWallet,
};

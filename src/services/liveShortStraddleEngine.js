const LivePaperTrade = require('../models/livePaperTrade');
/** Strategy 2 live paper engine. Backtest twin: `strategies/strategy2/shortStraddleBacktest.js`. */
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
const POLL_INTERVAL_MS = 8000;
const POSITION_POLL_MS = 6000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 10000;
const TICK_FRESH_MAX_AGE_MS = 45000;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  settings: {
    lotCount: 1,
    targetPct: null,
    stopLossPct: null,
    entryTime: '09:30',
    entryWindowMinutes: 5,
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

function parseOptionalPct(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, parsed);
}

function istClockLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logEntry(line, payload = {}) {
  const entry = {
    at: new Date().toISOString(),
    line,
    ...payload,
  };
  engineState.lastEntryDebug = entry;
  console.log(`[Strategy2Live] ${line}`, JSON.stringify(entry));
}

function normalizeSettings(settings = {}) {
  const rawPerTradeCost = Number(settings.perTradeCost);
  const skipExpiryDay = settings.skipExpiryDay !== false && settings.skipExpiryDay !== 'false';
  return {
    lotCount: Math.max(1, Number(settings.lotCount) || 1),
    targetPct: parseOptionalPct(settings.targetPct),
    stopLossPct: parseOptionalPct(settings.stopLossPct),
    entryTime: String(settings.entryTime || settings.entryFromTime || '09:30'),
    entryWindowMinutes: Math.max(0, Math.min(30, Number(settings.entryWindowMinutes) || 5)),
    dayCloseTime: String(settings.dayCloseTime || '09:20'),
    skipExpiryDay,
    perTradeCost: Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100,
  };
}

function getCombinedFromTrade(trade, chain = null) {
  const ce = Number(chain?.ceLtp);
  const pe = Number(chain?.peLtp);
  if (Number.isFinite(ce) && ce > 0 && Number.isFinite(pe) && pe > 0) {
    return { combined: ce + pe, ce, pe, spot: Number(chain.chainSpot) || null, source: 'chain' };
  }

  const ceTick = Number(engineState.lastOptionTicks.CE?.ltp);
  const peTick = Number(engineState.lastOptionTicks.PE?.ltp);
  if (Number.isFinite(ceTick) && ceTick > 0 && Number.isFinite(peTick) && peTick > 0) {
    return {
      combined: ceTick + peTick,
      ce: ceTick,
      pe: peTick,
      spot: engineState.lastSpot,
      source: 'websocket',
    };
  }

  const ceEntry = Number(trade.legs?.find((l) => l.optionType === 'CE')?.entryPremium);
  const peEntry = Number(trade.legs?.find((l) => l.optionType === 'PE')?.entryPremium);
  return {
    combined: Math.max(0.05, (Number.isFinite(ceEntry) ? ceEntry : 0) + (Number.isFinite(peEntry) ? peEntry : 0)),
    ce: ceEntry,
    pe: peEntry,
    spot: engineState.lastSpot || trade.entrySpot,
    source: 'entry',
  };
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryCredit = Number(trade.entryCredit ?? trade.entryPremium) || 0;
  const combined = Number(mark?.combined) || 0;
  const qty = Number(trade.qty) || 0;
  const charges = Math.max(0, Number(trade.charges) || 0);
  const credit = entryCredit * qty;
  const buyback = combined * qty;
  const grossPnl = credit - buyback;
  const unrealizedPnl = grossPnl - charges;
  const entrySpot = Number(trade.entrySpot);
  const spot = Number(mark?.spot);
  const targetPremium = trade.targetPremium != null ? Number(trade.targetPremium) : null;
  const stopLossPremium = trade.stopLossPremium != null ? Number(trade.stopLossPremium) : null;

  return {
    at: new Date().toISOString(),
    source: mark?.source || 'entry',
    ceLtp: Number.isFinite(mark?.ce) ? Number(mark.ce.toFixed(2)) : null,
    peLtp: Number.isFinite(mark?.pe) ? Number(mark.pe.toFixed(2)) : null,
    combinedPremium: Number(combined.toFixed(2)),
    entryCredit: Number(entryCredit.toFixed(2)),
    creditReceived: Number(credit.toFixed(2)),
    currentBuyback: Number(buyback.toFixed(2)),
    grossPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    unrealizedPnlPct: credit > 0 ? Number(((unrealizedPnl / credit) * 100).toFixed(2)) : 0,
    spot: Number.isFinite(spot) ? Number(spot.toFixed(2)) : null,
    spotChange: Number.isFinite(spot) && Number.isFinite(entrySpot)
      ? Number((spot - entrySpot).toFixed(2))
      : null,
    targetPremium,
    stopLossPremium,
    premiumAboveTarget: targetPremium != null ? Number((combined - targetPremium).toFixed(2)) : null,
    premiumBelowStop: stopLossPremium != null ? Number((stopLossPremium - combined).toFixed(2)) : null,
    isProfitable: unrealizedPnl > 0,
    phase: clock.dateKey === trade.entryDateKey ? 'ENTRY_DAY_HOLD' : 'EXIT_DAY_MONITOR',
    nextDayExitTime: engineState.settings.dayCloseTime,
  };
}

function optionTicksAreFresh() {
  const ce = engineState.lastOptionTicks.CE;
  const pe = engineState.lastOptionTicks.PE;
  if (!Number.isFinite(ce?.ltp) || !Number.isFinite(pe?.ltp)) return false;
  const now = Date.now();
  return now - (ce.ts || 0) < TICK_FRESH_MAX_AGE_MS && now - (pe.ts || 0) < TICK_FRESH_MAX_AGE_MS;
}

async function resolveMarkForOpenTrade(trade, { preferTicks = false, allowChain = true } = {}) {
  if (preferTicks || optionTicksAreFresh()) {
    const tickMark = getCombinedFromTrade(trade, null);
    if (tickMark.source === 'websocket') return tickMark;
  }

  const now = Date.now();
  const chainGapOk = now - engineState.lastChainFetchAt >= OPEN_MARK_CHAIN_MIN_GAP_MS;
  if (!allowChain || !chainGapOk) {
    return getCombinedFromTrade(trade, null);
  }

  try {
    engineState.lastChainFetchAt = now;
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const mark = getCombinedFromTrade(trade, chain);
    if (Number.isFinite(mark.spot)) engineState.lastSpot = mark.spot;
    return mark;
  } catch (err) {
    const msg = String(err.message || '');
    if (msg.includes('429') || /rate\s*limit/i.test(msg)) {
      engineState.lastError = 'Dhan rate limit — using websocket / last cached premiums';
    } else {
      engineState.lastError = `Strategy 2 mark refresh: ${msg}`;
    }
    return getCombinedFromTrade(trade, null);
  }
}

async function refreshOpenPositionMark({ preferTicks = false, tradeDoc = null } = {}) {
  const trade = tradeDoc
    || (engineState.openTradeId
      ? await LivePaperTrade.findById(engineState.openTradeId).lean()
      : null);
  if (!trade || trade.exitTime) {
    engineState.openPositionMark = null;
    return null;
  }
  const clock = getIstClock(new Date());
  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: !preferTicks,
  });
  engineState.openPositionMark = buildOpenPositionMark(trade, mark, clock);
  return engineState.openPositionMark;
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

function isNearEntryWindow(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, 570);
  const entryWindowMinutes = Math.max(0, Number(engineState.settings.entryWindowMinutes) || 0);
  return clock.minutes >= entryMinutes - 25 && clock.minutes <= entryMinutes + entryWindowMinutes + 10;
}

/** Keep in-memory state aligned with Mongo (e.g. after manual DB deletes). */
async function syncEngineTradeStateFromDb(clock) {
  const openInDb = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  })
    .sort({ entryTime: -1 });

  if (openInDb) {
    const openId = openInDb._id.toString();
    if (engineState.openTradeId !== openId) {
      engineState.openTradeId = openId;
      engineState.tradeDateKey = openInDb.entryDateKey;
      logEntry('ENGINE_SYNC_ADOPTED_OPEN_TRADE', {
        ist: istClockLabel(clock),
        tradeId: openId,
        entryDateKey: openInDb.entryDateKey,
      });
      await subscribeOpenStraddle(openInDb);
      startPositionPoll();
    }
    return;
  }

  if (engineState.openTradeId) {
    clearOpenTrade();
    logEntry('ENGINE_SYNC_CLEARED_STALE_OPEN_TRADE', { ist: istClockLabel(clock) });
  }

  const tradedToday = await LivePaperTrade.exists({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });

  if (tradedToday) {
    engineState.tradeDateKey = clock.dateKey;
  } else if (engineState.tradeDateKey === clock.dateKey) {
    engineState.tradeDateKey = null;
    logEntry('ENGINE_SYNC_CLEARED_TRADE_DATE', {
      ist: istClockLabel(clock),
      reason: 'NO_TRADE_IN_DB_FOR_TODAY',
    });
  }
}

async function getEntryGate(clock) {
  if (!engineState.running) {
    return { ok: false, reason: 'ENGINE_OFFLINE' };
  }
  await syncEngineTradeStateFromDb(clock);
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, 570);
  const entryWindowMinutes = Math.max(0, Number(engineState.settings.entryWindowMinutes) || 0);
  const windowEnd = entryMinutes + entryWindowMinutes;
  if (clock.minutes < entryMinutes) {
    return {
      ok: false,
      reason: 'BEFORE_ENTRY_WINDOW',
      entryTime: engineState.settings.entryTime,
      entryMinutes,
      nowMinutes: clock.minutes,
    };
  }
  if (clock.minutes > windowEnd) {
    return {
      ok: false,
      reason: 'AFTER_ENTRY_WINDOW',
      entryTime: engineState.settings.entryTime,
      entryWindowMinutes,
      windowEndMinutes: windowEnd,
      nowMinutes: clock.minutes,
    };
  }
  if (engineState.tradeDateKey === clock.dateKey) {
    return {
      ok: false,
      reason: 'ALREADY_TRADED_TODAY',
      tradeDateKey: engineState.tradeDateKey,
    };
  }
  if (engineState.openTradeId) {
    return {
      ok: false,
      reason: 'OPEN_TRADE_EXISTS',
      openTradeId: engineState.openTradeId,
    };
  }
  try {
    const expiry = await getCurrentExpiry(engineState.symbol, clock.dateKey);
    if (!expiry) {
      return { ok: false, reason: 'NO_EXPIRY_FROM_DHAN' };
    }
  } catch (err) {
    return { ok: false, reason: 'EXPIRY_FETCH_FAILED', error: err.message };
  }
  return {
    ok: true,
    reason: 'READY_TO_ENTER',
    entryTime: engineState.settings.entryTime,
    entryWindowMinutes,
  };
}

async function evaluateEntry() {
  const clock = getIstClock(new Date());
  const gate = await getEntryGate(clock);
  if (!gate.ok) {
    if (isNearEntryWindow(clock)) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), ...gate });
    }
    return;
  }
  logEntry('ENTRY_TRIGGER', { ist: istClockLabel(clock), ...gate });
  await placeShortStraddle(clock);
}

async function placeShortStraddle(clock) {
  try {
    const symbol = engineState.symbol;
    const expiry = await getCurrentExpiry(symbol, clock.dateKey);
    engineState.expiry = expiry;
    logEntry('ENTRY_FETCH_CHAIN', { ist: istClockLabel(clock), expiry });
    const chainForSpot = await getAtmPremiums({ symbol, strike: 0, expiry });
    const spot = Number(chainForSpot.chainSpot || chainForSpot.spot);
    if (!Number.isFinite(spot) || spot <= 0) {
      engineState.lastError = 'Strategy 2 entry skipped: live spot unavailable';
      logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), reason: 'NO_SPOT' });
      return;
    }
    const strikeStep = getStrikeStep(symbol);
    const strike = Math.round(spot / strikeStep) * strikeStep;
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const ceEntry = Number(premiums.ceLtp);
    const peEntry = Number(premiums.peLtp);
    if (!Number.isFinite(ceEntry) || ceEntry <= 0 || !Number.isFinite(peEntry) || peEntry <= 0) {
      engineState.lastError = `Strategy 2 entry skipped: missing CE/PE premium for ${strike}`;
      logEntry('ENTRY_FAILED', {
        ist: istClockLabel(clock),
        reason: 'MISSING_CE_PE',
        strike,
        ceEntry,
        peEntry,
      });
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 1);
    const qty = lotSize * lots;
    const entryCredit = ceEntry + peEntry;
    const targetPct = engineState.settings.targetPct;
    const stopLossPct = engineState.settings.stopLossPct;
    const targetPremium = targetPct != null
      ? entryCredit * (1 - targetPct / 100)
      : null;
    const stopLossPremium = stopLossPct != null
      ? entryCredit * (1 + stopLossPct / 100)
      : null;
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
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
      status: 'OPEN',
      investedAmount: Number((entryCredit * qty).toFixed(2)),
      charges: Number(charges.toFixed(2)),
      legs: [
        { optionType: 'CE', entryPremium: Number(ceEntry.toFixed(2)) },
        { optionType: 'PE', entryPremium: Number(peEntry.toFixed(2)) },
      ],
      notes: `btstEntry=${clock.dateKey}; targetPct=${targetPct ?? 'off'}; stopLossPct=${stopLossPct ?? 'off'}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradeDateKey = clock.dateKey;
    engineState.lastSpot = spot;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      strike,
      expiry,
      entryCredit: Number(entryCredit.toFixed(2)),
      spot: Number(spot.toFixed(2)),
    });
    await subscribeOpenStraddle(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), reason: 'EXCEPTION', error: err.message });
  }
}

async function onOptionTick(optionType, { ltp }) {
  engineState.lastOptionTicks[optionType] = { ltp: Number(ltp), ts: Date.now() };
  await checkOpenTrade({ preferTicks: true });
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  if (!engineState.running || engineState.closingTrade) return;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    await syncEngineTradeStateFromDb(clock);
    return;
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: !preferTicks && !optionTicksAreFresh(),
  });
  engineState.openPositionMark = buildOpenPositionMark(trade, mark, clock);

  if (clock.dateKey === trade.entryDateKey) return;
  const exitMinutes = parseClockMinutes(engineState.settings.dayCloseTime, 560);

  if (
    trade.targetPremium != null
    && Number.isFinite(mark.combined)
    && mark.combined <= trade.targetPremium
  ) {
    await finalizeTrade(trade, { exitCombined: trade.targetPremium, mark, reason: 'TARGET' });
    return;
  }
  if (
    trade.stopLossPremium != null
    && Number.isFinite(mark.combined)
    && mark.combined >= trade.stopLossPremium
  ) {
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
  engineState.openPositionMark = null;
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
  if (engineState.running) {
    if (settings && Object.keys(settings).length > 0) {
      engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
      logEntry('ENGINE_ALREADY_RUNNING_SETTINGS_MERGED', { settings: engineState.settings });
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
  engineState.lastError = null;
  logEntry('ENGINE_START', { symbol: engineState.symbol, settings: engineState.settings });
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
    const orphan = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null })
      .sort({ entryTime: -1 });
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.tradeDateKey = orphan.entryDateKey;
      logEntry('ENGINE_ADOPTED_OPEN_TRADE', {
        tradeId: orphan._id.toString(),
        entryDateKey: orphan.entryDateKey,
      });
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
  logEntry('SETTINGS_UPDATED', { settings: next, running: engineState.running });
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
    lastEntryDebug: engineState.lastEntryDebug,
    openPositionMark: engineState.openPositionMark,
  };
}

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  bootEngineFromDb,
  getEngineSnapshot,
  refreshOpenPositionMark,
  ensureWallet,
};

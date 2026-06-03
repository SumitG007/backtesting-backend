const LivePaperTrade = require('../models/livePaperTrade');
/** Strategy 2 live paper engine — short straddle BTST (entry same day, exit next trading day). */
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey, parseDateOnly, addDays, formatDateOnly } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const { getStrikeStep } = require('../utils/market');
const { shortStraddleMarginBlocked } = require('../strategies/shared/shortStraddleMargin');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getTradableWeeklyExpiry,
  isExpiryTooSoonForNewEntry,
  resolveOptionInstrument,
  estimateShortStraddleMargin,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
  getLastPrice,
  getOptionChainRateLimitStatus,
} = require('./dhanLiveService');
const { applyExitLegPremiums } = require('./liveStraddleExitLegs');
const { STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY } = require('../strategies/keys');

const STRATEGY_KEY = STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY;
const CE_SUBSCRIPTION_KEY = 'engine:strategy4:ce';
const PE_SUBSCRIPTION_KEY = 'engine:strategy4:pe';
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
  lastStatusMarkRefreshAt: 0,
  lastLiveMark: null,
  settings: {
    symbol: 'NIFTY',
    lotCount: 1,
    entryTime: '15:20',
    entryWindowMinutes: 2,
    dayCloseTime: '15:15',
    skipExpiryDay: true,
    perTradeCost: 100,
  },
  lotSize: 65,
  expiry: null,
  lastSpot: null,
  lastOptionTicks: { CE: null, PE: null },
  tradeDateKey: null,
  openTradeId: null,
  closingTrade: false,
  enteringTrade: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
};

function getEngineSymbol() {
  return String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = getEngineSymbol();
}

/** First NSE trading day after entry date (exit day). */
function resolveFirstExitDateKey(entryDateKey) {
  const parsed = parseDateOnly(entryDateKey);
  if (Number.isNaN(parsed.getTime())) return null;
  for (let i = 1; i <= 10; i += 1) {
    const key = formatDateOnly(addDays(parsed, i));
    if (isNseCashTradingDay(key)) return key;
  }
  return null;
}

function parseTradeNote(notes, key) {
  if (!notes) return null;
  const match = String(notes).match(new RegExp(`${key}=([^;]+)`));
  return match?.[1]?.trim() || null;
}

/** Exit time locked on the trade at entry — settings changes apply to new trades only. */
function getTradePlannedExitTime(trade) {
  return parseTradeNote(trade?.notes, 'nextDayExit') || engineState.settings.dayCloseTime;
}

/** Exit on first trading day after entry at/after exit time; force exit if that day was missed. */
function shouldForceExitStraddle(trade, clock) {
  if (!trade?.entryDateKey || clock.dateKey <= trade.entryDateKey) return false;
  if (!isNseCashTradingDay(clock.dateKey)) return false;
  const exitDayKey = resolveFirstExitDateKey(trade.entryDateKey);
  if (!exitDayKey) return false;
  if (clock.dateKey > exitDayKey) return true;
  const exitMinutes = parseClockMinutes(getTradePlannedExitTime(trade), 915);
  return clock.minutes >= exitMinutes;
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
  console.log(`[Strategy4Live] ${line}`, JSON.stringify(entry));
}

function normalizeSettings(settings = {}) {
  const rawPerTradeCost = Number(settings.perTradeCost);
  const rawEntryWindow = Number(settings.entryWindowMinutes);
  const skipExpiryDay = settings.skipExpiryDay !== false && settings.skipExpiryDay !== 'false';
  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount: Math.max(1, Number(settings.lotCount) || 1),
    entryTime: (() => {
      const raw = String(settings.entryTime || settings.entryFromTime || '15:20').trim();
      const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
      if (!m) return '15:20';
      return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
    })(),
    entryWindowMinutes: Number.isFinite(rawEntryWindow)
      ? Math.max(0, Math.min(30, rawEntryWindow))
      : 2,
    dayCloseTime: String(settings.dayCloseTime || settings.nextDayExitTime || '15:15'),
    skipExpiryDay,
    perTradeCost: Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100,
  };
}

function markFromPremiums({ ce, pe, spot, source }) {
  if (!Number.isFinite(ce) || ce <= 0 || !Number.isFinite(pe) || pe <= 0) return null;
  return {
    combined: ce + pe,
    ce,
    pe,
    spot: Number.isFinite(spot) ? spot : engineState.lastSpot || null,
    source,
  };
}

function getCombinedFromTrade(trade, chain = null) {
  const fromChain = markFromPremiums({
    ce: Number(chain?.ceLtp),
    pe: Number(chain?.peLtp),
    spot: Number(chain?.chainSpot ?? chain?.spot),
    source: 'chain',
  });
  if (fromChain) return fromChain;

  const ceTick = Number(engineState.lastOptionTicks.CE?.ltp);
  const peTick = Number(engineState.lastOptionTicks.PE?.ltp);
  const fromTicks = markFromPremiums({
    ce: ceTick,
    pe: peTick,
    spot: engineState.lastSpot,
    source: 'websocket',
  });
  if (fromTicks) return fromTicks;

  const ceWs = Number(getLastPrice(CE_SUBSCRIPTION_KEY)?.ltp);
  const peWs = Number(getLastPrice(PE_SUBSCRIPTION_KEY)?.ltp);
  const fromWsCache = markFromPremiums({
    ce: ceWs,
    pe: peWs,
    spot: engineState.lastSpot,
    source: 'websocket',
  });
  if (fromWsCache) return fromWsCache;

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

function rememberLiveMark(mark) {
  if (!mark || mark.source === 'entry') return;
  engineState.lastLiveMark = {
    combined: mark.combined,
    ce: mark.ce,
    pe: mark.pe,
    spot: mark.spot,
    source: mark.source,
    at: Date.now(),
  };
}

async function persistOpenMarkToDb(trade, positionMark) {
  const tradeId = trade?._id;
  if (!tradeId || !positionMark) return;
  try {
    await LivePaperTrade.updateOne(
      { _id: tradeId, exitTime: null },
      {
        $set: {
          openPositionMark: positionMark,
          openPositionMarkAt: new Date(positionMark.at || Date.now()),
        },
      },
    );
  } catch (err) {
    engineState.lastError = `Strategy 2 MTM save: ${err.message}`;
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryCredit = Number(trade.entryCredit ?? trade.entryPremium) || 0;
  const combined = Number(mark?.combined) || 0;
  const qty = Number(trade.qty) || 0;
  const credit = entryCredit * qty;
  const buyback = combined * qty;
  const grossPnl = credit - buyback;
  const unrealizedPnl = grossPnl;
  const entrySpot = Number(trade.entrySpot);
  const spot = Number(mark?.spot);

  const source = mark?.source || 'entry';
  const isLiveMark = source === 'websocket' || source === 'chain' || source === 'cached_live';

  return {
    at: new Date().toISOString(),
    source,
    isLiveMark,
    priceSourceLabel: isLiveMark ? 'LIVE' : 'STALE (entry)',
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
    isProfitable: unrealizedPnl > 0,
    phase: clock.dateKey === trade.entryDateKey
      ? 'ENTRY_DAY_HOLD'
      : (isNseCashTradingDay(clock.dateKey)
        ? 'EXIT_DAY_MONITOR'
        : (isWeekendDateKey(clock.dateKey) ? 'WEEKEND_HOLD' : 'HOLIDAY_HOLD')),
    nextDayExitTime: getTradePlannedExitTime(trade),
  };
}

function optionTicksAreFresh() {
  const ce = engineState.lastOptionTicks.CE;
  const pe = engineState.lastOptionTicks.PE;
  if (!Number.isFinite(ce?.ltp) || !Number.isFinite(pe?.ltp)) return false;
  const now = Date.now();
  return now - (ce.ts || 0) < TICK_FRESH_MAX_AGE_MS && now - (pe.ts || 0) < TICK_FRESH_MAX_AGE_MS;
}

async function resolveMarkForOpenTrade(trade, { preferTicks = false, allowChain = true, forceChain = false } = {}) {
  if (preferTicks || optionTicksAreFresh()) {
    const tickMark = getCombinedFromTrade(trade, null);
    if (tickMark.source === 'websocket') {
      rememberLiveMark(tickMark);
      return tickMark;
    }
  }

  const now = Date.now();
  const chainGapOk = forceChain || now - engineState.lastChainFetchAt >= OPEN_MARK_CHAIN_MIN_GAP_MS;
  if (allowChain && chainGapOk) {
    try {
      engineState.lastChainFetchAt = now;
      const premiums = await getAtmPremiums({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
      });
      const mark = getCombinedFromTrade(trade, premiums);
      if (mark.source === 'chain') {
        if (Number.isFinite(mark.spot)) engineState.lastSpot = mark.spot;
        rememberLiveMark(mark);
        return mark;
      }
      if (!mark || mark.source === 'entry') {
        const rl = getOptionChainRateLimitStatus();
        if (rl.coolingDown) {
          engineState.lastError = 'Dhan option chain cooling down — using last live / WS prices';
        } else if (!premiums?.ceLtp && !premiums?.peLtp) {
          engineState.lastError = `Strategy 4: no chain LTP for strike ${trade.strike} exp ${trade.expiryDate}`;
        }
      }
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('429') || /rate\s*limit/i.test(msg)) {
        engineState.lastError = 'Dhan rate limit — using last live / websocket prices';
      } else {
        engineState.lastError = `Strategy 2 mark refresh: ${msg}`;
      }
    }
  }

  const fallback = getCombinedFromTrade(trade, null);
  if (fallback.source === 'websocket') {
    rememberLiveMark(fallback);
    return fallback;
  }

  const cached = engineState.lastLiveMark;
  if (cached && Number.isFinite(cached.combined) && cached.combined > 0) {
    const ageMs = now - (cached.at || 0);
    if (ageMs < 15 * 60 * 1000) {
      return {
        combined: cached.combined,
        ce: cached.ce,
        pe: cached.pe,
        spot: cached.spot,
        source: 'cached_live',
      };
    }
  }

  return fallback;
}

async function refreshOpenPositionMark({ preferTicks = false, tradeDoc = null, forceChain = false } = {}) {
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
    allowChain: true,
    forceChain,
  });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);
  return engineState.openPositionMark;
}

/** Called from status API (~6s) so MTM updates even if in-memory state was cleared. */
async function refreshOpenPositionMarkForStatus() {
  const now = Date.now();
  if (now - engineState.lastStatusMarkRefreshAt < POSITION_POLL_MS) {
    return engineState.openPositionMark;
  }
  engineState.lastStatusMarkRefreshAt = now;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) {
    const openInDb = await LivePaperTrade.findOne({
      strategyKey: STRATEGY_KEY,
      exitTime: null,
    })
      .sort({ entryTime: -1 });
    if (openInDb) {
      engineState.openTradeId = openInDb._id.toString();
      if (!engineState.positionPollTimer) {
        await subscribeOpenStraddle(openInDb);
        startPositionPoll();
      }
    }
  }
  return refreshOpenPositionMark({ forceChain: true });
}

async function ensureWallet() {
  const walletKey = 'paper_live_strategy4';
  let wallet = await LiveWallet.findOne({ walletKey });
  if (!wallet) wallet = await LiveWallet.create({ walletKey });
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
  const shouldAvoidNearExpiry = engineState.settings.skipExpiryDay;
  const isStale = !cachedExpiry
    || cachedExpiry < dateKey
    || (shouldAvoidNearExpiry && isExpiryTooSoonForNewEntry(cachedExpiry, dateKey, 2));
  if (isStale) {
    engineState.expiry = shouldAvoidNearExpiry
      ? await getTradableWeeklyExpiry(symbol, dateKey, 2)
      : await getNearestWeeklyExpiry(symbol);
  }
  return engineState.expiry;
}

function isNearEntryWindow(clock) {
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, 920);
  const entryWindowMinutes = Math.max(0, Number(engineState.settings.entryWindowMinutes) || 0);
  return clock.minutes >= entryMinutes - 25 && clock.minutes <= entryMinutes + entryWindowMinutes + 10;
}

/** Backfill locked exit time on trades created before notes included nextDayExit. */
async function backfillOpenTradeNotes(trade) {
  if (!trade || trade.exitTime) return trade;
  let changed = false;
  let notes = String(trade.notes || '');
  if (!parseTradeNote(notes, 'nextDayExit')) {
    notes = [notes, `nextDayExit=${engineState.settings.dayCloseTime}`].filter(Boolean).join('; ');
    changed = true;
  }
  if (!parseTradeNote(notes, 'lockedEntryTime')) {
    const entryClock = getIstClock(trade.entryTime || new Date());
    const h = Math.floor(entryClock.minutes / 60);
    const m = entryClock.minutes % 60;
    const lockedEntryTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    notes = [notes, `lockedEntryTime=${lockedEntryTime}`].filter(Boolean).join('; ');
    changed = true;
  }
  if (changed) {
    trade.notes = notes;
    await trade.save();
  }
  return trade;
}

/** Close duplicate OPEN rows — keep the newest entry only. */
async function dedupeOpenTradesInDb(clock) {
  const openRows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  })
    .sort({ entryTime: -1 });

  if (openRows.length <= 1) {
    if (openRows[0]) await backfillOpenTradeNotes(openRows[0]);
    return openRows[0] || null;
  }

  const [keep, ...duplicates] = openRows;
  for (const dup of duplicates) {
    dup.status = 'CLOSED';
    dup.exitTime = new Date();
    dup.exitDateKey = clock.dateKey;
    dup.reason = 'DUPLICATE_ENTRY';
    dup.notes = [dup.notes, `auto-closed duplicate at ${clock.dateKey}`].filter(Boolean).join('; ');
    dup.pnl = 0;
    dup.pnlPct = 0;
    await dup.save();
    logEntry('ENGINE_SYNC_CLOSED_DUPLICATE_OPEN_TRADE', {
      ist: istClockLabel(clock),
      tradeId: dup._id.toString(),
      keptTradeId: keep._id.toString(),
    });
  }
  if (duplicates.length > 0) {
    await recalcWalletFromTrades();
  }
  await backfillOpenTradeNotes(keep);
  return keep;
}

/** Keep in-memory state aligned with Mongo (e.g. after manual DB deletes). */
async function syncEngineTradeStateFromDb(clock) {
  const openInDb = await dedupeOpenTradesInDb(clock);

  if (openInDb) {
    const openId = openInDb._id.toString();
    const newlyAdopted = engineState.openTradeId !== openId;
    if (newlyAdopted) {
      engineState.openTradeId = openId;
      engineState.tradeDateKey = openInDb.entryDateKey;
      logEntry('ENGINE_SYNC_ADOPTED_OPEN_TRADE', {
        ist: istClockLabel(clock),
        tradeId: openId,
        entryDateKey: openInDb.entryDateKey,
      });
      await subscribeOpenStraddle(openInDb);
      startPositionPoll();
      checkOpenTrade().catch((err) => {
        engineState.lastError = `Strategy 2 sync exit check: ${err.message}`;
      });
    } else if (!engineState.positionPollTimer) {
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
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    if (isWeekendDateKey(clock.dateKey)) {
      return { ok: false, reason: 'MARKET_CLOSED_WEEKEND', dateKey: clock.dateKey };
    }
    return {
      ok: false,
      reason: 'MARKET_CLOSED_HOLIDAY',
      dateKey: clock.dateKey,
      holiday: getNseHolidayDescription(clock.dateKey),
    };
  }
  await syncEngineTradeStateFromDb(clock);
  const entryMinutes = parseClockMinutes(engineState.settings.entryTime, 920);
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
    const expiry = await getCurrentExpiry(getEngineSymbol(), clock.dateKey);
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
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    const existingOpen = await LivePaperTrade.findOne({
      strategyKey: STRATEGY_KEY,
      exitTime: null,
    }).sort({ entryTime: -1 });
    if (existingOpen) {
      engineState.openTradeId = existingOpen._id.toString();
      engineState.tradeDateKey = existingOpen.entryDateKey;
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'OPEN_TRADE_EXISTS_IN_DB',
        tradeId: existingOpen._id.toString(),
      });
      return;
    }
    const tradedToday = await LivePaperTrade.exists({
      strategyKey: STRATEGY_KEY,
      entryDateKey: clock.dateKey,
    });
    if (tradedToday) {
      engineState.tradeDateKey = clock.dateKey;
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'ALREADY_TRADED_TODAY_IN_DB',
        entryDateKey: clock.dateKey,
      });
      return;
    }

    const symbol = getEngineSymbol();
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
    const rawCharges = Number(engineState.settings.perTradeCost);
    const charges = Number.isFinite(rawCharges) && rawCharges >= 0 ? rawCharges : 100;

    let marginBlocked = null;
    let marginSource = 'formula';
    try {
      const marginResult = await estimateShortStraddleMargin({
        symbol,
        expiry,
        strike,
        lotSize,
        lots,
        cePrice: ceEntry,
        pePrice: peEntry,
        productType: 'MARGIN',
      });
      marginBlocked = marginResult.margin;
      marginSource = marginResult.source;
    } catch (err) {
      engineState.lastError = `Strategy 2 margin API fallback: ${err.message}`;
    }
    if (!Number.isFinite(marginBlocked) || marginBlocked <= 0) {
      marginBlocked = shortStraddleMarginBlocked({
        entrySpot: spot,
        lotSize,
        lotCount: lots,
        settings: engineState.settings,
      });
    }

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
      status: 'OPEN',
      investedAmount: Number(marginBlocked.toFixed(2)),
      creditReceived: Number((entryCredit * qty).toFixed(2)),
      charges: Number(charges.toFixed(2)),
      legs: [
        { optionType: 'CE', entryPremium: Number(ceEntry.toFixed(2)) },
        { optionType: 'PE', entryPremium: Number(peEntry.toFixed(2)) },
      ],
      notes: `btstEntry=${clock.dateKey}; nextDayExit=${engineState.settings.dayCloseTime}; lockedEntryTime=${engineState.settings.entryTime}; marginSource=${marginSource}; ceEntry=${ceEntry.toFixed(2)}; peEntry=${peEntry.toFixed(2)}`,
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
  } finally {
    engineState.enteringTrade = false;
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
    allowChain: true,
    forceChain: !preferTicks && !optionTicksAreFresh(),
  });
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  await persistOpenMarkToDb(trade, positionMark);

  await ensureNseHolidaysLoaded();
  if (!shouldForceExitStraddle(trade, clock)) return;

  const exitDayKey = resolveFirstExitDateKey(trade.entryDateKey);
  const exitReason = exitDayKey && clock.dateKey > exitDayKey ? 'MISSED_EXIT_RECOVERY' : 'NEXT_DAY_EXIT';
  await finalizeTrade(trade, { exitCombined: mark.combined, mark, reason: exitReason });
}

async function finalizeTrade(trade, { exitCombined, mark, reason }) {
  if (engineState.closingTrade) {
    throw new Error('Another close is already in progress — try again in a few seconds');
  }
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
    const marginBlocked = Number(trade.investedAmount) || shortStraddleMarginBlocked({
      entrySpot: trade.entrySpot,
      lotSize: trade.lotSize,
      lotCount: trade.lots,
      settings: engineState.settings,
    });
    trade.pnlPct = marginBlocked > 0 ? Number(((pnl / marginBlocked) * 100).toFixed(2)) : 0;
    applyExitLegPremiums(trade, mark, safeExitCombined);
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
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
  engineState.lastLiveMark = null;
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
      syncEngineSymbolFromSettings();
      logEntry('ENGINE_ALREADY_RUNNING_SETTINGS_MERGED', { settings: engineState.settings });
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({ ...engineState.settings, ...settings, symbol: settings.symbol || symbol });
  syncEngineSymbolFromSettings();
  engineState.lastError = null;
  logEntry('ENGINE_START', { symbol: getEngineSymbol(), settings: engineState.settings });
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    await dedupeOpenTradesInDb(clock);
    engineState.expiry = engineState.settings.skipExpiryDay
      ? await getTradableWeeklyExpiry(getEngineSymbol(), clock.dateKey, 2)
      : await getNearestWeeklyExpiry(getEngineSymbol());
  } catch (err) {
    engineState.lastError = `Strategy 2 setup: ${err.message}`;
  }
  try {
    const clock = getIstClock(new Date());
    const orphan = await dedupeOpenTradesInDb(clock);
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.tradeDateKey = orphan.entryDateKey;
      logEntry('ENGINE_ADOPTED_OPEN_TRADE', {
        tradeId: orphan._id.toString(),
        entryDateKey: orphan.entryDateKey,
      });
      await subscribeOpenStraddle(orphan);
      startPositionPoll();
      await checkOpenTrade();
      await refreshOpenPositionMark({ tradeDoc: orphan });
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
  const prevSymbol = getEngineSymbol();
  const next = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.settings = next;
  syncEngineSymbolFromSettings();
  if (getEngineSymbol() !== prevSymbol) {
    try {
      engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
      engineState.expiry = null;
    } catch (err) {
      engineState.lastError = `Strategy 2 symbol change: ${err.message}`;
    }
  }
  logEntry('SETTINGS_UPDATED', { settings: next, running: engineState.running });
  try {
    const wallet = await ensureWallet();
    wallet.strategy4EngineSettings = next;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Strategy 2 settings persist failed: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy4EngineSettings
      ? wallet.strategy4EngineSettings.toObject?.() || wallet.strategy4EngineSettings
      : {};
    return startEngine({ symbol: persisted.symbol || symbol, settings: persisted });
  } catch (err) {
    engineState.lastError = `Strategy 2 boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    symbol: getEngineSymbol(),
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

/** Re-read Mongo open trade, re-subscribe Dhan WS, run scheduled exit logic (after token/server gap). */
async function resumeOpenPositionFromDb() {
  if (!engineState.running) {
    return { ok: false, reason: 'ENGINE_OFFLINE' };
  }
  const clock = getIstClock(new Date());
  try {
    await syncEngineTradeStateFromDb(clock);
    if (!engineState.openTradeId) {
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    const trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (!trade || trade.exitTime) {
      clearOpenTrade();
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    await subscribeOpenStraddle(trade);
    if (!engineState.positionPollTimer) startPositionPoll();
    await checkOpenTrade();
    await refreshOpenPositionMark({ tradeDoc: trade });
    logEntry('ENGINE_RESUMED_OPEN_TRADE', {
      ist: istClockLabel(clock),
      tradeId: trade._id.toString(),
      entryDateKey: trade.entryDateKey,
    });
  } catch (err) {
    engineState.lastError = `Strategy 2 resume open position: ${err.message}`;
  }
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    return bootEngineFromDb();
  }
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (engineState.openTradeId) {
    if (!engineState.positionPollTimer) {
      const trade = await LivePaperTrade.findById(engineState.openTradeId);
      if (trade && !trade.exitTime) {
        await subscribeOpenStraddle(trade);
        startPositionPoll();
      }
    }
  }
  return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
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
  await wallet.save();
  return wallet;
}

async function resolveExitMarkForClose(trade) {
  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks: true,
    allowChain: true,
    forceChain: true,
  });
  if (Number.isFinite(mark?.combined) && mark.combined > 0) {
    return mark;
  }
  const opm = trade.openPositionMark || engineState.openPositionMark;
  if (opm && Number.isFinite(Number(opm.combinedPremium)) && Number(opm.combinedPremium) > 0) {
    return {
      combined: Number(opm.combinedPremium),
      ce: Number(opm.ceLtp),
      pe: Number(opm.peLtp),
      spot: Number(opm.spot) || trade.entrySpot,
      source: 'open_position_mark',
    };
  }
  return mark;
}

async function findOpenTradeForClose() {
  await syncEngineTradeStateFromDb(getIstClock(new Date()));
  if (engineState.openTradeId) {
    const fromEngine = await LivePaperTrade.findById(engineState.openTradeId);
    if (fromEngine && !fromEngine.exitTime) return fromEngine;
  }
  return LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).sort({ entryTime: -1 });
}

async function closeOpenPosition({ reason = 'MANUAL_CLOSE' } = {}) {
  if (!engineState.running) {
    await bootEngineFromDb();
  }
  if (!engineState.running) {
    throw new Error('Paper-live engine is not running — wait a few seconds and try again');
  }
  await ensureNseHolidaysLoaded();
  const clock = getIstClock(new Date());
  const trade = await findOpenTradeForClose();
  if (!trade) {
    clearOpenTrade();
    throw new Error('No open position to close');
  }
  engineState.openTradeId = trade._id.toString();
  engineState.tradeDateKey = trade.entryDateKey;
  logEntry('MANUAL_CLOSE_START', {
    ist: istClockLabel(clock),
    tradeId: trade._id.toString(),
    reason,
  });
  try {
    await subscribeOpenStraddle(trade);
  } catch (subErr) {
    engineState.lastError = `Strategy 2 manual close subscribe: ${subErr.message}`;
  }
  const mark = await resolveExitMarkForClose(trade);
  await finalizeTrade(trade, { exitCombined: mark.combined, mark, reason });
  const closed = await LivePaperTrade.findById(trade._id).lean();
  logEntry('MANUAL_CLOSE', {
    ist: istClockLabel(clock),
    tradeId: trade._id.toString(),
    reason,
    pnl: closed?.pnl,
    exitCombined: mark?.combined,
    markSource: mark?.source,
  });
  return { ok: true, trade: closed, state: getEngineSnapshot() };
}

async function reconcileOpenTrades() {
  const clock = getIstClock(new Date());
  return dedupeOpenTradesInDb(clock);
}

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  bootEngineFromDb,
  ensureEngineRunning,
  getEngineSnapshot,
  refreshOpenPositionMark,
  refreshOpenPositionMarkForStatus,
  ensureWallet,
  recalcWalletFromTrades,
  reconcileOpenTrades,
  resumeOpenPositionFromDb,
  closeOpenPosition,
};

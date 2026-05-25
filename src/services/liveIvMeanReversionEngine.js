/**
 * Strategy 3 — IV mean reversion paper live (real CE/PE LTP from Dhan).
 * Entry: 09:15–09:45 OR spike vs median → short ATM straddle 10:00–11:00.
 * Exit same day: optional target/stop %, IV expand on spot range, 15:20 flat.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { STRATEGY_THREE_IV_LIVE_KEY } = require('../strategies/keys');
const { getIstClock, sleep, isWeekendDateKey } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const { getStrikeStep } = require('../utils/market');
const { shortStraddleMarginBlocked } = require('../strategies/shared/shortStraddleMargin');
const { fetchTradingDayCandles, fetchWithRateLimitRetry } = require('./dhanDataService');
const {
  M945,
  M1000,
  M1100,
  EOD_EXIT,
  MIN_HOLD_MS,
  orIvProxyFromBars,
  buildOrIvByDayFromCandles,
  computeMedianOrIv,
  evaluateIvSpikeSignal,
  isInEntryWindow,
  isAfterOrWindow,
  isEodExitTime,
  postEntrySpotRange,
  normalizeIvSettings,
  premiumTargetsFromCredit,
} = require('../strategies/strategy5/ivMeanReversionLogic');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getTradableWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
} = require('./dhanLiveService');

const STRATEGY_KEY = STRATEGY_THREE_IV_LIVE_KEY;
const CE_SUBSCRIPTION_KEY = 'engine:strategy3iv:ce';
const PE_SUBSCRIPTION_KEY = 'engine:strategy3iv:pe';
const POLL_INTERVAL_MS = 8000;
const POSITION_POLL_MS = 5000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 10000;
const TICK_FRESH_MAX_AGE_MS = 45000;
const CANDLE_REFRESH_MIN_GAP_MS = 60000;
const CANDLE_REFRESH_FAST_GAP_MS = 30000;
const RETRY_MAX = 4;
const RETRY_BASE_MS = 600;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  settings: normalizeIvSettings({}),
  lotSize: 75,
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
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  lastCandleFetchAt: 0,
  todayBars: [],
  orIvByDay: new Map(),
  todaySignal: null,
  signalLockedForDay: false,
};

function istClockLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logEntry(line, payload = {}) {
  const entry = { at: new Date().toISOString(), line, ...payload };
  engineState.lastEntryDebug = entry;
  console.log(`[Strategy3PaperLive] ${line}`, JSON.stringify(entry));
}

async function withRetry(label, fn, { maxAttempts = RETRY_MAX, baseDelayMs = RETRY_BASE_MS } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * (attempt + 1);
      logEntry('RETRY', { label, attempt: attempt + 1, delayMs: delay, error: err.message });
      if (attempt < maxAttempts - 1) await sleep(delay);
    }
  }
  throw lastErr;
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
  if (!allowChain || now - engineState.lastChainFetchAt < OPEN_MARK_CHAIN_MIN_GAP_MS) {
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
    engineState.lastError = `Strategy 3 mark: ${err.message}`;
    return getCombinedFromTrade(trade, null);
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryCredit = Number(trade.entryCredit ?? trade.entryPremium) || 0;
  const combined = Number(mark?.combined) || 0;
  const qty = Number(trade.qty) || 0;
  const credit = entryCredit * qty;
  const buyback = combined * qty;
  const grossPnl = credit - buyback;
  const spot = Number(mark?.spot);
  const postRange = postEntrySpotRange(
    trade.entrySpot,
    trade.highSinceEntry,
    trade.lowSinceEntry,
  );
  const entryIv = Number(trade.entryIvProxy) || 0;
  const ivExpandLevel = entryIv > 0
    ? entryIv * (Number(engineState.settings.ivExpandStopMult) || 1.5)
    : null;

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
    unrealizedPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnlPct: credit > 0 ? Number(((grossPnl / credit) * 100).toFixed(2)) : 0,
    spot: Number.isFinite(spot) ? Number(spot.toFixed(2)) : null,
    entryIvProxy: entryIv || null,
    medianIvProxy: Number(trade.medianIvProxy) || null,
    postEntrySpotRange: postRange != null ? Number(postRange.toFixed(2)) : null,
    ivExpandLevel: ivExpandLevel != null ? Number(ivExpandLevel.toFixed(2)) : null,
    targetPremium: trade.targetPremium != null ? Number(trade.targetPremium) : null,
    stopLossPremium: trade.stopLossPremium != null ? Number(trade.stopLossPremium) : null,
    todaySignal: engineState.todaySignal,
    isProfitable: grossPnl > 0,
    phase: 'INTRADAY_HOLD',
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

async function persistOrHistory(dateKey, orIv) {
  const wallet = await ensureWallet();
  const list = Array.isArray(wallet.strategy3OrHistory) ? [...wallet.strategy3OrHistory] : [];
  const idx = list.findIndex((e) => e.dateKey === dateKey);
  const row = { dateKey, orIv: Number(orIv.toFixed(2)) };
  if (idx >= 0) list[idx] = row;
  else list.push(row);
  list.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  wallet.strategy3OrHistory = list.slice(-80);
  await wallet.save();
  engineState.orIvByDay = new Map(wallet.strategy3OrHistory.map((e) => [e.dateKey, e.orIv]));
}

async function loadOrHistoryFromWallet() {
  const wallet = await ensureWallet();
  const list = Array.isArray(wallet.strategy3OrHistory) ? wallet.strategy3OrHistory : [];
  engineState.orIvByDay = new Map(
    list.filter((e) => e?.dateKey && Number.isFinite(Number(e.orIv))).map((e) => [e.dateKey, Number(e.orIv)]),
  );
}

async function backfillOrHistoryIfNeeded() {
  if (engineState.orIvByDay.size >= 8) return;
  const year = new Date().getFullYear();
  try {
    const payload = await fetchWithRateLimitRetry({
      symbol: engineState.symbol,
      interval: '5',
      year,
    });
    const map = buildOrIvByDayFromCandles(payload.rows || []);
    const sorted = [...map.keys()].sort();
    for (const dk of sorted.slice(-65)) {
      engineState.orIvByDay.set(dk, map.get(dk));
      await persistOrHistory(dk, map.get(dk));
    }
    logEntry('OR_HISTORY_BACKFILLED', { days: engineState.orIvByDay.size });
  } catch (err) {
    engineState.lastError = `OR history backfill: ${err.message}`;
  }
}

function candleRefreshGapMs(clock) {
  return clock.minutes >= M945 - 15 && clock.minutes <= M1100 + 5
    ? CANDLE_REFRESH_FAST_GAP_MS
    : CANDLE_REFRESH_MIN_GAP_MS;
}

async function refreshTodayCandles(clock) {
  const now = Date.now();
  const gap = candleRefreshGapMs(clock);
  if (now - engineState.lastCandleFetchAt < gap && engineState.todayBars.length > 0) {
    return engineState.todayBars;
  }
  try {
    const { rows } = await fetchTradingDayCandles({
      symbol: engineState.symbol,
      interval: '5',
      dateKey: clock.dateKey,
    });
    engineState.todayBars = rows || [];
    engineState.lastCandleFetchAt = now;
    const todayOr = orIvProxyFromBars(engineState.todayBars);
    if (todayOr != null && todayOr > 0 && clock.minutes > M945) {
      engineState.orIvByDay.set(clock.dateKey, todayOr);
    }
    return engineState.todayBars;
  } catch (err) {
    engineState.lastError = `Today candles: ${err.message}`;
    return engineState.todayBars;
  }
}

function evaluateTodaySignal(clock) {
  const todayOr = orIvProxyFromBars(engineState.todayBars);
  if (todayOr != null && todayOr > 0) {
    engineState.orIvByDay.set(clock.dateKey, todayOr);
  }
  const sortedKeys = [...engineState.orIvByDay.keys()].sort();
  let idx = sortedKeys.indexOf(clock.dateKey);
  if (idx < 0) {
    sortedKeys.push(clock.dateKey);
    sortedKeys.sort();
    idx = sortedKeys.indexOf(clock.dateKey);
  }
  const { medianOrIv, sampleSize } = computeMedianOrIv(
    engineState.orIvByDay,
    sortedKeys,
    idx,
    engineState.settings.ivLookbackDays,
  );
  const spike = evaluateIvSpikeSignal({
    todayOr,
    medianOrIv,
    ivSpikeMultiplier: engineState.settings.ivSpikeMultiplier,
    maxSpikeMultiplier: engineState.settings.maxSpikeMultiplier,
  });
  engineState.todaySignal = {
    at: new Date().toISOString(),
    todayOr,
    medianOrIv,
    sampleSize,
    ...spike,
  };
  return engineState.todaySignal;
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
      engineState.lastError = `WS subscribe ${leg.optionType}: ${err.message}`;
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

async function syncEngineTradeStateFromDb(clock) {
  const openInDb = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  }).sort({ entryTime: -1 });

  if (openInDb) {
    const openId = openInDb._id.toString();
    if (engineState.openTradeId !== openId) {
      engineState.openTradeId = openId;
      engineState.tradeDateKey = openInDb.entryDateKey;
      await subscribeOpenStraddle(openInDb);
      startPositionPoll();
    }
    return;
  }

  if (engineState.openTradeId) clearOpenTrade();

  const tradedToday = await LivePaperTrade.exists({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  });
  if (tradedToday) {
    engineState.tradeDateKey = clock.dateKey;
    engineState.signalLockedForDay = true;
  } else if (engineState.tradeDateKey === clock.dateKey) {
    engineState.tradeDateKey = null;
  }
}

async function getEntryGate(clock) {
  if (!engineState.running) return { ok: false, reason: 'ENGINE_OFFLINE' };
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    if (isWeekendDateKey(clock.dateKey)) {
      return { ok: false, reason: 'MARKET_CLOSED_WEEKEND' };
    }
    return { ok: false, reason: 'MARKET_CLOSED_HOLIDAY', holiday: getNseHolidayDescription(clock.dateKey) };
  }
  await syncEngineTradeStateFromDb(clock);
  if (!isInEntryWindow(clock.minutes)) {
    return { ok: false, reason: 'OUTSIDE_ENTRY_WINDOW', minutes: clock.minutes };
  }
  if (engineState.tradeDateKey === clock.dateKey) {
    return { ok: false, reason: 'ALREADY_TRADED_TODAY' };
  }
  if (engineState.openTradeId) return { ok: false, reason: 'OPEN_TRADE_EXISTS' };
  if (!isAfterOrWindow(clock.minutes)) {
    return { ok: false, reason: 'BEFORE_OR_WINDOW_END' };
  }
  await refreshTodayCandles(clock);
  const signal = evaluateTodaySignal(clock);
  if (!signal.ok) {
    return { ok: false, reason: signal.reason, signal };
  }
  try {
    const expiry = await getCurrentExpiry(engineState.symbol, clock.dateKey);
    if (!expiry) return { ok: false, reason: 'NO_EXPIRY' };
  } catch (err) {
    return { ok: false, reason: 'EXPIRY_FETCH_FAILED', error: err.message };
  }
  return { ok: true, reason: 'READY_TO_ENTER', signal };
}

async function placeShortStraddle(clock) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await withRetry('ENTRY_STRADDLE', async () => {
      const symbol = engineState.symbol;
      const signal = engineState.todaySignal || evaluateTodaySignal(clock);
      if (!signal?.ok) {
        logEntry('ENTRY_ABORT_SIGNAL', { signal });
        return;
      }
      const expiry = await getCurrentExpiry(symbol, clock.dateKey);
      const chainForSpot = await getAtmPremiums({ symbol, strike: 0, expiry });
      const spot = Number(chainForSpot.chainSpot || chainForSpot.spot);
      if (!Number.isFinite(spot) || spot <= 0) {
        throw new Error('Live spot unavailable');
      }
      const strikeStep = getStrikeStep(symbol);
      const strike = Math.round(spot / strikeStep) * strikeStep;
      const premiums = await getAtmPremiums({ symbol, strike, expiry });
      const ceEntry = Number(premiums.ceLtp);
      const peEntry = Number(premiums.peLtp);
      if (!Number.isFinite(ceEntry) || ceEntry <= 0 || !Number.isFinite(peEntry) || peEntry <= 0) {
        throw new Error(`Missing CE/PE LTP for strike ${strike}`);
      }

      const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
      engineState.lotSize = lotSize;
      const lots = engineState.settings.lotCount;
      const qty = lotSize * lots;
      const entryCredit = ceEntry + peEntry;
      const { targetPremium, stopLossPremium } = premiumTargetsFromCredit(entryCredit, engineState.settings);
      const charges = engineState.settings.perTradeCost;
      const marginBlocked = shortStraddleMarginBlocked({
        entrySpot: spot,
        lotSize,
        lotCount: lots,
        settings: engineState.settings,
      });

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
        entryIvProxy: Number(signal.todayOr?.toFixed(2)) || null,
        medianIvProxy: Number(signal.medianOrIv?.toFixed(2)) || null,
        highSinceEntry: Number(spot.toFixed(2)),
        lowSinceEntry: Number(spot.toFixed(2)),
        stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
        targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
        status: 'OPEN',
        investedAmount: Number(marginBlocked.toFixed(2)),
        creditReceived: Number((entryCredit * qty).toFixed(2)),
        charges: Number(charges.toFixed(2)),
        legs: [
          { optionType: 'CE', entryPremium: Number(ceEntry.toFixed(2)) },
          { optionType: 'PE', entryPremium: Number(peEntry.toFixed(2)) },
        ],
        notes: `ivLive; spike=${signal.reason}`,
      });

      engineState.openTradeId = tradeDoc._id.toString();
      engineState.tradeDateKey = clock.dateKey;
      engineState.signalLockedForDay = true;
      engineState.lastSpot = spot;
      engineState.lastSignalAt = new Date();
      logEntry('ENTRY_SUCCESS', {
        ist: istClockLabel(clock),
        tradeId: tradeDoc._id.toString(),
        strike,
        entryCredit,
        todayOr: signal.todayOr,
        medianOrIv: signal.medianOrIv,
      });
      await subscribeOpenStraddle(tradeDoc);
      startPositionPoll();
    });
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), error: err.message });
  } finally {
    engineState.enteringTrade = false;
  }
}

async function evaluateEntry() {
  const clock = getIstClock(new Date());
  if (!engineState.running) return;
  if (clock.minutes < M1000 - 30) return;
  const gate = await getEntryGate(clock);
  if (!gate.ok) {
    if (isInEntryWindow(clock.minutes)) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), ...gate });
    }
    return;
  }
  logEntry('ENTRY_TRIGGER', { ist: istClockLabel(clock), ...gate });
  await placeShortStraddle(clock);
}

async function updateSpotExtremes(trade, spot) {
  if (!Number.isFinite(spot)) return;
  let hi = Number(trade.highSinceEntry);
  let lo = Number(trade.lowSinceEntry);
  if (!Number.isFinite(hi)) hi = spot;
  if (!Number.isFinite(lo)) lo = spot;
  hi = Math.max(hi, spot);
  lo = Math.min(lo, spot);
  if (hi !== trade.highSinceEntry || lo !== trade.lowSinceEntry) {
    trade.highSinceEntry = Number(hi.toFixed(2));
    trade.lowSinceEntry = Number(lo.toFixed(2));
    await trade.save();
  }
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  if (!engineState.running || engineState.closingTrade) return;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return;

  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    return;
  }

  if (clock.dateKey !== trade.entryDateKey) {
    await finalizeTrade(trade, {
      exitCombined: null,
      mark: { spot: trade.entrySpot, combined: null },
      reason: 'DAY_CLOSE',
      forceChain: true,
    });
    return;
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: !preferTicks && !optionTicksAreFresh(),
  });
  if (Number.isFinite(mark.spot)) {
    engineState.lastSpot = mark.spot;
    await updateSpotExtremes(trade, mark.spot);
  }
  engineState.openPositionMark = buildOpenPositionMark(trade, mark, clock);

  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const combined = Number(mark.combined);
  if (!Number.isFinite(combined) || combined <= 0) return;

  if (
    engineState.settings.hasPremiumTarget
    && trade.targetPremium != null
    && combined <= trade.targetPremium
  ) {
    await finalizeTrade(trade, { exitCombined: trade.targetPremium, mark, reason: 'TARGET' });
    return;
  }

  const postRange = postEntrySpotRange(trade.entrySpot, trade.highSinceEntry, trade.lowSinceEntry);
  const entryIv = Number(trade.entryIvProxy) || 0;
  const expandMult = Number(engineState.settings.ivExpandStopMult) || 1.5;
  if (entryIv > 0 && postRange != null && postRange >= entryIv * expandMult) {
    await finalizeTrade(trade, { exitCombined: combined, mark, reason: 'IV_EXPAND' });
    return;
  }

  if (
    engineState.settings.hasPremiumStop
    && trade.stopLossPremium != null
    && combined >= trade.stopLossPremium
  ) {
    await finalizeTrade(trade, { exitCombined: trade.stopLossPremium, mark, reason: 'STOP_LOSS' });
    return;
  }

  if (isEodExitTime(clock.minutes)) {
    await finalizeTrade(trade, { exitCombined: combined, mark, reason: 'DAY_CLOSE' });
  }
}

async function finalizeTrade(trade, { exitCombined, mark, reason, forceChain = false }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  try {
    await withRetry('EXIT_STRADDLE', async () => {
      let resolvedMark = mark;
      if (forceChain || !Number.isFinite(mark?.combined)) {
        resolvedMark = await resolveMarkForOpenTrade(trade, { allowChain: true });
      }
      const safeExitCombined = Math.max(
        0.05,
        Number(exitCombined) || Number(resolvedMark?.combined) || 0.05,
      );
      const exitDebit = safeExitCombined * trade.qty;
      const credit = (Number(trade.entryCredit) || Number(trade.entryPremium) || 0) * trade.qty;
      const charges = Math.max(0, Number(trade.charges) || 0);
      const rawPnl = credit - exitDebit;
      const pnl = rawPnl - charges;
      const clock = getIstClock(new Date());

      trade.status = 'CLOSED';
      trade.exitPremium = Number(safeExitCombined.toFixed(2));
      trade.exitDebit = Number(safeExitCombined.toFixed(2));
      trade.exitSpot = Number(Number(resolvedMark?.spot || engineState.lastSpot || trade.entrySpot).toFixed(2));
      trade.exitTime = new Date();
      trade.exitDateKey = clock.dateKey;
      trade.reason = reason;
      trade.finalValue = Number(exitDebit.toFixed(2));
      trade.pnl = Number(pnl.toFixed(2));
      const marginBlocked = Number(trade.investedAmount) || 0;
      trade.pnlPct = marginBlocked > 0 ? Number(((pnl / marginBlocked) * 100).toFixed(2)) : 0;
      await trade.save();

      const wallet = await ensureWallet();
      wallet.balance += pnl;
      wallet.realizedPnl += pnl;
      wallet.totalTrades += 1;
      if (pnl > 0) wallet.wins += 1;
      else if (pnl < 0) wallet.losses += 1;
      await wallet.save();

      const todayOr = orIvProxyFromBars(engineState.todayBars);
      if (todayOr != null && todayOr > 0) {
        await persistOrHistory(clock.dateKey, todayOr);
      }

      logEntry('EXIT_SUCCESS', {
        ist: istClockLabel(clock),
        tradeId: trade._id.toString(),
        reason,
        pnl,
        exitCombined: safeExitCombined,
      });
      clearOpenTrade();
    });
  } catch (err) {
    engineState.lastError = `Exit failed (will retry): ${err.message}`;
    logEntry('EXIT_FAILED', { tradeId: trade._id?.toString(), error: err.message });
  } finally {
    engineState.closingTrade = false;
  }
}

async function onOptionTick(optionType, { ltp }) {
  engineState.lastOptionTicks[optionType] = { ltp: Number(ltp), ts: Date.now() };
  await checkOpenTrade({ preferTicks: true });
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
      engineState.lastError = `Position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = async () => {
    const clock = getIstClock(new Date());
    try {
      if (clock.minutes >= M945 - 15 && clock.minutes <= M1100 + 5) {
        await refreshTodayCandles(clock);
      }
      if (
        isAfterOrWindow(clock.minutes)
        && isInEntryWindow(clock.minutes)
        && engineState.tradeDateKey !== clock.dateKey
      ) {
        evaluateTodaySignal(clock);
      }
      await evaluateEntry();
      await checkOpenTrade();
    } catch (err) {
      engineState.lastError = `Poll: ${err.message}`;
    }
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  engineState.settings = normalizeIvSettings({ ...engineState.settings, ...settings });
  engineState.symbol = String(symbol).toUpperCase();
  if (engineState.running) {
    logEntry('ENGINE_ALREADY_RUNNING');
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.lastError = null;
  engineState.todayBars = [];
  engineState.todaySignal = null;
  engineState.signalLockedForDay = false;
  logEntry('ENGINE_START', { symbol: engineState.symbol, settings: engineState.settings });
  try {
    await loadOrHistoryFromWallet();
    await backfillOrHistoryIfNeeded();
    engineState.lotSize = await getCurrentLotSize(engineState.symbol);
    const clock = getIstClock(new Date());
    engineState.expiry = engineState.settings.skipExpiryDay
      ? await getTradableWeeklyExpiry(engineState.symbol, clock.dateKey)
      : await getNearestWeeklyExpiry(engineState.symbol);
    const orphan = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
      entryTime: -1,
    });
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.tradeDateKey = orphan.entryDateKey;
      await subscribeOpenStraddle(orphan);
      startPositionPoll();
    }
  } catch (err) {
    engineState.lastError = `Setup: ${err.message}`;
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
  stopPositionPoll();
  engineState.running = false;
  engineState.startedAt = null;
  logEntry('ENGINE_STOP');
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  engineState.settings = normalizeIvSettings({ ...engineState.settings, ...partial });
  try {
    const wallet = await ensureWallet();
    wallet.strategy3EngineSettings = engineState.settings;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Settings persist: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy3EngineSettings
      ? wallet.strategy3EngineSettings.toObject?.() || wallet.strategy3EngineSettings
      : {};
    return startEngine({ symbol, settings: persisted });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Keeps paper-live running whenever the backend is up (idempotent). */
async function ensureEngineRunning() {
  if (engineState.running) {
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  return bootEngineFromDb();
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
    todaySignal: engineState.todaySignal,
    orHistoryDays: engineState.orIvByDay.size,
    signalLockedForDay: engineState.signalLockedForDay,
  };
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({ exitTime: { $ne: null } }).lean();
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

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  bootEngineFromDb,
  ensureEngineRunning,
  getEngineSnapshot,
  ensureWallet,
  recalcWalletFromTrades,
};

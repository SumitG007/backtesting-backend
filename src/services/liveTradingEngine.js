const axios = require('axios');
const LiveWallet = require('../models/liveWallet');
const LivePaperTrade = require('../models/livePaperTrade');
const {
  getIstClock,
  parseClockMinutes,
  normalizeTimestamp,
  toIntradayDateTime,
} = require('../utils/dateTime');
const { getStrikeStep, resolveSymbolConfig } = require('../utils/market');
const {
  readLatestAccessToken,
  isLikelyDhanAuthError,
  ensureValidDhanAccessToken,
} = require('./tokenService');
const {
  subscribeLiveSymbol,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getAtmPremiums,
  resolveOptionInstrument,
} = require('./dhanLiveService');

const SUBSCRIPTION_KEY = 'engine:strategy2';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy2:option';
const CANDLE_POLL_INTERVAL_MS = 30000;
/** How often we re-check option LTP vs target / premium-cap while a position is open (Dhan chain ~1/3s). */
const OPTION_POSITION_POLL_MS = 3200;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  // Strategy 2 settings (mirror backtest exactly)
  settings: {
    lotCount: 1,
    confirmationCandles: 3,
    confirmationWindow: 2,
    breakoutBufferPct: 0.08,
    minRefRangePct: 0.15,
    premiumStopLossCapPct: 3,
    targetPct: 12,
    maxTradesPerDay: 2,
    perTradeCost: 100,
    entryFromTime: '09:30',
    entryToTime: '14:00',
  },
  lotSize: 75,
  expiry: null,
  todayDateKey: null,
  // Today's REAL 15m candles from Dhan REST (matches backtest source-of-truth)
  todayCandles: [],
  lastConfirmIndexToday: -1,
  // Index of the latest finalized candle present when the engine started today.
  // Signals at confirmation index <= this boundary are considered historical and ignored.
  bootBoundaryConfirmIndex: -1,
  tradesToday: 0,
  // Last live tick from WebSocket (used for instant SL/Target/DayClose detection)
  lastTick: null,
  optionPositionPollTimer: null,
  // Open trade tracking
  openTradeId: null,
  openStopSpot: null,
  openSide: null,
  openTargetPremium: null,
  openStopLossPremium: null,
  closingTrade: false,
  // Diagnostics
  lastSignalAt: null,
  lastError: null,
  pollTimer: null,
  chainPollAt: 0,
};

// ----------------- VWAP -----------------

function computeVwapInPlace(candles) {
  // Mirror backtest's calculateVwap including the no-volume fallback.
  let cumPv = 0;
  let cumVol = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    const vol = Math.max(0, Number(c.vol) || 0);
    cumPv += tp * vol;
    cumVol += vol;
    if (cumVol > 0) {
      c.vwap = cumPv / cumVol;
    } else {
      const prev = i > 0 && Number.isFinite(candles[i - 1].vwap) ? candles[i - 1].vwap : tp;
      c.vwap = (prev * i + tp) / (i + 1);
    }
  }
}

// ----------------- Dhan 15m candle fetcher (source of truth, same as backtest) -----------------

async function fetchTodayCandles(symbol) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for candle fetch');
  }
  const clientId = process.env.DHAN_CLIENT_ID;
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const istNow = getIstClock(new Date());
  const today = istNow.dateKey;
  const body = {
    securityId: resolved.securityId,
    exchangeSegment: resolved.exchangeSegment,
    instrument: resolved.instrument,
    interval: '15',
    oi: false,
    fromDate: toIntradayDateTime(today, false),
    toDate: toIntradayDateTime(today, true),
  };
  const base = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(`${base}/charts/intraday`, body, { headers, timeout: 15000 });
    return { raw: resp.data || {}, today };
  } catch (err) {
    if (isLikelyDhanAuthError(err)) {
      const renewed = await ensureValidDhanAccessToken('live-candles');
      const retry = await axios.post(
        `${base}/charts/intraday`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: 15000 }
      );
      return { raw: retry.data || {}, today };
    }
    throw err;
  }
}

async function refreshTodayCandles() {
  try {
    const { raw, today } = await fetchTodayCandles(engineState.symbol);
    const ts = raw.timestamp || [];
    const opens = raw.open || [];
    const highs = raw.high || [];
    const lows = raw.low || [];
    const closes = raw.close || [];
    const vols = raw.volume || [];

    const out = [];
    for (let i = 0; i < ts.length; i += 1) {
      const dt = normalizeTimestamp(ts[i]);
      const clock = getIstClock(dt);
      if (clock.dateKey !== today) continue;
      if (clock.minutes < 555 || clock.minutes > 930) continue;
      out.push({
        ts: dt,
        bucketStart: clock.minutes,
        dateKey: clock.dateKey,
        open: Number(opens[i]),
        high: Number(highs[i]),
        low: Number(lows[i]),
        close: Number(closes[i]),
        vol: Number(vols[i] ?? 0),
        vwap: null,
      });
    }

    // The candle for the currently-active 15m bucket may be partial — drop it for signal logic.
    const nowClock = getIstClock(new Date());
    const liveBucketStart = 555 + Math.max(0, Math.floor((nowClock.minutes - 555) / 15)) * 15;
    const finalized = out.filter((c) => !(c.dateKey === nowClock.dateKey && c.bucketStart === liveBucketStart));

    computeVwapInPlace(finalized);

    // Reset day trackers when date changes
    if (engineState.todayDateKey !== today) {
      engineState.todayDateKey = today;
      engineState.tradesToday = 0;
      engineState.lastConfirmIndexToday = -1;
      // New day starts fresh — any candle that already closed is historical to live trading.
      engineState.bootBoundaryConfirmIndex = finalized.length - 1;
    }
    engineState.todayCandles = finalized;
  } catch (err) {
    engineState.lastError = `Candle poll failed: ${err.message}`;
  }
}

// ----------------- Entry Signal (matches runStrategyConfirmationBreakout exactly) -----------------

async function evaluateEntrySignal() {
  if (engineState.openTradeId) return;
  if (engineState.tradesToday >= engineState.settings.maxTradesPerDay) return;
  const candles = engineState.todayCandles;
  const s = engineState.settings;
  const confirmationCandles = Math.max(1, Number(s.confirmationCandles) || 3);
  const confirmationWindow = Math.max(1, Number(s.confirmationWindow) || 2);
  const breakoutBufferPct = Math.max(0, Number(s.breakoutBufferPct) || 0.08);
  const minRefRangePct = Math.max(0.01, Number(s.minRefRangePct) || 0.15);
  const entryFromMin = parseClockMinutes(s.entryFromTime, 570);
  const entryToMin = parseClockMinutes(s.entryToTime, 840);
  const fromMin = Math.min(entryFromMin, entryToMin);
  const toMin = Math.max(entryFromMin, entryToMin);

  if (candles.length <= confirmationCandles + 1) return;

  const minConfirmIndex = Math.max(
    engineState.bootBoundaryConfirmIndex,
    engineState.lastConfirmIndexToday
  );

  for (let i = 0; i < candles.length - confirmationCandles; i += 1) {
    if (candles[i].bucketStart < fromMin || candles[i].bucketStart > toMin) continue;
    if (i + 1 >= candles.length) break;

    const ref1 = candles[i];
    const ref2 = candles[i + 1];
    const refHigh = Math.max(ref1.high, ref2.high);
    const refLow = Math.min(ref1.low, ref2.low);
    if (!Number.isFinite(refHigh) || !Number.isFinite(refLow) || refHigh <= refLow) continue;
    const refRangePct = ((refHigh - refLow) / Math.max(1, ref1.close)) * 100;
    if (refRangePct < minRefRangePct) continue;

    const confirmStart = i + 1 + confirmationCandles;
    const confirmEnd = Math.min(candles.length - 1, confirmStart + confirmationWindow - 1);
    let setup = null;
    let confirmationIndex = null;
    for (let k = confirmStart; k <= confirmEnd; k += 1) {
      if (k <= minConfirmIndex) continue;
      if (candles[k].bucketStart > toMin) break;
      const close = candles[k].close;
      const bufferUp = refHigh * (1 + breakoutBufferPct / 100);
      const bufferDown = refLow * (1 - breakoutBufferPct / 100);
      const vwapValue = candles[k].vwap;
      const bullishTrendOkay = Number.isFinite(vwapValue) ? close > vwapValue : true;
      const bearishTrendOkay = Number.isFinite(vwapValue) ? close < vwapValue : true;
      if (close > bufferUp && bullishTrendOkay) {
        setup = { side: 'LONG', optionType: 'CE', stopSpot: refLow };
        confirmationIndex = k;
        break;
      }
      if (close < bufferDown && bearishTrendOkay) {
        setup = { side: 'SHORT', optionType: 'PE', stopSpot: refHigh };
        confirmationIndex = k;
        break;
      }
    }
    if (!setup || confirmationIndex == null) continue;

    const confirmCandle = candles[confirmationIndex];
    const entrySpot = confirmCandle.close;
    await placePaperTrade({
      side: setup.side,
      optionType: setup.optionType,
      stopSpot: setup.stopSpot,
      refHigh,
      refLow,
      confirmationIndex,
      entrySpot,
      entryTs: confirmCandle.ts,
    });
    return;
  }
}

async function placePaperTrade({
  side,
  optionType,
  stopSpot,
  refHigh,
  refLow,
  confirmationIndex,
  entrySpot,
  entryTs,
}) {
  try {
    const symbol = engineState.symbol;
    const strikeStep = getStrikeStep(symbol);
    const strike = Math.round(entrySpot / strikeStep) * strikeStep;
    const expiry = engineState.expiry || (await getNearestWeeklyExpiry(symbol));
    engineState.expiry = expiry;

    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = optionType === 'CE' ? Number(premiums.ceLtp) : Number(premiums.peLtp);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `No live ${optionType} premium for strike ${strike} expiry ${expiry}`;
      return;
    }
    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 1);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;

    const targetPct = Number.isFinite(Number(engineState.settings.targetPct))
      ? Math.max(0.5, Number(engineState.settings.targetPct))
      : 12;
    const premiumStopLossCapPct = Math.max(0.5, Number(engineState.settings.premiumStopLossCapPct) || 3);
    const rawPerTradeCost = Number(engineState.settings.perTradeCost);
    const perTradeCost = Number.isFinite(rawPerTradeCost) && rawPerTradeCost >= 0 ? rawPerTradeCost : 100;
    const targetPremium = entryPremium * (1 + targetPct / 100);
    const stopLossPremium = Math.max(0.05, entryPremium * (1 - premiumStopLossCapPct / 100));

    // Real broker-style execution timestamp (sub-second precision). The candle that
    // triggered the entry is preserved in `notes` for audit.
    const executedAt = new Date();
    const candleTsIso = (() => {
      try {
        const d = entryTs instanceof Date ? entryTs : new Date(entryTs);
        return Number.isFinite(d.getTime()) ? d.toISOString() : String(entryTs);
      } catch (_e) {
        return String(entryTs);
      }
    })();

    const tradeDoc = await LivePaperTrade.create({
      strategyKey: 'strategy2_confirmation_breakout',
      symbol,
      side,
      optionType,
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number(entrySpot.toFixed(2)),
      entryTime: executedAt,
      stopLossPremium: Number(stopLossPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      refHigh: Number(refHigh.toFixed(2)),
      refLow: Number(refLow.toFixed(2)),
      status: 'OPEN',
      investedAmount: Number(invested.toFixed(2)),
      charges: Number(perTradeCost.toFixed(2)),
      notes: `stopSpot=${Number(stopSpot).toFixed(2)}; capPct=${premiumStopLossCapPct}; targetPct=${targetPct}; confirmCandle=${candleTsIso}`,
    });
    engineState.openTradeId = tradeDoc._id.toString();
    engineState.openStopSpot = Number(stopSpot);
    engineState.openSide = side;
    engineState.openTargetPremium = Number(tradeDoc.targetPremium);
    engineState.openStopLossPremium = Number(tradeDoc.stopLossPremium);
    engineState.tradesToday += 1;
    engineState.lastConfirmIndexToday = confirmationIndex;
    engineState.lastSignalAt = new Date();
    await subscribeOpenOptionTrade(tradeDoc);
    startOptionPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
  }
}

async function subscribeOpenOptionTrade(trade) {
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType: trade.optionType,
    });
    subscribeLiveInstrument({
      key: OPTION_SUBSCRIPTION_KEY,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: onOptionTick,
    });
  } catch (err) {
    engineState.lastError = `Option WS subscribe failed: ${err.message}`;
  }
}

async function onOptionTick({ ltp, ltt }) {
  if (!engineState.running || !engineState.openTradeId || engineState.closingTrade) return;
  const optionPremium = Number(ltp);
  if (!Number.isFinite(optionPremium) || optionPremium <= 0) return;

  const targetPremium = Number(engineState.openTargetPremium);
  if (Number.isFinite(targetPremium) && optionPremium >= targetPremium) {
    await closeOpenTradeAtOptionPremium({
      reason: 'TARGET',
      optionPremium: targetPremium,
      ts: ltt ? new Date(ltt * 1000) : new Date(),
    });
    return;
  }

  const stopLossPremium = Number(engineState.openStopLossPremium);
  if (Number.isFinite(stopLossPremium) && optionPremium <= stopLossPremium) {
    await closeOpenTradeAtOptionPremium({
      reason: 'STOP_LOSS_PREMIUM_CAP',
      optionPremium: stopLossPremium,
      ts: ltt ? new Date(ltt * 1000) : new Date(),
    });
  }
}

// ----------------- Live tick handler (SL via spot crossing, instant) -----------------

async function onLiveTick({ ltp, ltt }) {
  if (!engineState.running) return;
  const tickDate = ltt ? new Date(ltt * 1000) : new Date();
  const clock = getIstClock(tickDate);
  // Allow ticks during market session 09:15 - 15:30 IST
  if (clock.minutes < 555 || clock.minutes > 935) return;
  engineState.lastTick = { ltp, ts: tickDate.getTime() };

  if (!engineState.openTradeId) return;

  // Stop-loss trigger #1: live spot crosses the structural stopSpot (matches backtest exactly)
  const stopSpot = engineState.openStopSpot;
  const side = engineState.openSide;
  if (Number.isFinite(stopSpot)) {
    const stopHit = side === 'LONG' ? ltp <= stopSpot : ltp >= stopSpot;
    if (stopHit) {
      await closeOpenTrade({ reason: 'STOP_LOSS', spot: ltp, ts: tickDate });
      return;
    }
  }

  // Day-close at 15:30 IST
  if (clock.minutes >= 930) {
    await closeOpenTrade({ reason: 'DAY_CLOSE', spot: ltp, ts: tickDate });
    return;
  }
}

async function checkPremiumExits({ spot, ts }) {
  if (engineState.closingTrade) return;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.status === 'CLOSED') {
    clearOpenTrade();
    return;
  }
  let chain = null;
  try {
    chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
  } catch (err) {
    engineState.lastError = `Option chain refresh: ${err.message}`;
    return;
  }
  const spotForExit =
    Number.isFinite(Number(spot)) && Number(spot) > 0 ? Number(spot) : Number(chain.chainSpot);

  const markHigh = trade.optionType === 'CE' ? chain.ceMarkHigh : chain.peMarkHigh;
  const markLow = trade.optionType === 'CE' ? chain.ceMarkLow : chain.peMarkLow;

  if (Number.isFinite(markHigh) && markHigh >= trade.targetPremium) {
    await finalizeTrade(trade, {
      exitPremium: trade.targetPremium,
      exitSpot: spotForExit,
      ts,
      reason: 'TARGET',
    });
    return;
  }
  if (Number.isFinite(markLow) && markLow <= trade.stopLossPremium) {
    await finalizeTrade(trade, {
      exitPremium: trade.stopLossPremium,
      exitSpot: spotForExit,
      ts,
      reason: 'STOP_LOSS_PREMIUM_CAP',
    });
  }
}

async function closeOpenTrade({ reason, spot, ts }) {
  if (engineState.closingTrade) return;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.status === 'CLOSED') {
    clearOpenTrade();
    return;
  }
  let exitPremium = trade.entryPremium;
  try {
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const ltp = trade.optionType === 'CE' ? Number(chain.ceLtp) : Number(chain.peLtp);
    if (Number.isFinite(ltp) && ltp > 0) exitPremium = ltp;
  } catch (err) {
    engineState.lastError = `Exit chain fetch: ${err.message}`;
  }
  // For STOP_LOSS via spot trigger: floor the exit at stopLossPremium to cap recorded loss
  // (mirrors backtest's `Math.max(cappedStopPremium, structureStopPremium)` semantics).
  if (reason === 'STOP_LOSS') {
    exitPremium = Math.max(exitPremium, trade.stopLossPremium);
  }
  await finalizeTrade(trade, { exitPremium, exitSpot: spot, ts, reason });
}

async function closeOpenTradeAtOptionPremium({ reason, optionPremium, ts }) {
  if (engineState.closingTrade) return;
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.status === 'CLOSED') {
    clearOpenTrade();
    return;
  }
  const spot = Number.isFinite(Number(engineState.lastTick?.ltp)) ? engineState.lastTick.ltp : trade.entrySpot;
  await finalizeTrade(trade, { exitPremium: optionPremium, exitSpot: spot, ts, reason });
}

async function finalizeTrade(trade, { exitPremium, exitSpot, ts, reason }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  const safeExitPremium = Math.max(0, Number(exitPremium) || 0);
  try {
    const finalValue = safeExitPremium * trade.qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const pnl = finalValue - trade.investedAmount - charges;
    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExitPremium.toFixed(2));
    trade.exitSpot = Number(Number(exitSpot).toFixed(2));
    trade.exitTime = ts;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.charges = Number(charges.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    trade.pnlPct = trade.investedAmount > 0
      ? Number(((pnl / trade.investedAmount) * 100).toFixed(2))
      : 0;
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
  stopOptionPositionPoll();
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.openStopSpot = null;
  engineState.openSide = null;
  engineState.openTargetPremium = null;
  engineState.openStopLossPremium = null;
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: 'default' });
  if (!wallet) {
    wallet = await LiveWallet.create({ walletKey: 'default' });
  }
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

// ----------------- Engine lifecycle -----------------

function stopOptionPositionPoll() {
  if (engineState.optionPositionPollTimer) {
    clearInterval(engineState.optionPositionPollTimer);
    engineState.optionPositionPollTimer = null;
  }
}

function startOptionPositionPoll() {
  stopOptionPositionPoll();
  if (!engineState.openTradeId) return;
  const tick = () => {
    if (!engineState.running || !engineState.openTradeId) return;
    const st = engineState.lastTick;
    checkPremiumExits({
      spot: Number.isFinite(st?.ltp) ? st.ltp : null,
      ts: new Date(),
    }).catch((e) => {
      console.error('[LiveEngine] checkPremiumExits:', e.message);
    });
  };
  tick();
  engineState.optionPositionPollTimer = setInterval(tick, OPTION_POSITION_POLL_MS);
}

function startCandlePoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  engineState.pollTimer = setInterval(async () => {
    if (!engineState.running) return;
    await refreshTodayCandles();
    await evaluateEntrySignal();
  }, CANDLE_POLL_INTERVAL_MS);
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  if (engineState.running) {
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = { ...engineState.settings, ...settings };
  engineState.lastError = null;
  try {
    engineState.lotSize = await getCurrentLotSize(engineState.symbol);
    engineState.expiry = await getNearestWeeklyExpiry(engineState.symbol);
  } catch (err) {
    engineState.lastError = `Setup: ${err.message}`;
  }
  subscribeLiveSymbol({ key: SUBSCRIPTION_KEY, symbol: engineState.symbol, onTick: onLiveTick });
  engineState.running = true;
  engineState.startedAt = new Date();
  engineState.todayCandles = [];
  engineState.todayDateKey = null;
  engineState.tradesToday = 0;
  engineState.lastConfirmIndexToday = -1;
  engineState.bootBoundaryConfirmIndex = -1;

  // Adopt any orphan OPEN trades from a previous process so they continue to be managed.
  try {
    const orphan = await LivePaperTrade.findOne({ status: 'OPEN' }).sort({ entryTime: -1 });
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      engineState.openSide = orphan.side;
      engineState.openStopSpot = orphan.side === 'LONG' ? orphan.refLow : orphan.refHigh;
      engineState.openTargetPremium = Number(orphan.targetPremium);
      engineState.openStopLossPremium = Number(orphan.stopLossPremium);
      await subscribeOpenOptionTrade(orphan);
      console.log(
        `[LiveEngine] adopted orphan open trade ${orphan._id} (${orphan.side} ${orphan.optionType} ${orphan.strike})`
      );
    }
  } catch (err) {
    engineState.lastError = `Adopt orphan failed: ${err.message}`;
  }
  if (engineState.openTradeId) {
    startOptionPositionPoll();
  }

  // Initial poll: hydrate today's candles AND set the boundary so historical signals
  // (those that already happened before the engine started) are skipped.
  refreshTodayCandles()
    .then(() => {
      engineState.bootBoundaryConfirmIndex = engineState.todayCandles.length - 1;
      return evaluateEntrySignal();
    })
    .catch((err) => {
      engineState.lastError = err.message;
    });
  startCandlePoll();
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  unsubscribeLiveSymbol(SUBSCRIPTION_KEY);
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  stopOptionPositionPoll();
  if (engineState.pollTimer) {
    clearInterval(engineState.pollTimer);
    engineState.pollTimer = null;
  }
  engineState.running = false;
  engineState.startedAt = null;
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  const allowed = [
    'lotCount',
    'premiumStopLossCapPct',
    'targetPct',
    'maxTradesPerDay',
    'perTradeCost',
    'entryFromTime',
    'entryToTime',
  ];
  const next = { ...engineState.settings };
  for (const key of allowed) {
    if (partial[key] !== undefined && partial[key] !== null && partial[key] !== '') {
      next[key] = partial[key];
    }
  }
  engineState.settings = next;
  try {
    const wallet = await ensureWallet();
    const persisted = {};
    for (const key of allowed) persisted[key] = next[key];
    wallet.engineSettings = persisted;
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Failed to persist settings: ${err.message}`;
  }
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.engineSettings
      ? wallet.engineSettings.toObject?.() || wallet.engineSettings
      : {};
    return startEngine({ symbol, settings: persisted });
  } catch (err) {
    engineState.lastError = `Boot start failed: ${err.message}`;
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
    lastTick: engineState.lastTick,
    todayCandleCount: engineState.todayCandles.length,
    todayDateKey: engineState.todayDateKey,
    tradesToday: engineState.tradesToday,
    lastConfirmIndexToday: engineState.lastConfirmIndexToday,
    bootBoundaryConfirmIndex: engineState.bootBoundaryConfirmIndex,
    openTradeId: engineState.openTradeId,
    openStopSpot: engineState.openStopSpot,
    openSide: engineState.openSide,
    lastSignalAt: engineState.lastSignalAt,
    lastError: engineState.lastError,
  };
}

module.exports = {
  startEngine,
  stopEngine,
  updateEngineSettings,
  bootEngineFromDb,
  getEngineSnapshot,
  ensureWallet,
};

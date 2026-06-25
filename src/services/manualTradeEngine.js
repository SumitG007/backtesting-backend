/**
 * Personal manual trading console — paper long CE/PE with market/limit entry,
 * optional SL/target, EOD exit, action logging.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const ManualPendingOrder = require('../models/manualPendingOrder');
const ManualTradeAction = require('../models/manualTradeAction');
const { MANUAL_CONSOLE_LIVE_KEY } = require('../strategies/keys');
const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const { getStrikeStep } = require('../utils/market');
const { pickStrike } = require('../strategies/shared/intradayOptions');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  fetchExpiryList,
  fetchOptionChainCached,
} = require('./dhanLiveService');

const STRATEGY_KEY = MANUAL_CONSOLE_LIVE_KEY;
const WALLET_KEY = 'paper_live_manual';
const POLL_INTERVAL_MS = 5000;
const EOD_EXIT = 920; // 15:20 IST
const MIN_HOLD_MS = 5000;
const ALLOWED_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY']);

const engineState = {
  running: false,
  startedAt: null,
  lastError: null,
  lastPollAt: null,
  pollTimer: null,
};

function istLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function isEodExitTime(minutes) {
  return minutes >= EOD_EXIT;
}

function normalizeSymbol(symbol) {
  const s = String(symbol || 'NIFTY').toUpperCase();
  if (!ALLOWED_SYMBOLS.has(s)) {
    throw new Error('Symbol must be NIFTY or BANKNIFTY');
  }
  return s;
}

function normalizeOptionType(optionType) {
  const t = String(optionType || 'CE').toUpperCase();
  if (t !== 'CE' && t !== 'PE') throw new Error('optionType must be CE or PE');
  return t;
}

function parsePremiumPoints(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(5000, n);
}

function premiumFromChain(chain, optionType) {
  const type = normalizeOptionType(optionType);
  const ltp = type === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

function atmStrikeFromSpot(spot, symbol) {
  const step = getStrikeStep(symbol);
  return Math.round(Number(spot) / step) * step;
}

async function logAction({ action, tradeId = null, orderId = null, symbol = null, message = null, details = null }) {
  try {
    await ManualTradeAction.create({
      strategyKey: STRATEGY_KEY,
      action,
      tradeId,
      orderId,
      symbol,
      message,
      details,
    });
  } catch (err) {
    engineState.lastError = `Action log failed: ${err.message}`;
  }
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) wallet = await LiveWallet.create({ walletKey: WALLET_KEY });
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of closed) {
    const pnl = Number(t.pnl);
    if (!Number.isFinite(pnl)) continue;
    realizedPnl += pnl;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = closed.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return wallet;
}

async function assertMarketOpen(clock) {
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    if (isWeekendDateKey(clock.dateKey)) {
      throw new Error('Market closed — weekend');
    }
    const holiday = getNseHolidayDescription(clock.dateKey);
    throw new Error(holiday ? `Market closed — ${holiday}` : 'Market closed — NSE holiday');
  }
  if (isEodExitTime(clock.minutes)) {
    throw new Error('New entries blocked after 15:20 IST');
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryPremium = Number(trade.entryPremium) || 0;
  const optionLtp = Number(mark?.optionLtp) || 0;
  const qty = Number(trade.qty) || 0;
  const invested = entryPremium * qty;
  const finalValue = optionLtp * qty;
  const grossPnl = finalValue - invested;
  const source = mark?.source || 'chain';
  const optionType = normalizeOptionType(trade.optionType);

  return {
    at: new Date().toISOString(),
    source,
    isLiveMark: source === 'chain' || source === 'websocket',
    priceSourceLabel: source === 'chain' ? 'LIVE' : 'STALE',
    optionType,
    optionLtp: Number.isFinite(optionLtp) ? Number(optionLtp.toFixed(2)) : null,
    entryPremium: Number(entryPremium.toFixed(2)),
    investedAmount: Number(invested.toFixed(2)),
    currentValue: Number(finalValue.toFixed(2)),
    grossPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnlPct: invested > 0 ? Number(((grossPnl / invested) * 100).toFixed(2)) : 0,
    stopLossPremium: trade.stopLossPremium,
    targetPremium: trade.targetPremium,
    spot: Number.isFinite(mark?.spot) ? Number(mark.spot.toFixed(2)) : null,
    isProfitable: grossPnl > 0,
    phase: clock.dateKey === trade.entryDateKey ? 'INTRADAY_HOLD' : 'MISSED_EOD',
  };
}

async function resolveMarkForTrade(trade) {
  const chain = await getAtmPremiums({
    symbol: trade.symbol,
    strike: trade.strike,
    expiry: trade.expiryDate,
  });
  const optionType = normalizeOptionType(trade.optionType);
  const optionLtp = premiumFromChain(chain, optionType);
  return {
    spot: Number(chain.chainSpot || chain.spot),
    optionLtp,
    source: optionLtp != null ? 'chain' : 'entry',
  };
}

async function fillOrderToTrade(order, { entryPremium, spot, clock }) {
  const qty = order.lotSize * order.lots;
  const invested = entryPremium * qty;
  const slPts = order.stopLossPoints;
  const tgPts = order.targetProfitPoints;
  const stopLossPremium = slPts != null ? Math.max(0.05, entryPremium - slPts) : null;
  const targetPremium = tgPts != null ? entryPremium + tgPts : null;

  const tradeDoc = await LivePaperTrade.create({
    strategyKey: STRATEGY_KEY,
    symbol: order.symbol,
    side: 'LONG',
    optionType: order.optionType,
    strike: order.strike,
    expiryDate: order.expiryDate,
    lotSize: order.lotSize,
    lots: order.lots,
    qty,
    entryPremium: Number(entryPremium.toFixed(2)),
    entrySpot: Number(spot.toFixed(2)),
    entryTime: new Date(),
    entryDateKey: clock.dateKey,
    status: 'OPEN',
    investedAmount: Number(invested.toFixed(2)),
    creditReceived: 0,
    charges: Number(order.perTradeCost || 100),
    stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
    targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
    legs: [{ optionType: order.optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
    notes: `manual; order=${order._id}; type=${order.orderType}; sl=${stopLossPremium ?? 'off'}; tg=${targetPremium ?? 'eod'}`,
  });

  order.status = 'FILLED';
  order.tradeId = tradeDoc._id;
  order.filledAt = new Date();
  await order.save();

  await logAction({
    action: 'ORDER_FILLED',
    orderId: order._id,
    tradeId: tradeDoc._id,
    symbol: order.symbol,
    message: `${order.optionType} ${order.strike} filled @ ${entryPremium.toFixed(2)}`,
    details: {
      orderType: order.orderType,
      entryPremium,
      spot,
      stopLossPremium,
      targetPremium,
    },
  });

  return tradeDoc;
}

async function createMarketFill(order, clock) {
  const chain = await getAtmPremiums({
    symbol: order.symbol,
    strike: order.strike,
    expiry: order.expiryDate,
  });
  const spot = Number(chain.chainSpot || chain.spot);
  const entryPremium = premiumFromChain(chain, order.optionType);
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new Error('Live index spot unavailable from Dhan');
  }
  if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
    throw new Error(`${order.optionType} LTP unavailable for strike ${order.strike}`);
  }
  return fillOrderToTrade(order, { entryPremium, spot, clock });
}

async function createOrder(payload) {
  const clock = getIstClock(new Date());
  await assertMarketOpen(clock);

  const symbol = normalizeSymbol(payload.symbol);
  const optionType = normalizeOptionType(payload.optionType);
  const orderType = String(payload.orderType || 'MARKET').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
  const lots = Math.max(1, Math.floor(Number(payload.lots) || 1));
  const lotSize = Math.max(1, Number(payload.lotSize) || (await getCurrentLotSize(symbol)));
  const perTradeCost = Number.isFinite(Number(payload.perTradeCost)) && Number(payload.perTradeCost) >= 0
    ? Number(payload.perTradeCost)
    : 100;
  const stopLossPoints = parsePremiumPoints(payload.stopLossPoints);
  const targetProfitPoints = parsePremiumPoints(payload.targetProfitPoints);

  let expiryDate = String(payload.expiryDate || '').slice(0, 10);
  if (!expiryDate) {
    expiryDate = await getNearestWeeklyExpiry(symbol);
  }
  if (!expiryDate) throw new Error('Could not resolve option expiry from Dhan');

  const chainSpot = await getAtmPremiums({ symbol, strike: 0, expiry: expiryDate });
  const spot = Number(chainSpot.chainSpot || chainSpot.spot);
  if (!Number.isFinite(spot) || spot <= 0) throw new Error('Live spot unavailable');

  let strike = Number(payload.strike);
  if (!Number.isFinite(strike) || strike <= 0) {
    strike = pickStrike({
      entrySpot: spot,
      strikeStep: getStrikeStep(symbol),
      optionType,
      strikeMode: String(payload.strikeMode || 'ATM').toUpperCase(),
    });
  }

  let limitPremium = null;
  if (orderType === 'LIMIT') {
    limitPremium = parsePremiumPoints(payload.limitPremium);
    if (limitPremium == null) throw new Error('Limit premium is required for LIMIT orders');
  }

  const order = await ManualPendingOrder.create({
    strategyKey: STRATEGY_KEY,
    symbol,
    optionType,
    strike,
    expiryDate,
    orderType,
    limitPremium,
    lots,
    lotSize,
    perTradeCost,
    stopLossPoints,
    targetProfitPoints,
    status: orderType === 'MARKET' ? 'PENDING' : 'PENDING',
    sessionDateKey: clock.dateKey,
  });

  await logAction({
    action: 'ORDER_CREATED',
    orderId: order._id,
    symbol,
    message: `${orderType} ${optionType} ${strike} x${lots}`,
    details: { orderType, limitPremium, stopLossPoints, targetProfitPoints, expiryDate },
  });

  if (orderType === 'MARKET') {
    try {
      const trade = await createMarketFill(order, clock);
      return { order, trade, filled: true };
    } catch (err) {
      order.status = 'CANCELLED';
      order.cancelReason = err.message;
      await order.save();
      await logAction({
        action: 'ORDER_FAILED',
        orderId: order._id,
        symbol,
        message: err.message,
      });
      throw err;
    }
  }

  return { order, trade: null, filled: false };
}

async function cancelOrder(orderId, reason = 'USER_CANCEL') {
  const order = await ManualPendingOrder.findOne({
    _id: orderId,
    strategyKey: STRATEGY_KEY,
    status: 'PENDING',
  });
  if (!order) throw new Error('Pending order not found');
  order.status = 'CANCELLED';
  order.cancelReason = reason;
  await order.save();
  await logAction({
    action: 'ORDER_CANCELLED',
    orderId: order._id,
    symbol: order.symbol,
    message: reason,
  });
  return order;
}

async function finalizeTrade(trade, { exitPremium, mark, reason }) {
  const safeExit = Math.max(0.05, Number(exitPremium) || Number(mark?.optionLtp) || 0.05);
  const finalValue = safeExit * trade.qty;
  const invested = (Number(trade.entryPremium) || 0) * trade.qty;
  const charges = Math.max(0, Number(trade.charges) || 0);
  const pnl = finalValue - invested - charges;
  const clock = getIstClock(new Date());

  trade.status = 'CLOSED';
  trade.exitPremium = Number(safeExit.toFixed(2));
  trade.exitSpot = Number(Number(mark?.spot || trade.entrySpot).toFixed(2));
  trade.exitTime = new Date();
  trade.exitDateKey = clock.dateKey;
  trade.reason = reason;
  trade.finalValue = Number(finalValue.toFixed(2));
  trade.pnl = Number(pnl.toFixed(2));
  trade.pnlPct = trade.investedAmount > 0 ? Number(((pnl / trade.investedAmount) * 100).toFixed(2)) : 0;
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

  await logAction({
    action: reason === 'MANUAL_CLOSE' ? 'POSITION_CLOSED_MANUAL' : `POSITION_CLOSED_${reason}`,
    tradeId: trade._id,
    symbol: trade.symbol,
    message: `Exit @ ${safeExit.toFixed(2)} P/L ₹${pnl.toFixed(2)}`,
    details: { reason, exitPremium: safeExit, pnl },
  });

  return trade;
}

async function closePositionById(tradeId, { reason = 'MANUAL_CLOSE' } = {}) {
  const trade = await LivePaperTrade.findOne({
    _id: tradeId,
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  });
  if (!trade) throw new Error('Open position not found');
  const mark = await resolveMarkForTrade(trade);
  if (!Number.isFinite(mark.optionLtp) || mark.optionLtp <= 0) {
    throw new Error('Cannot close — option LTP unavailable from Dhan');
  }
  return finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason });
}

function parseRiskPointsInput(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(5000, n);
}

/**
 * Update SL / target on an open position. Pass stopLossPoints / targetProfitPoints
 * (premium pts from entry). Send null or '' to clear and use EOD-only for that leg.
 */
async function updatePositionRisk(tradeId, payload = {}) {
  const trade = await LivePaperTrade.findOne({
    _id: tradeId,
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  });
  if (!trade) throw new Error('Open position not found');

  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) {
    throw new Error('Invalid entry premium on open trade');
  }

  const prev = {
    stopLossPremium: trade.stopLossPremium,
    targetPremium: trade.targetPremium,
  };
  const changes = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'stopLossPoints')) {
    const slPts = parseRiskPointsInput(payload.stopLossPoints);
    if (slPts == null) {
      trade.stopLossPremium = null;
      changes.stopLossPremium = null;
    } else {
      const slPrem = Math.max(0.05, entry - slPts);
      if (slPrem >= entry) {
        throw new Error('Stop loss must be below entry premium');
      }
      trade.stopLossPremium = Number(slPrem.toFixed(2));
      changes.stopLossPremium = trade.stopLossPremium;
      changes.stopLossPoints = slPts;
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'targetProfitPoints')) {
    const tgPts = parseRiskPointsInput(payload.targetProfitPoints);
    if (tgPts == null) {
      trade.targetPremium = null;
      changes.targetPremium = null;
    } else {
      trade.targetPremium = Number((entry + tgPts).toFixed(2));
      changes.targetPremium = trade.targetPremium;
      changes.targetProfitPoints = tgPts;
    }
  }

  if (!Object.keys(changes).length) {
    throw new Error('Send stopLossPoints and/or targetProfitPoints to update');
  }

  trade.notes = [
    trade.notes,
    `risk@${new Date().toISOString()}; sl=${trade.stopLossPremium ?? 'off'}; tg=${trade.targetPremium ?? 'eod'}`,
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
  await trade.save();

  await logAction({
    action: 'POSITION_RISK_UPDATED',
    tradeId: trade._id,
    symbol: trade.symbol,
    message: `SL ${prev.stopLossPremium ?? 'off'} → ${trade.stopLossPremium ?? 'off'}; TG ${prev.targetPremium ?? 'eod'} → ${trade.targetPremium ?? 'eod'}`,
    details: { prev, next: changes, entryPremium: entry },
  });

  return trade;
}

async function checkPendingOrders(clock) {
  const pending = await ManualPendingOrder.find({
    strategyKey: STRATEGY_KEY,
    status: 'PENDING',
    orderType: 'LIMIT',
  }).sort({ createdAt: 1 });

  for (const order of pending) {
    if (order.sessionDateKey && order.sessionDateKey !== clock.dateKey) {
      order.status = 'EXPIRED';
      order.cancelReason = 'SESSION_ENDED';
      await order.save();
      await logAction({
        action: 'ORDER_EXPIRED',
        orderId: order._id,
        symbol: order.symbol,
        message: 'Limit order expired — new session',
      });
      continue;
    }
    try {
      const chain = await getAtmPremiums({
        symbol: order.symbol,
        strike: order.strike,
        expiry: order.expiryDate,
      });
      const ltp = premiumFromChain(chain, order.optionType);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      if (ltp <= Number(order.limitPremium)) {
        const spot = Number(chain.chainSpot || chain.spot);
        await fillOrderToTrade(order, { entryPremium: ltp, spot, clock });
      }
    } catch (err) {
      engineState.lastError = `Limit order poll: ${err.message}`;
    }
  }
}

async function checkOpenPositions(clock) {
  const openTrades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  }).sort({ entryTime: 1 });

  for (const trade of openTrades) {
    try {
      if (clock.dateKey !== trade.entryDateKey) {
        const mark = await resolveMarkForTrade(trade);
        await finalizeTrade(trade, {
          exitPremium: mark.optionLtp,
          mark,
          reason: 'DAY_CLOSE',
        });
        continue;
      }

      const mark = await resolveMarkForTrade(trade);
      const positionMark = buildOpenPositionMark(trade, mark, clock);
      await LivePaperTrade.updateOne(
        { _id: trade._id, exitTime: null },
        { $set: { openPositionMark: positionMark, openPositionMarkAt: new Date() } },
      );

      const heldMs = Date.now() - new Date(trade.entryTime).getTime();
      if (heldMs < MIN_HOLD_MS) continue;

      const optionLtp = Number(mark.optionLtp);
      if (!Number.isFinite(optionLtp) || optionLtp <= 0) continue;

      if (trade.stopLossPremium != null && optionLtp <= Number(trade.stopLossPremium)) {
        await finalizeTrade(trade, {
          exitPremium: Number(trade.stopLossPremium),
          mark,
          reason: 'STOP_LOSS',
        });
        continue;
      }

      if (trade.targetPremium != null && optionLtp >= Number(trade.targetPremium)) {
        await finalizeTrade(trade, {
          exitPremium: Number(trade.targetPremium),
          mark,
          reason: 'TARGET',
        });
        continue;
      }

      if (isEodExitTime(clock.minutes)) {
        await finalizeTrade(trade, { exitPremium: optionLtp, mark, reason: 'DAY_CLOSE' });
      }
    } catch (err) {
      engineState.lastError = `Position check ${trade._id}: ${err.message}`;
    }
  }
}

async function pollOnce() {
  const clock = getIstClock(new Date());
  engineState.lastPollAt = new Date();
  if (!engineState.running) return;
  await checkPendingOrders(clock);
  await checkOpenPositions(clock);
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    pollOnce().catch((err) => {
      engineState.lastError = err.message;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    engineState.running = true;
    engineState.startedAt = new Date();
    startPoll();
    await logAction({ action: 'ENGINE_STARTED', message: 'Manual console engine online' });
  }
  return { ok: true, state: getEngineSnapshot() };
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    startedAt: engineState.startedAt,
    lastError: engineState.lastError,
    lastPollAt: engineState.lastPollAt,
  };
}

async function getQuote({ symbol, expiry, strike, optionType }) {
  const sym = normalizeSymbol(symbol);
  const exp = String(expiry || (await getNearestWeeklyExpiry(sym)) || '').slice(0, 10);
  if (!exp) throw new Error('Expiry required');
  const chain = await getAtmPremiums({ symbol: sym, strike: Number(strike) || 0, expiry: exp });
  const spot = Number(chain.chainSpot || chain.spot);
  const atm = atmStrikeFromSpot(spot, sym);
  const type = normalizeOptionType(optionType);
  const ltp = premiumFromChain(chain, type);
  return {
    symbol: sym,
    expiry: exp,
    spot,
    atmStrike: atm,
    strike: Number(strike) || atm,
    optionType: type,
    ltp,
    ceLtp: chain.ceLtp,
    peLtp: chain.peLtp,
  };
}

async function getExpiries(symbol) {
  const sym = normalizeSymbol(symbol);
  const list = await fetchExpiryList(sym);
  const today = new Date().toISOString().slice(0, 10);
  const future = [...list].sort().filter((d) => d >= today);
  const nearest = future[0] || list[0] || null;
  return { symbol: sym, expiries: future.length ? future : list, nearest };
}

function pickLegLtp(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const last = Number(leg.last_price);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = Number(leg.top_bid_price);
  const ask = Number(leg.top_ask_price);
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    return Number(((bid + ask) / 2).toFixed(2));
  }
  if (Number.isFinite(ask) && ask > 0) return ask;
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function findStrikeRow(strikes, strike) {
  const target = Number(strike);
  if (!Number.isFinite(target)) return null;
  const keys = Object.keys(strikes || {});
  let bestKey = null;
  let bestDiff = Infinity;
  for (const k of keys) {
    const diff = Math.abs(Number(k) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = k;
    }
  }
  if (bestKey == null || bestDiff > 1) return null;
  return strikes[bestKey];
}

async function getChainAroundAtm({ symbol, expiry }) {
  const sym = normalizeSymbol(symbol);
  const exp = String(expiry || (await getNearestWeeklyExpiry(sym)) || '').slice(0, 10);
  const chain = await fetchOptionChainCached({ symbol: sym, expiry: exp });
  const spot = Number(chain.last_price);
  const step = getStrikeStep(sym);
  const atm = atmStrikeFromSpot(spot, sym);
  const strikes = chain.oc || {};
  const rows = [];
  for (let i = -5; i <= 5; i += 1) {
    const k = atm + i * step;
    const row = findStrikeRow(strikes, k);
    if (!row) continue;
    rows.push({
      strike: k,
      ceLtp: pickLegLtp(row.ce),
      peLtp: pickLegLtp(row.pe),
    });
  }
  return { symbol: sym, expiry: exp, spot, atmStrike: atm, strikes: rows };
}

async function getStatus() {
  await ensureEngineRunning();
  const clock = getIstClock(new Date());
  const wallet = await ensureWallet();
  const openTrades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  const pendingOrders = await ManualPendingOrder.find({
    strategyKey: STRATEGY_KEY,
    status: 'PENDING',
  })
    .sort({ createdAt: -1 })
    .lean();
  const todayTrades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  })
    .sort({ entryTime: -1 })
    .lean();

  let unrealizedPnl = 0;
  for (const t of openTrades) {
    unrealizedPnl += Number(t.openPositionMark?.unrealizedPnl) || 0;
  }

  return {
    engine: getEngineSnapshot(),
    istDateKey: clock.dateKey,
    wallet: {
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    openTrades,
    pendingOrders,
    todayTrades,
    openUnrealizedPnl: Number(unrealizedPnl.toFixed(2)),
  };
}

async function listTrades({ page = 1, pageSize = 25, status = 'ALL' }) {
  const filter = { strategyKey: STRATEGY_KEY };
  const statusQ = String(status || 'ALL').toUpperCase();
  if (statusQ === 'OPEN') {
    filter.exitTime = null;
    filter.status = { $ne: 'CLOSED' };
  } else if (statusQ === 'CLOSED') {
    filter.$or = [{ exitTime: { $ne: null } }, { status: 'CLOSED' }];
  }
  const totalRows = await LivePaperTrade.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const trades = await LivePaperTrade.find(filter)
    .sort({ entryTime: -1 })
    .skip((currentPage - 1) * pageSize)
    .limit(pageSize)
    .lean();
  return { trades, pagination: { page: currentPage, pageSize, totalRows, totalPages } };
}

async function listActions({ page = 1, pageSize = 50 }) {
  const filter = { strategyKey: STRATEGY_KEY };
  const totalRows = await ManualTradeAction.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const actions = await ManualTradeAction.find(filter)
    .sort({ createdAt: -1 })
    .skip((currentPage - 1) * pageSize)
    .limit(pageSize)
    .lean();
  return { actions, pagination: { page: currentPage, pageSize, totalRows, totalPages } };
}

async function resetWallet() {
  await LivePaperTrade.deleteMany({ strategyKey: STRATEGY_KEY });
  await ManualPendingOrder.deleteMany({ strategyKey: STRATEGY_KEY });
  const wallet = await ensureWallet();
  wallet.balance = 0;
  wallet.realizedPnl = 0;
  wallet.totalTrades = 0;
  wallet.wins = 0;
  wallet.losses = 0;
  wallet.lastResetAt = new Date();
  await wallet.save();
  await logAction({ action: 'WALLET_RESET', message: 'Manual console wallet and trades cleared' });
  return wallet;
}

module.exports = {
  STRATEGY_KEY,
  ensureEngineRunning,
  getEngineSnapshot,
  createOrder,
  cancelOrder,
  closePositionById,
  updatePositionRisk,
  getStatus,
  getQuote,
  getExpiries,
  getChainAroundAtm,
  listTrades,
  listActions,
  resetWallet,
  recalcWalletFromTrades,
  logAction,
};

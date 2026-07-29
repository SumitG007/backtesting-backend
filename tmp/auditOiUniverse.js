/**
 * One-shot audit: OI Universe signals vs entries vs notifications vs DB trades.
 * Run: node tmp/auditOiUniverse.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const axios = require('axios');

const STRATEGY_KEY = 'strategy13_oi_universe_live';
const LIVE_ID = 'strategy-11';
const PORT = process.env.PORT || 3001;
const BASE = `http://127.0.0.1:${PORT}`;

function istDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

async function login() {
  const email = process.env.ADMIN || process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const r = await axios.post(`${BASE}/api/auth/login`, { email, password }, { timeout: 8000 });
  const token = r.data?.token || r.data?.accessToken;
  if (!token) throw new Error(`Login failed: ${JSON.stringify(r.data)}`);
  return token;
}

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(mongoUri);
  const dateKey = istDateKey();
  const LivePaperTrade = require('../src/models/livePaperTrade');

  const tradesToday = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
  })
    .sort({ entryTime: -1 })
    .lean();

  const openTrades = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).lean();

  let status = null;
  let notifs = null;
  let statusErr = null;
  try {
    const token = await login();
    const headers = { Authorization: `Bearer ${token}` };
    const r = await axios.get(`${BASE}/api/live/${LIVE_ID}/status`, { timeout: 15000, headers });
    status = r.data;
    const n = await axios.get(`${BASE}/api/notifications/today`, { timeout: 8000, headers });
    notifs = n.data;
  } catch (e) {
    statusErr = e.response?.data || e.message;
  }

  const engine = status?.engine || {};
  const cards = Array.isArray(engine?.cards) ? engine.cards : [];
  const symbolRows = cards.map((s) => ({
    symbol: s.symbol,
    status: s.signal?.status,
    buyLive: !!s.signal?.buyLive,
    reason: s.signal?.reason,
    ratio: s.signal?.ratio,
    optionType: s.signal?.optionType,
    levelStrike: s.signal?.levelStrike,
    fut: s.signal?.fut ?? s.lastFut,
    priceSource: s.signal?.priceSource || s.board?.priceSource,
    spotDist: s.signal?.spotDist,
    proximityLimit: s.signal?.proximityLimit,
    lastError: s.lastError,
    detail: s.signal?.detail,
  }));
  const strongNow = symbolRows.filter((r) => r.status === 'STRONG_READY' && r.buyLive);
  const strongAny = symbolRows.filter((r) => r.status === 'STRONG_READY');

  const universeNotifs = (notifs?.notifications || []).filter(
    (n) => String(n.strategy || '').toLowerCase() === 'oi universe',
  );
  const byType = {};
  for (const n of universeNotifs) {
    const t = String(n.type || 'OTHER').toUpperCase();
    byType[t] = (byType[t] || 0) + 1;
  }
  const ready = universeNotifs.filter((n) => String(n.type).toUpperCase() === 'SIGNAL_READY');
  const entries = universeNotifs.filter((n) => String(n.type).toUpperCase() === 'ENTRY');
  const exits = universeNotifs.filter((n) => String(n.type).toUpperCase() === 'EXIT');

  const report = {
    at: new Date().toISOString(),
    dateKey,
    db: {
      tradesToday: tradesToday.length,
      openCount: openTrades.length,
      trades: tradesToday,
      open: openTrades.map((t) => ({
        id: String(t._id),
        symbol: t.symbol,
        optionType: t.optionType,
        strike: t.strike,
        entryPremium: t.entryPremium,
        entryTime: t.entryTime,
      })),
    },
    api: {
      statusErr: statusErr && !status ? statusErr : null,
      running: engine.running,
      openTradeId: engine.openTradeId,
      tradesTodayCount: engine.tradesTodayCount,
      maxTradesPerDay: engine.maxTradesPerDay,
      readySymbols: engine.readySymbols,
      topReady: engine.topReady
        ? {
            symbol: engine.topReady.symbol,
            status: engine.topReady.signal?.status,
            buyLive: engine.topReady.signal?.buyLive,
            reason: engine.topReady.signal?.reason,
            detail: engine.topReady.signal?.detail,
            ratio: engine.topReady.signal?.ratio,
          }
        : null,
      lastError: engine.lastError,
      lastEntryDebug: engine.lastEntryDebug,
      tradeFrom: engine.settings?.tradeFromTime,
      tradeTo: engine.settings?.tradeToTime,
      minOiRatio: engine.settings?.minOiRatio,
      openTradeFromApi: status?.openTrade
        ? {
            id: String(status.openTrade._id),
            symbol: status.openTrade.symbol,
            status: status.openTrade.status,
          }
        : null,
    },
    notifications: {
      totalUniverse: universeNotifs.length,
      byType,
      signalReadyCount: ready.length,
      entryCount: entries.length,
      exitCount: exits.length,
      recentReady: ready.slice(0, 20).map((n) => ({
        at: n.at,
        title: n.title,
        body: n.body,
        symbol: n.meta?.symbol,
      })),
      recentOther: universeNotifs
        .filter((n) => !['SIGNAL_READY', 'ENTRY', 'EXIT'].includes(String(n.type).toUpperCase()))
        .slice(0, 15)
        .map((n) => ({
          at: n.at,
          type: n.type,
          title: n.title,
          body: (n.body || '').slice(0, 100),
          symbol: n.meta?.symbol,
        })),
    },
    liveSignals: {
      symbolCount: symbolRows.length,
      byStatus: symbolRows.reduce((acc, r) => {
        const k = r.status || 'NONE';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      strongReadyBuyLive: strongNow,
      strongReadyAny: strongAny,
      withBuyLive: symbolRows.filter((r) => r.buyLive),
      lastErrors: symbolRows
        .filter((r) => r.lastError)
        .slice(0, 20)
        .map((r) => ({
          symbol: r.symbol,
          status: r.status,
          buyLive: r.buyLive,
          lastError: r.lastError,
        })),
    },
    verdictHints: [],
  };

  // compact trades in report
  report.db.trades = tradesToday.map((t) => ({
    id: String(t._id),
    symbol: t.symbol,
    optionType: t.optionType,
    strike: t.strike,
    status: t.status,
    entryPremium: t.entryPremium,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    reason: t.reason,
    entryReason: t.entryReason,
    pnl: t.pnl,
  }));

  if (ready.length > 0 && entries.length === 0 && tradesToday.length === 0) {
    report.verdictHints.push(
      'SIGNAL_READY alerts exist but zero ENTRY notifs and zero DB trades — fill never completed.',
    );
  }
  if (strongNow.length === 0 && ready.length > 0) {
    report.verdictHints.push(
      'Past SIGNAL_READY existed, but nothing is STRONG_READY+buyLive right now (setups expire on re-scan).',
    );
  }
  if (strongNow.length > 0 && !engine.openTradeId && tradesToday.length === 0) {
    report.verdictHints.push(
      'STRONG_READY+buyLive exists NOW with no open trade — placeStrongEntry failing or blocked (see lastEntryDebug).',
    );
  }
  if ((engine.lastError || '').toLowerCase().includes('future ltp')) {
    report.verdictHints.push('Engine lastError still mentions Future LTP — FUT feed flaky.');
  }
  const cautionWatch = (byType.SIGNAL_CAUTION || 0) + (byType.SIGNAL_CHANGED || 0) + (byType.OI_SIGNAL || 0);
  if (cautionWatch > (byType.SIGNAL_READY || 0) * 2) {
    report.verdictHints.push(
      'Most notifications are WATCH/CAUTION (not tradeable). Only SIGNAL_READY can become a position.',
    );
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('AUDIT_FAILED', err.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

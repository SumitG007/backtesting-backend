const ExcelJS = require('exceljs');
const LiveWallet = require('../models/liveWallet');
const LivePaperTrade = require('../models/livePaperTrade');
const strategySixEngine = require('../services/liveShortStraddleEngineStrategy6');
const strategySevenEngine = require('../services/livePutBuyEngine');
const strategyElevenEngine = require('../services/liveSlFlipEngine');
const {
  STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SIX_KEY,
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SEVEN_PUT_BUY_LIVE_KEY,
  STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY,
} = require('../strategies/keys');

const KNOWN_PAPER_LIVE_KEYS = [
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_SEVEN_PUT_BUY_LIVE_KEY,
  STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY,
];

function buildPaperLiveKeyFilter(ctx) {
  return { strategyKey: ctx.strategyKey };
}

function computeClosedTradeStats(rows) {
  let netPnl = 0;
  let wins = 0;
  let losses = 0;
  let totalCharges = 0;
  for (const t of rows) {
    const pnl = Number(t.pnl);
    const p = Number.isFinite(pnl) ? pnl : 0;
    netPnl += p;
    totalCharges += Number(t.charges) || 0;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  return {
    netPnl: Number(netPnl.toFixed(2)),
    wins,
    losses,
    totalTrades: rows.length,
    totalCharges: Number(totalCharges.toFixed(2)),
  };
}

/** Older paper rows used the backtest strategy6 key — fold into remaining straddle live. */
async function normalizeLegacyStrategy4PaperKeys() {
  await LivePaperTrade.updateMany(
    { strategyKey: STRATEGY_SIX_KEY, optionType: 'STRADDLE' },
    { $set: { strategyKey: STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY } },
  );
  // Retired Strategy A (strategy-2) live key → keep history under active straddle live.
  await LivePaperTrade.updateMany(
    { strategyKey: STRATEGY_FOUR_SHORT_STRADDLE_LIVE_KEY, optionType: 'STRADDLE' },
    { $set: { strategyKey: STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY } },
  );
}

/** Old rows saved with schema default or wrong key — auto-close so they do not alarm the UI. */
async function closeLegacyOrphanStraddles(clock) {
  const rows = await LivePaperTrade.find({
    exitTime: null,
    optionType: 'STRADDLE',
    strategyKey: { $nin: KNOWN_PAPER_LIVE_KEYS },
  });
  let closed = 0;
  for (const trade of rows) {
    trade.status = 'CLOSED';
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = 'LEGACY_ORPHAN_CLOSE';
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.pnl = 0;
    trade.pnlPct = 0;
    trade.notes = [trade.notes, `auto-closed legacy key ${trade.strategyKey} at ${clock.dateKey}`]
      .filter(Boolean)
      .join('; ');
    await trade.save();
    closed += 1;
  }
  return closed;
}
const {
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getNextWeeklyExpiry,
  getAtmPremiums,
} = require('../services/dhanLiveService');
const { getIstClock } = require('../utils/dateTime');

function formatEntryWindowLabel(entryTime, entryWindowMinutes) {
  const windowMins = Math.max(0, Number(entryWindowMinutes) || 0);
  if (windowMins <= 0) return String(entryTime || '11:15');
  const parts = String(entryTime).split(':');
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  const startMinutes = Number.isFinite(hh) && Number.isFinite(mm) ? (hh * 60 + mm) : (9 * 60 + 20);
  const endMinutes = startMinutes + windowMins;
  const endH = String(Math.floor(endMinutes / 60)).padStart(2, '0');
  const endM = String(endMinutes % 60).padStart(2, '0');
  return `${entryTime}–${endH}:${endM}`;
}

/** Engine snapshot first, then persisted wallet settings, then strategy-specific defaults. */
function isSlFlipLiveStrategyId(strategyId) {
  return strategyId === 'strategy-8';
}

function slFlipTrailBarMinutes(engine) {
  const n = Number(engine?.barIntervalMinutes ?? engine?.settings?.trailReentryBarMinutes);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function resolveHintEntrySettings(engine, strategyId, wallet) {
  const fromEngine = engine?.settings;
  if (isSlFlipLiveStrategyId(strategyId) && fromEngine) {
    return {
      entryTime: String(fromEngine.entryFromTime || '09:20'),
      entryToTime: String(fromEngine.entryToTime || '15:15'),
      entryWindowMinutes: 0,
    };
  }
  if (fromEngine?.entryTime) {
    const windowMins =
      strategyId === 'strategy-3'
        ? 0
        : Math.max(0, Number(fromEngine.entryWindowMinutes) || 2);
    return {
      entryTime: String(fromEngine.entryTime),
      entryWindowMinutes: windowMins,
    };
  }
  if (strategyId === 'strategy-6') {
    const w = wallet?.strategy6EngineSettings;
    return {
      entryTime: String(w?.entryTime || '09:20'),
      entryWindowMinutes: Math.max(0, Number(w?.entryWindowMinutes) || 2),
    };
  }
  if (strategyId === 'strategy-3') {
    const w = wallet?.strategy7EngineSettings;
    return {
      entryTime: String(w?.entryToTime || w?.entryTime || '11:15'),
      entryWindowMinutes: 0,
    };
  }
  if (isSlFlipLiveStrategyId(strategyId)) {
    const w = wallet?.strategy11EngineSettings;
    return {
      entryTime: String(w?.entryFromTime || '09:20'),
      entryToTime: String(w?.entryToTime || '15:15'),
      entryWindowMinutes: 0,
    };
  }
  return {
    entryTime: '09:20',
    entryWindowMinutes: 2,
  };
}

function buildPaperLiveHint({ openTrade, todayTrades, latestTrade, engine, strategyLabel, strategyId, wallet }) {
  const label = strategyLabel || 'Paper-live';
  const { entryTime, entryWindowMinutes, entryToTime } = resolveHintEntrySettings(engine, strategyId, wallet);
  const entryWindowLabel =
    isSlFlipLiveStrategyId(strategyId) && entryToTime
      ? `${entryTime}–${entryToTime}`
      : formatEntryWindowLabel(entryTime, entryWindowMinutes);
  const trailBarM = slFlipTrailBarMinutes(engine);

  if (openTrade) return null;
  const closedToday = (todayTrades || []).filter((t) => t.exitTime);
  if (isSlFlipLiveStrategyId(strategyId)) {
    const count = closedToday.length;
    const scenarioLabel = engine?.scenarioLabel || 'SL Flip';
    if (count > 0) {
      return `${count} ${scenarioLabel} trade(s) closed today. SL → flip opposite immediately; trail → same side immediately when direction aligns. Window ${entryWindowLabel} IST · EOD 15:20.`;
    }
    return `No open position. Day starter is CE at/after 09:20 (${entryWindowLabel} IST). Tick + 1m OHLC exits · re-entry immediately when 5m direction supports side.`;
  }
  if (closedToday.length > 0) {
    const t = closedToday[0];
    const reason = t.reason || 'CLOSED';
    if (reason === 'MANUAL_CLOSE') {
      return `Position closed manually. Realized P/L is in the Closed tab. ${label} will not auto-enter again today (one entry per day).`;
    }
    return `Today's paper-live entry is closed (${reason}). See the Closed tab.`;
  }
  if ((todayTrades || []).length > 0) {
    return null;
  }
  if (latestTrade?.exitTime) {
    const entryDay = latestTrade.entryDateKey || '—';
    const reason = latestTrade.reason || 'CLOSED';
    return `No open position. Last paper-live trade: entry ${entryDay}, closed (${reason}). Today's auto-entry window is ${entryWindowLabel} IST (Mon–Fri) while the backend is running.`;
  }
  const dbg = engine?.lastEntryDebug;
  if (dbg?.line === 'ENTRY_SUCCESS') {
    return 'Engine logged an entry today but no open row was found — try refreshing or check MongoDB.';
  }
  if (
    engine?.skippedDateKey
    || dbg?.reason === 'SKIPPED_TODAY'
    || (dbg?.line === 'ENTRY_SKIP' && dbg?.reason && String(dbg.reason).includes('neutral'))
  ) {
    const evalInfo = engine?.lastDirectionEval;
    const pe = evalInfo?.peScore ?? dbg?.peScore ?? '—';
    const ce = evalInfo?.ceScore ?? dbg?.ceScore ?? '—';
    const why = evalInfo?.skipReason || dbg?.reason || 'neutral_day';
    return `No trade today — direction skipped (${why}). PE score ${pe}, CE score ${ce}. One evaluation per day in ${entryWindowLabel} IST.`;
  }
  if (dbg?.reason === 'ALREADY_TRADED_TODAY' || dbg?.reason === 'ALREADY_TRADED_TODAY_IN_DB') {
    return 'Engine will not enter again today (one entry per day). No open row in DB — check Closed tab or wallet reset.';
  }
  return `No paper-live trade recorded for today. Auto-entry runs only Mon–Fri ${entryWindowLabel} IST with backend + Dhan connected. Backtest entries are separate and do not appear here.`;
}

function straddlePaperLiveCtx(strategyId, engine) {
  return {
    strategyId,
    strategyKey: engine.STRATEGY_KEY,
    startEngine: engine.startEngine,
    stopEngine: engine.stopEngine,
    updateEngineSettings: engine.updateEngineSettings,
    getEngineSnapshot: engine.getEngineSnapshot,
    ensureWallet: engine.ensureWallet,
    recalcWallet: engine.recalcWalletFromTrades,
    ensureRunning: engine.ensureEngineRunning,
    reconcileOpenTrades: engine.reconcileOpenTrades,
    closeOpenPosition: engine.closeOpenPosition,
    refreshOpenMark: engine.refreshOpenPositionMarkForStatus,
  };
}

function isStraddleLiveStrategyId(strategyId) {
  return strategyId === 'strategy-6';
}

function isPutBuyLiveStrategyId(strategyId) {
  return strategyId === 'strategy-3';
}

function slFlipPaperLiveCtx(strategyId, engine) {
  return {
    strategyId,
    strategyKey: engine.STRATEGY_KEY,
    startEngine: engine.startEngine,
    stopEngine: engine.stopEngine,
    updateEngineSettings: engine.updateEngineSettings,
    getEngineSnapshot: engine.getEngineSnapshot,
    ensureWallet: engine.ensureWallet,
    recalcWallet: engine.recalcWalletFromTrades,
    ensureRunning: engine.ensureEngineRunning,
    reconcileOpenTrades: engine.reconcileOpenTrades,
    closeOpenPosition: engine.closeOpenPosition,
    refreshOpenMark: engine.refreshOpenPositionMarkForStatus,
    clearDailySkip: engine.clearDailySkipState,
  };
}

function putBuyPaperLiveCtx(strategyId) {
  return {
    strategyId,
    strategyKey: strategySevenEngine.STRATEGY_KEY,
    startEngine: strategySevenEngine.startEngine,
    stopEngine: strategySevenEngine.stopEngine,
    updateEngineSettings: strategySevenEngine.updateEngineSettings,
    getEngineSnapshot: strategySevenEngine.getEngineSnapshot,
    ensureWallet: strategySevenEngine.ensureWallet,
    recalcWallet: strategySevenEngine.recalcWalletFromTrades,
    ensureRunning: strategySevenEngine.ensureEngineRunning,
    reconcileOpenTrades: strategySevenEngine.reconcileOpenTrades,
    closeOpenPosition: strategySevenEngine.closeOpenPosition,
    refreshOpenMark: strategySevenEngine.refreshOpenPositionMarkForStatus,
    clearDailySkip: strategySevenEngine.clearDailySkipState,
  };
}

const LIVE_STRATEGIES = {
  'strategy-3': putBuyPaperLiveCtx('strategy-3'),
  'strategy-6': straddlePaperLiveCtx('strategy-6', strategySixEngine),
  'strategy-8': slFlipPaperLiveCtx('strategy-8', strategyElevenEngine),
};

function getLiveContext(req) {
  const strategyId = String(req.params?.strategyId || '').toLowerCase();
  return LIVE_STRATEGIES[strategyId] || null;
}

async function getStatus(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    if (typeof ctx.ensureRunning === 'function') {
      await ctx.ensureRunning();
    }
    let wallet = await ctx.ensureWallet();
    if (isStraddleLiveStrategyId(ctx.strategyId)) {
      await normalizeLegacyStrategy4PaperKeys();
    }
    if (typeof ctx.reconcileOpenTrades === 'function') {
      await ctx.reconcileOpenTrades();
    }
    const clock = getIstClock(new Date());
    await closeLegacyOrphanStraddles(clock);
    const keyFilter = buildPaperLiveKeyFilter(ctx);
    const closedFilter = {
      ...keyFilter,
      $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
    };
    const closedRows = await LivePaperTrade.find(closedFilter).lean();
    const stats = computeClosedTradeStats(closedRows);
    const strategyNetPnl = stats.netPnl;
    const strategyTotalTrades = stats.totalTrades;
    if (typeof ctx.recalcWallet === 'function') {
      const walletPnl = Number(Number(wallet.realizedPnl || 0).toFixed(2));
      if (Number(wallet.totalTrades || 0) !== strategyTotalTrades || walletPnl !== strategyNetPnl) {
        await ctx.recalcWallet();
        wallet = await ctx.ensureWallet();
      }
    }
    let openTrade = await LivePaperTrade.findOne({
      ...keyFilter,
      exitTime: null,
      status: { $ne: 'CLOSED' },
    })
      .sort({ entryTime: -1 })
      .lean();
    if (openTrade && typeof ctx.refreshOpenMark === 'function') {
      try {
        await ctx.refreshOpenMark();
        openTrade = await LivePaperTrade.findById(openTrade._id).lean();
      } catch (markErr) {
        // Keep last DB mark on refresh failure
      }
    }
    const snapshot = ctx.getEngineSnapshot();
    const openPositionMark =
      snapshot.openPositionMark
      || openTrade?.openPositionMark
      || null;
    const todayTrades = await LivePaperTrade.find({
      ...keyFilter,
      entryDateKey: clock.dateKey,
    })
      .sort({ entryTime: -1 })
      .lean();
    const latestTrade = await LivePaperTrade.findOne(keyFilter)
      .sort({ entryTime: -1 })
      .lean();
    const positionHint = buildPaperLiveHint({
      openTrade,
      todayTrades,
      latestTrade,
      engine: snapshot,
      strategyId: ctx.strategyId,
      wallet,
      strategyLabel:
        ctx.strategyId === 'strategy-6'
          ? 'Short straddle'
          : ctx.strategyId === 'strategy-3'
              ? 'Put & Call buy'
              : isSlFlipLiveStrategyId(ctx.strategyId)
                ? snapshot?.scenarioLabel || 'SL Flip'
                : 'Paper-live',
    });
    return res.json({
      ok: true,
      strategyId: ctx.strategyId,
      strategyKey: ctx.strategyKey,
      engine: snapshot,
      openPositionMark,
      todayTrades,
      latestTrade: latestTrade || null,
      positionHint,
      istDateKey: clock.dateKey,
      wallet: {
        startingBalance: wallet.startingBalance,
        balance: wallet.balance,
        realizedPnl: wallet.realizedPnl,
        totalTrades: strategyTotalTrades,
        wins: stats.wins,
        losses: stats.losses,
        strategyNetPnl,
        strategyWins: stats.wins,
        strategyLosses: stats.losses,
        strategyTotalTrades,
        totalCharges: stats.totalCharges,
        lastResetAt: wallet.lastResetAt,
      },
      openTrade: openTrade || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function startLive(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    const { symbol = 'NIFTY', settings = {} } = req.body || {};
    const result = await ctx.startEngine({ symbol, settings });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function stopLive(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    return res.json(ctx.stopEngine());
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

const OPTIONAL_PCT_KEYS = new Set(['targetPct', 'stopLossPct', 'targetVolCrushPct', 'stopVolExpandPct']);
const SIGNAL_LIST_KEYS = new Set(['enabledPeSignals', 'enabledCeSignals']);

function coerceLiveEngineSetting(key, value) {
  if (SIGNAL_LIST_KEYS.has(key)) {
    if (value == null) return undefined;
    if (Array.isArray(value)) return value.map((id) => String(id));
    if (typeof value === 'object') {
      return Object.entries(value)
        .filter(([, enabled]) => enabled !== false && enabled !== 'false' && enabled !== 0)
        .map(([id]) => String(id));
    }
    return undefined;
  }
  if (typeof value === 'string' && /Time$/.test(key)) {
    return value.trim();
  }
  if (OPTIONAL_PCT_KEYS.has(key)) {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (key === 'skipExpiryDay') {
    return value !== false && value !== 'false' && value !== 0 && value !== '0';
  }
  if (key === 'targetProfitPoints') {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (key === 'minDirectionScore') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return 2;
    return Math.min(6, Math.floor(n));
  }
  if (key === 'maxTradesPerDay') {
    return null;
  }
  if (key === 'maxLossesPerSidePerDay') {
    return null;
  }
  if (key === 'trailingTargetEnabled') {
    return value !== false && value !== 'false' && value !== 0 && value !== '0';
  }
  if (key === 'symbol') {
    return String(value || 'NIFTY').trim().toUpperCase();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

async function saveLiveSettings(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    const settings = req.body?.settings || {};
    const numeric = {};
    for (const [key, value] of Object.entries(settings)) {
      numeric[key] = coerceLiveEngineSetting(key, value);
    }
    const result = await ctx.updateEngineSettings(numeric);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function resetWallet(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    const deleteFilter = buildPaperLiveKeyFilter(ctx);
    await LivePaperTrade.deleteMany(deleteFilter);
    if (typeof ctx.recalcWallet === 'function') {
      await ctx.recalcWallet();
    } else {
      const wallet = await ctx.ensureWallet();
      await wallet.save();
    }
    const wallet = await ctx.ensureWallet();
    if (
      isPutBuyLiveStrategyId(ctx.strategyId)
      || isSlFlipLiveStrategyId(ctx.strategyId)
    ) {
      if (typeof ctx.clearDailySkip === 'function') {
        await ctx.clearDailySkip();
      } else if (isPutBuyLiveStrategyId(ctx.strategyId)) {
        wallet.strategy7SkippedDateKey = null;
        wallet.strategy7LastSkipReason = null;
        await wallet.save();
      }
    }
    return res.json({ ok: true, wallet, message: `Cleared paper trades for ${ctx.strategyId}` });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function reopenLiveTrade(req, res) {
  return res.status(400).json({
    ok: false,
    error: 'Reopen was only for retired Strategy A (left straddle). Use Short straddle paper live (strategy-6).',
  });
}

async function listTrades(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    if (typeof ctx.reconcileOpenTrades === 'function') {
      await ctx.reconcileOpenTrades();
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 50));
    const statusQ = String(req.query.status || '').toUpperCase();
    const filter = buildPaperLiveKeyFilter(ctx);
    if (statusQ === 'OPEN') {
      filter.exitTime = null;
      filter.status = { $ne: 'CLOSED' };
    } else if (statusQ === 'CLOSED') {
      filter.$or = [{ exitTime: { $ne: null } }, { status: 'CLOSED' }];
    } else {
      // ALL (default) — open + closed
    }
    const totalRows = await LivePaperTrade.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;
    const trades = await LivePaperTrade.find(filter)
      .sort({ entryTime: -1 })
      .skip(skip)
      .limit(pageSize)
      .lean();
    const tradesWithSr = trades.map((t, i) => ({ ...t, srNo: skip + i + 1 }));
    return res.json({
      ok: true,
      trades: tradesWithSr,
      pagination: { page: currentPage, pageSize, totalRows, totalPages },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function exportTradesExcel(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    const trades = await LivePaperTrade.find(buildPaperLiveKeyFilter(ctx)).sort({ entryTime: -1 }).lean();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Paper Live Trades');
    sheet.columns = [
      { header: 'Strategy', key: 'strategyKey', width: 30 },
      { header: 'Symbol', key: 'symbol', width: 12 },
      { header: 'Strike', key: 'strike', width: 10 },
      { header: 'Entry IV proxy', key: 'entryIvProxy', width: 14 },
      { header: 'Median IV proxy', key: 'medianIvProxy', width: 14 },
      { header: 'Entry Premium', key: 'entryPremium', width: 16 },
      { header: 'Entry Time (IST)', key: 'entryTime', width: 22 },
      { header: 'Margin (Rs)', key: 'investedAmount', width: 14 },
      { header: 'Credit (Rs)', key: 'creditReceived', width: 14 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Exit Premium', key: 'exitPremium', width: 14 },
      { header: 'Exit Time (IST)', key: 'exitTime', width: 22 },
      { header: 'Reason', key: 'reason', width: 14 },
      { header: 'P/L (Rs)', key: 'pnl', width: 12 },
      { header: 'P/L %', key: 'pnlPct', width: 10 },
    ];
    sheet.getRow(1).font = { bold: true };
    const istFormat = (date) =>
      date
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }).format(new Date(date))
        : '';
    for (const t of trades) {
      sheet.addRow({
        ...t,
        entryTime: istFormat(t.entryTime),
        exitTime: istFormat(t.exitTime),
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${ctx.strategyId}-paper-trades.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function closeLivePosition(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    if (typeof ctx.closeOpenPosition !== 'function') {
      return res.status(400).json({ ok: false, error: 'Manual close not supported for this strategy' });
    }
    if (typeof ctx.ensureRunning === 'function') {
      await ctx.ensureRunning();
    }
    const result = await ctx.closeOpenPosition({ reason: 'MANUAL_CLOSE' });
    if (typeof ctx.recalcWallet === 'function') {
      await ctx.recalcWallet();
    }
    return res.json({
      ...result,
      ok: true,
      message: result?.trade?.pnl != null
        ? `Position closed. Realized P/L ₹${Number(result.trade.pnl).toFixed(2)}`
        : 'Position closed',
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getLiveMeta(req, res) {
  try {
    const ctx = getLiveContext(req);
    const snapshot = ctx?.getEngineSnapshot?.() || null;
    const symbol = String(
      req.query.symbol || snapshot?.settings?.symbol || snapshot?.symbol || 'NIFTY',
    ).toUpperCase();
    const clock = getIstClock(new Date());
    const lotSize = await getCurrentLotSize(symbol);
    let expiry = null;
    if (isStraddleLiveStrategyId(ctx?.strategyId)) {
      expiry = await getNextWeeklyExpiry(symbol, clock.dateKey);
      if (snapshot?.expiry) expiry = snapshot.expiry;
    } else if (isPutBuyLiveStrategyId(ctx?.strategyId)) {
      expiry = await getNearestWeeklyExpiry(symbol);
      if (snapshot?.expiry) expiry = snapshot.expiry;
    } else {
      expiry = await getNearestWeeklyExpiry(symbol);
    }
    let chainSpot = null;
    let ceLtp = null;
    let peLtp = null;
    if (expiry) {
      try {
        const data = await getAtmPremiums({ symbol, strike: 0, expiry });
        chainSpot = data.chainSpot;
        ceLtp = data.ceLtp;
        peLtp = data.peLtp;
      } catch {
        // best-effort
      }
    }
    return res.json({ ok: true, symbol, lotSize, expiry, chainSpot, ceLtp, peLtp });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getStatus,
  startLive,
  stopLive,
  saveLiveSettings,
  resetWallet,
  listTrades,
  exportTradesExcel,
  getLiveMeta,
  closeLivePosition,
  reopenLiveTrade,
};

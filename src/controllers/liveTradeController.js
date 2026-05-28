const ExcelJS = require('exceljs');
const LiveWallet = require('../models/liveWallet');
const LivePaperTrade = require('../models/livePaperTrade');
const strategyTwoEngine = require('../services/liveShortStraddleEngine');
const strategyThreeEngine = require('../services/liveIvMeanReversionEngine');
const { STRATEGY_THREE_IV_LIVE_KEY } = require('../strategies/keys');
const {
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getAtmPremiums,
} = require('../services/dhanLiveService');

const LIVE_STRATEGIES = {
  'strategy-2': {
    strategyId: 'strategy-2',
    strategyKey: strategyTwoEngine.STRATEGY_KEY,
    startEngine: strategyTwoEngine.startEngine,
    stopEngine: strategyTwoEngine.stopEngine,
    updateEngineSettings: strategyTwoEngine.updateEngineSettings,
    getEngineSnapshot: strategyTwoEngine.getEngineSnapshot,
    ensureWallet: strategyTwoEngine.ensureWallet,
    recalcWallet: strategyTwoEngine.recalcWalletFromTrades,
    ensureRunning: strategyTwoEngine.ensureEngineRunning,
  },
  'strategy-4': {
    strategyId: 'strategy-4',
    strategyKey: strategyTwoEngine.STRATEGY_KEY,
    startEngine: strategyTwoEngine.startEngine,
    stopEngine: strategyTwoEngine.stopEngine,
    updateEngineSettings: strategyTwoEngine.updateEngineSettings,
    getEngineSnapshot: strategyTwoEngine.getEngineSnapshot,
    ensureWallet: strategyTwoEngine.ensureWallet,
    recalcWallet: strategyTwoEngine.recalcWalletFromTrades,
    ensureRunning: strategyTwoEngine.ensureEngineRunning,
  },
  'strategy-3': {
    strategyId: 'strategy-3',
    strategyKey: STRATEGY_THREE_IV_LIVE_KEY,
    startEngine: strategyThreeEngine.ensureEngineRunning,
    stopEngine: strategyThreeEngine.ensureEngineRunning,
    updateEngineSettings: strategyThreeEngine.updateEngineSettings,
    getEngineSnapshot: strategyThreeEngine.getEngineSnapshot,
    ensureWallet: strategyThreeEngine.ensureWallet,
    recalcWallet: strategyThreeEngine.recalcWalletFromTrades,
    ensureRunning: strategyThreeEngine.ensureEngineRunning,
  },
};

function getLiveContext(req) {
  const strategyId = String(req.params?.strategyId || 'strategy-2').toLowerCase();
  return LIVE_STRATEGIES[strategyId] || null;
}

async function getStatus(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    if (typeof ctx.ensureRunning === 'function') {
      await ctx.ensureRunning();
    }
    const wallet = await ctx.ensureWallet();
    const openTrade = await LivePaperTrade.findOne({
      strategyKey: ctx.strategyKey,
      exitTime: null,
    })
      .sort({ entryTime: -1 })
      .lean();
    const [chargesAgg] = await LivePaperTrade.aggregate([
      { $match: { strategyKey: ctx.strategyKey, exitTime: { $ne: null } } },
      { $group: { _id: null, totalCharges: { $sum: '$charges' } } },
    ]);
    const [pnlAgg] = await LivePaperTrade.aggregate([
      { $match: { strategyKey: ctx.strategyKey, exitTime: { $ne: null } } },
      { $group: { _id: null, netPnl: { $sum: '$pnl' }, wins: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } } } },
    ]);
    const snapshot = ctx.getEngineSnapshot();
    return res.json({
      ok: true,
      strategyId: ctx.strategyId,
      strategyKey: ctx.strategyKey,
      engine: snapshot,
      openPositionMark: snapshot.openPositionMark || null,
      wallet: {
        startingBalance: wallet.startingBalance,
        balance: wallet.balance,
        realizedPnl: wallet.realizedPnl,
        totalTrades: wallet.totalTrades,
        wins: wallet.wins,
        losses: wallet.losses,
        strategyNetPnl: Number(Number(pnlAgg?.[0]?.netPnl || 0).toFixed(2)),
        strategyWins: Number(pnlAgg?.[0]?.wins || 0),
        totalCharges: Number(Number(chargesAgg?.totalCharges || 0).toFixed(2)),
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

function coerceLiveEngineSetting(key, value) {
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
    await LivePaperTrade.deleteMany({ strategyKey: ctx.strategyKey });
    if (typeof ctx.recalcWallet === 'function') {
      await ctx.recalcWallet();
    } else {
      const wallet = await ctx.ensureWallet();
      await wallet.save();
    }
    const wallet = await ctx.ensureWallet();
    return res.json({ ok: true, wallet, message: `Cleared paper trades for ${ctx.strategyId}` });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function listTrades(req, res) {
  try {
    const ctx = getLiveContext(req);
    if (!ctx) return res.status(404).json({ ok: false, error: 'Unknown live strategy' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 25));
    const statusQ = String(req.query.status || '').toUpperCase();
    const filter = { strategyKey: ctx.strategyKey };
    if (statusQ === 'OPEN') {
      filter.exitTime = null;
    } else if (statusQ === 'CLOSED') {
      filter.exitTime = { $ne: null };
    } else if (statusQ === 'ALL') {
      // include open + closed
    } else {
      filter.exitTime = { $ne: null };
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
    return res.json({
      ok: true,
      trades,
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
    const trades = await LivePaperTrade.find({ strategyKey: ctx.strategyKey }).sort({ entryTime: -1 }).lean();
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

async function getLiveMeta(req, res) {
  try {
    const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
    const lotSize = await getCurrentLotSize(symbol);
    const expiry = await getNearestWeeklyExpiry(symbol);
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
};

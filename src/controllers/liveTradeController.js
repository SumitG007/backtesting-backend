const ExcelJS = require('exceljs');
const LiveWallet = require('../models/liveWallet');
const LivePaperTrade = require('../models/livePaperTrade');
const {
  startEngine,
  stopEngine,
  updateEngineSettings,
  getEngineSnapshot,
  ensureWallet,
} = require('../services/liveTradingEngine');
const {
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  getAtmPremiums,
} = require('../services/dhanLiveService');

async function getStatus(_req, res) {
  try {
    const wallet = await ensureWallet();
    const openTrade = await LivePaperTrade.findOne({ status: 'OPEN' }).lean();
    return res.json({
      ok: true,
      engine: getEngineSnapshot(),
      wallet: {
        startingBalance: wallet.startingBalance,
        balance: wallet.balance,
        realizedPnl: wallet.realizedPnl,
        totalTrades: wallet.totalTrades,
        wins: wallet.wins,
        losses: wallet.losses,
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
    const { symbol = 'NIFTY', settings = {} } = req.body || {};
    const result = await startEngine({ symbol, settings });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function stopLive(_req, res) {
  try {
    return res.json(stopEngine());
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function saveLiveSettings(req, res) {
  try {
    const settings = req.body?.settings || {};
    const numeric = {};
    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === 'string' && /Time$/.test(key)) {
        numeric[key] = value;
      } else {
        const n = Number(value);
        numeric[key] = Number.isFinite(n) ? n : value;
      }
    }
    const result = await updateEngineSettings(numeric);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function updateWallet(req, res) {
  return res.status(400).json({ ok: false, error: 'Wallet balance is managed by live trade P/L only' });
}

async function resetWallet(_req, res) {
  try {
    const wallet = await ensureWallet();
    wallet.startingBalance = 0;
    wallet.balance = 0;
    wallet.realizedPnl = 0;
    wallet.totalTrades = 0;
    wallet.wins = 0;
    wallet.losses = 0;
    wallet.lastResetAt = new Date();
    await wallet.save();
    // Force-close any open trades and wipe history.
    await LivePaperTrade.deleteMany({});
    return res.json({ ok: true, wallet });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function listTrades(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 25));
    const status = String(req.query.status || '').toUpperCase();
    const filter = {};
    if (status === 'OPEN' || status === 'CLOSED') filter.status = status;
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

async function exportTradesExcel(_req, res) {
  try {
    const trades = await LivePaperTrade.find().sort({ entryTime: -1 }).lean();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Live Paper Trades');
    sheet.columns = [
      { header: 'Strategy', key: 'strategyKey', width: 30 },
      { header: 'Symbol', key: 'symbol', width: 12 },
      { header: 'Side', key: 'side', width: 8 },
      { header: 'Option', key: 'optionType', width: 8 },
      { header: 'Strike', key: 'strike', width: 10 },
      { header: 'Expiry', key: 'expiryDate', width: 14 },
      { header: 'Lot Size', key: 'lotSize', width: 10 },
      { header: 'Lots', key: 'lots', width: 8 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Entry Premium', key: 'entryPremium', width: 16 },
      { header: 'Entry Spot', key: 'entrySpot', width: 12 },
      { header: 'Entry Time (IST)', key: 'entryTime', width: 22 },
      { header: 'Stop Loss Premium', key: 'stopLossPremium', width: 18 },
      { header: 'Target Premium', key: 'targetPremium', width: 16 },
      { header: 'Ref High', key: 'refHigh', width: 12 },
      { header: 'Ref Low', key: 'refLow', width: 12 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Exit Premium', key: 'exitPremium', width: 14 },
      { header: 'Exit Spot', key: 'exitSpot', width: 12 },
      { header: 'Exit Time (IST)', key: 'exitTime', width: 22 },
      { header: 'Reason', key: 'reason', width: 14 },
      { header: 'Invested (Rs)', key: 'investedAmount', width: 14 },
      { header: 'Final Value (Rs)', key: 'finalValue', width: 16 },
      { header: 'Tax / Charges (Rs)', key: 'charges', width: 18 },
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

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="live-paper-trades.xlsx"');
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
        const data = await getAtmPremiums({
          symbol,
          strike: 0, // will return spot regardless of strike match
          expiry,
        });
        chainSpot = data.chainSpot;
        ceLtp = data.ceLtp;
        peLtp = data.peLtp;
      } catch {
        // ignore — meta endpoint best-effort
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
  updateWallet,
  resetWallet,
  listTrades,
  exportTradesExcel,
  getLiveMeta,
};

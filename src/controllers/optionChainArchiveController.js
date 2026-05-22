const {
  DEFAULT_ARCHIVE_EXPIRIES,
  DEFAULT_ARCHIVE_SYMBOL,
} = require('../config/optionChainArchive');
const {
  getRecorderStatus,
  getLatestSnapshot,
  listSnapshots,
  getSnapshotById,
  getArchiveStats,
  isWithinNseCashSession,
  getArchivePageStatus,
} = require('../services/optionChainArchiveService');

function getConfig(req, res) {
  return res.json({
    ok: true,
    symbol: DEFAULT_ARCHIVE_SYMBOL,
    expiries: DEFAULT_ARCHIVE_EXPIRIES,
    expiryLabels: {
      '2026-05-26': '26 May 2026',
      '2026-06-02': '2 June 2026',
    },
    marketSessionOpen: isWithinNseCashSession(),
    fieldsPerLeg: [
      'last_price',
      'oi',
      'volume',
      'previous_oi',
      'previous_volume',
      'top_bid_price',
      'top_bid_quantity',
      'top_ask_price',
      'top_ask_quantity',
      'average_price',
      'implied_volatility',
      'greeks',
      'security_id',
    ],
  });
}

function getRecorder(req, res) {
  return res.json({ ok: true, recorder: getRecorderStatus() });
}

async function getLatest(req, res) {
  try {
    const symbol = String(req.query.symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
    // `expiry` query is a read-only display filter — recorder always saves all configured expiries.
    const expiry = String(req.query.expiry || DEFAULT_ARCHIVE_EXPIRIES[0]).slice(0, 10);
    const status = getArchivePageStatus({ symbol, expiry });
    const row = await getLatestSnapshot({ symbol, expiry });
    if (!row) {
      const message = status.marketSessionOpen
        ? (status.lastError || 'Waiting for first capture — recorder is running.')
        : 'Market is closed. Keep the backend running — fetching resumes automatically at 9:15 AM IST.';
      return res.json({
        ok: true,
        snapshot: null,
        status,
        message,
        code: status.lastErrorCode || (status.marketSessionOpen ? 'NO_DATA' : 'MARKET_CLOSED'),
      });
    }
    return res.json({ ok: true, snapshot: row, status, message: null, code: null });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, code: 'SERVER_ERROR' });
  }
}

async function getSnapshotsList(req, res) {
  try {
    const symbol = String(req.query.symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
    const expiry = String(req.query.expiry || DEFAULT_ARCHIVE_EXPIRIES[0]).slice(0, 10);
    const limit = Number(req.query.limit) || 50;
    const before = req.query.before || null;
    const rows = await listSnapshots({ symbol, expiry, limit, before });
    return res.json({ ok: true, symbol, expiry, snapshots: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getSnapshotDetail(req, res) {
  try {
    if (!req.params.id || !/^[a-f\d]{24}$/i.test(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'Invalid snapshot id', code: 'INVALID_ID' });
    }
    const row = await getSnapshotById(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Snapshot not found', code: 'NOT_FOUND' });
    return res.json({ ok: true, snapshot: row });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, code: 'SERVER_ERROR' });
  }
}

async function getStats(req, res) {
  try {
    const symbol = String(req.query.symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
    const stats = await getArchiveStats({ symbol });
    return res.json({ ok: true, symbol, stats, recorder: getRecorderStatus() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getConfig,
  getRecorder,
  getLatest,
  getSnapshotsList,
  getSnapshotDetail,
  getStats,
};

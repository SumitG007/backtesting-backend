const {
  DEFAULT_ARCHIVE_EXPIRIES,
  DEFAULT_ARCHIVE_SYMBOL,
} = require('../config/optionChainArchive');
const {
  getRecorderStatus,
  getLatestSnapshot,
  listSnapshots,
  listAvailableTimes,
  getSnapshotById,
  getArchiveStats,
  isWithinCaptureWindow,
  getArchivePageStatus,
  purgeInvalidSnapshots,
  normalizeIstTimeQuery,
  CAPTURE_TIME_SLOTS,
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
    captureWindowOpen: isWithinCaptureWindow(),
    marketSessionOpen: isWithinCaptureWindow(),
    captureWindows: {
      open: '09:15–09:30 IST',
      close: '15:15–15:30 IST',
    },
    timeSlots: CAPTURE_TIME_SLOTS,
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
    const expiry = String(req.query.expiry || DEFAULT_ARCHIVE_EXPIRIES[0]).slice(0, 10);
    const istTime = req.query.istTime || req.query.time || null;
    const dateKey = req.query.dateKey || null;
    const status = getArchivePageStatus({ symbol, expiry });
    const timeKey = istTime ? normalizeIstTimeQuery(istTime) : null;
    if (istTime && !timeKey) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid time — only 9:15–9:30 or 15:15–15:30 IST',
        code: 'INVALID_TIME',
      });
    }

    const row = await getLatestSnapshot({ symbol, expiry, istTime: timeKey, dateKey });
    if (!row) {
      const timeHint = timeKey ? ` at ${timeKey} IST` : '';
      const message = status.captureWindowOpen
        ? (status.lastError || `Waiting for first capture${timeHint} — recorder runs 9:15–9:30 & 15:15–15:30 only.`)
        : `Outside capture windows${timeHint}. Data is stored only 9:15–9:30 and 15:15–15:30 IST. Pick a time slot below when available.`;
      return res.json({
        ok: true,
        snapshot: null,
        status,
        message,
        code: status.lastErrorCode || (status.captureWindowOpen ? 'NO_DATA' : 'OUTSIDE_CAPTURE_WINDOW'),
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
    const istTime = req.query.istTime || req.query.time || null;
    const dateKey = req.query.dateKey || null;
    const rows = await listSnapshots({ symbol, expiry, limit, before, istTime, dateKey });
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

async function getAvailableTimes(req, res) {
  try {
    const symbol = String(req.query.symbol || DEFAULT_ARCHIVE_SYMBOL).toUpperCase();
    const expiry = String(req.query.expiry || DEFAULT_ARCHIVE_EXPIRIES[0]).slice(0, 10);
    const dateKey = req.query.dateKey || null;
    const rows = await listAvailableTimes({ symbol, expiry, dateKey });
    const byDate = {};
    for (const r of rows) {
      if (!byDate[r.dateKey]) byDate[r.dateKey] = [];
      if (!byDate[r.dateKey].includes(r.istTime)) byDate[r.dateKey].push(r.istTime);
    }
    for (const dk of Object.keys(byDate)) {
      byDate[dk].sort((a, b) => a.localeCompare(b));
    }
    return res.json({ ok: true, symbol, expiry, byDate, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postPurge(req, res) {
  try {
    const result = await purgeInvalidSnapshots();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
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
  getAvailableTimes,
  postPurge,
  getSnapshotDetail,
  getStats,
};

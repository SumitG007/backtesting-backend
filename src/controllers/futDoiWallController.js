const futEngine = require('../services/futDoiWallEngine');

async function getFutDoiWallStatus(_req, res) {
  try {
    const data = await futEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFutDoiWallBook(_req, res) {
  try {
    const data = await futEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFutDoiWallTrades(req, res) {
  try {
    const data = await futEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postFutDoiWallEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await futEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchFutDoiWallSettings(req, res) {
  try {
    const data = await futEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postFutDoiWallClose(_req, res) {
  try {
    const trade = await futEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getFutDoiWallStatus,
  getFutDoiWallBook,
  getFutDoiWallTrades,
  postFutDoiWallEnabled,
  patchFutDoiWallSettings,
  postFutDoiWallClose,
};

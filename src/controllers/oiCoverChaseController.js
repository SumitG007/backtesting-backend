const occEngine = require('../services/oiCoverChaseEngine');

async function getOiCoverChaseStatus(_req, res) {
  try {
    const data = await occEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiCoverChaseBook(_req, res) {
  try {
    const data = await occEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiCoverChaseTrades(req, res) {
  try {
    const data = await occEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiCoverChaseEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await occEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiCoverChaseSettings(req, res) {
  try {
    const data = await occEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiCoverChaseClose(_req, res) {
  try {
    const trade = await occEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiCoverChaseStatus,
  getOiCoverChaseBook,
  getOiCoverChaseTrades,
  postOiCoverChaseEnabled,
  patchOiCoverChaseSettings,
  postOiCoverChaseClose,
};

const autoEngine = require('../services/oiFlowAutoEngine');

async function getOiFlowAutoStatus(_req, res) {
  try {
    const data = await autoEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowAutoBook(_req, res) {
  try {
    const data = await autoEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowAutoTrades(req, res) {
  try {
    const data = await autoEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiFlowAutoEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await autoEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiFlowAutoSettings(req, res) {
  try {
    const data = await autoEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiFlowAutoClose(_req, res) {
  try {
    const trade = await autoEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowAutoStatus,
  getOiFlowAutoBook,
  getOiFlowAutoTrades,
  postOiFlowAutoEnabled,
  patchOiFlowAutoSettings,
  postOiFlowAutoClose,
};

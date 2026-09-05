const contEngine = require('../services/oiFlowContinuationEngine');

async function getOiFlowContinuationStatus(_req, res) {
  try {
    const data = await contEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowContinuationBook(_req, res) {
  try {
    const data = await contEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowContinuationTrades(req, res) {
  try {
    const data = await contEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiFlowContinuationEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await contEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiFlowContinuationSettings(req, res) {
  try {
    const data = await contEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiFlowContinuationClose(_req, res) {
  try {
    const trade = await contEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowContinuationStatus,
  getOiFlowContinuationBook,
  getOiFlowContinuationTrades,
  postOiFlowContinuationEnabled,
  patchOiFlowContinuationSettings,
  postOiFlowContinuationClose,
};

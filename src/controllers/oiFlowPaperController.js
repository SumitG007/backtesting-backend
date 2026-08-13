const paperEngine = require('../services/oiFlowPaperEngine');

async function getOiFlowPaperStatus(_req, res) {
  try {
    const data = await paperEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowPaperBook(_req, res) {
  try {
    const data = await paperEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowPaperTrades(req, res) {
  try {
    const data = await paperEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiFlowPaperEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await paperEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiFlowPaperSettings(req, res) {
  try {
    const data = await paperEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiFlowPaperClose(_req, res) {
  try {
    const trade = await paperEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowPaperStatus,
  getOiFlowPaperBook,
  getOiFlowPaperTrades,
  postOiFlowPaperEnabled,
  patchOiFlowPaperSettings,
  postOiFlowPaperClose,
};

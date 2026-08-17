const paperEngine = require('../services/oiFlowBbBouncePaperEngine');

async function getOiFlowBbBouncePaperStatus(_req, res) {
  try {
    const data = await paperEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowBbBouncePaperBook(_req, res) {
  try {
    const data = await paperEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowBbBouncePaperTrades(req, res) {
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

async function postOiFlowBbBouncePaperEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await paperEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiFlowBbBouncePaperSettings(req, res) {
  try {
    const data = await paperEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiFlowBbBouncePaperClose(_req, res) {
  try {
    const trade = await paperEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowBbBouncePaperStatus,
  getOiFlowBbBouncePaperBook,
  getOiFlowBbBouncePaperTrades,
  postOiFlowBbBouncePaperEnabled,
  patchOiFlowBbBouncePaperSettings,
  postOiFlowBbBouncePaperClose,
};

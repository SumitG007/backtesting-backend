const ebEngine = require('../services/oiFlowEbEngine');

async function getOiFlowEbStatus(_req, res) {
  try {
    const data = await ebEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowEbBook(_req, res) {
  try {
    const data = await ebEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowEbTrades(req, res) {
  try {
    const data = await ebEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiFlowEbEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await ebEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiFlowEbSettings(req, res) {
  try {
    const data = await ebEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiFlowEbClose(_req, res) {
  try {
    const trade = await ebEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowEbStatus,
  getOiFlowEbBook,
  getOiFlowEbTrades,
  postOiFlowEbEnabled,
  patchOiFlowEbSettings,
  postOiFlowEbClose,
};

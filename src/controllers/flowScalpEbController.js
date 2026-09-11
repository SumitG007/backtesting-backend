const scalpEngine = require('../services/flowScalpEbEngine');

async function getFlowScalpEbStatus(_req, res) {
  try {
    const data = await scalpEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFlowScalpEbBook(_req, res) {
  try {
    const data = await scalpEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFlowScalpEbTrades(req, res) {
  try {
    const data = await scalpEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postFlowScalpEbEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await scalpEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchFlowScalpEbSettings(req, res) {
  try {
    const data = await scalpEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postFlowScalpEbClose(_req, res) {
  try {
    const trade = await scalpEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getFlowScalpEbStatus,
  getFlowScalpEbBook,
  getFlowScalpEbTrades,
  postFlowScalpEbEnabled,
  patchFlowScalpEbSettings,
  postFlowScalpEbClose,
};

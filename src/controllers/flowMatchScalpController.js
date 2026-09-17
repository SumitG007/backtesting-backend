const scalpEngine = require('../services/flowMatchScalpEngine');

async function getFlowMatchScalpStatus(_req, res) {
  try {
    const data = await scalpEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFlowMatchScalpBook(_req, res) {
  try {
    const data = await scalpEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFlowMatchScalpTrades(req, res) {
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

async function postFlowMatchScalpEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await scalpEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchFlowMatchScalpSettings(req, res) {
  try {
    const data = await scalpEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postFlowMatchScalpClose(_req, res) {
  try {
    const trade = await scalpEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getFlowMatchScalpStatus,
  getFlowMatchScalpBook,
  getFlowMatchScalpTrades,
  postFlowMatchScalpEnabled,
  patchFlowMatchScalpSettings,
  postFlowMatchScalpClose,
};

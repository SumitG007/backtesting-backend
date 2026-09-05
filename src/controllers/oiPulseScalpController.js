const opsEngine = require('../services/oiPulseScalpEngine');

async function getOiPulseScalpStatus(_req, res) {
  try {
    const data = await opsEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiPulseScalpBook(_req, res) {
  try {
    const data = await opsEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiPulseScalpTrades(req, res) {
  try {
    const data = await opsEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiPulseScalpEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await opsEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiPulseScalpSettings(req, res) {
  try {
    const data = await opsEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiPulseScalpClose(_req, res) {
  try {
    const trade = await opsEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiPulseScalpStatus,
  getOiPulseScalpBook,
  getOiPulseScalpTrades,
  postOiPulseScalpEnabled,
  patchOiPulseScalpSettings,
  postOiPulseScalpClose,
};

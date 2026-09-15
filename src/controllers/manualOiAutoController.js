const autoEngine = require('../services/manualOiAutoEngine');

async function getManualOiAutoStatus(_req, res) {
  try {
    const data = await autoEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualOiAutoBook(_req, res) {
  try {
    const data = await autoEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualOiAutoTrades(req, res) {
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

async function postManualOiAutoEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await autoEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchManualOiAutoSettings(req, res) {
  try {
    const data = await autoEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postManualOiAutoClose(_req, res) {
  try {
    const trade = await autoEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getManualOiAutoStatus,
  getManualOiAutoBook,
  getManualOiAutoTrades,
  postManualOiAutoEnabled,
  patchManualOiAutoSettings,
  postManualOiAutoClose,
};

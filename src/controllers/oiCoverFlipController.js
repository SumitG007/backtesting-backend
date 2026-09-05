const ocfEngine = require('../services/oiCoverFlipEngine');

async function getOiCoverFlipStatus(_req, res) {
  try {
    const data = await ocfEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiCoverFlipBook(_req, res) {
  try {
    const data = await ocfEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiCoverFlipTrades(req, res) {
  try {
    const data = await ocfEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiCoverFlipEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await ocfEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiCoverFlipSettings(req, res) {
  try {
    const data = await ocfEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiCoverFlipClose(_req, res) {
  try {
    const trade = await ocfEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiCoverFlipStatus,
  getOiCoverFlipBook,
  getOiCoverFlipTrades,
  postOiCoverFlipEnabled,
  patchOiCoverFlipSettings,
  postOiCoverFlipClose,
};

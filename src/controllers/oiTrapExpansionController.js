const oteEngine = require('../services/oiTrapExpansionEngine');

async function getOiTrapExpansionStatus(_req, res) {
  try {
    const data = await oteEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiTrapExpansionBook(_req, res) {
  try {
    const data = await oteEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiTrapExpansionTrades(req, res) {
  try {
    const data = await oteEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiTrapExpansionEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await oteEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchOiTrapExpansionSettings(req, res) {
  try {
    const data = await oteEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postOiTrapExpansionClose(_req, res) {
  try {
    const trade = await oteEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiTrapExpansionStatus,
  getOiTrapExpansionBook,
  getOiTrapExpansionTrades,
  postOiTrapExpansionEnabled,
  patchOiTrapExpansionSettings,
  postOiTrapExpansionClose,
};

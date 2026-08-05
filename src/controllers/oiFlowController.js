const oiFlowEngine = require('../services/oiFlowMinuteEngine');

async function getOiFlowStatus(_req, res) {
  try {
    const data = await oiFlowEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowToday(_req, res) {
  try {
    const data = await oiFlowEngine.listTodayRows();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowStatus,
  getOiFlowToday,
};

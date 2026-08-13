const oiFlowEngine = require('../services/oiFlowMinuteEngine');
const {
  listLiveSignals,
  forceBackfillLiveSignalsFromMinutes,
} = require('../services/oiFlowLiveSignalStore');
const { getIstClock } = require('../utils/dateTime');

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

async function getOiFlowSignals(req, res) {
  try {
    const clock = getIstClock(new Date());
    const raw = String(req.query.date || '').trim();
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : clock.dateKey;
    const data = await listLiveSignals(dateKey);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiFlowSignalsBackfill(req, res) {
  try {
    const clock = getIstClock(new Date());
    const raw = String(req.body?.date || req.query?.date || '').trim();
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : clock.dateKey;
    const data = await forceBackfillLiveSignalsFromMinutes(dateKey);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowStatus,
  getOiFlowToday,
  getOiFlowSignals,
  postOiFlowSignalsBackfill,
};

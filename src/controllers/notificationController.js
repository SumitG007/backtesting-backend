const { listToday, clearNotifications } = require('../services/notificationHub');

function getTodayNotifications(_req, res) {
  try {
    const payload = listToday();
    return res.json({ ok: true, ...payload });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to load notifications' });
  }
}

function clearTodayNotifications(req, res) {
  try {
    const strategy = req.body?.strategy || req.query?.strategy || null;
    const payload = clearNotifications({ strategy });
    return res.json({ ok: true, ...payload });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to clear notifications' });
  }
}

module.exports = { getTodayNotifications, clearTodayNotifications };

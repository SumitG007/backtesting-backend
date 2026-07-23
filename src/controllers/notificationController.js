const { listToday } = require('../services/notificationHub');

function getTodayNotifications(_req, res) {
  try {
    const payload = listToday();
    return res.json({ ok: true, ...payload });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Failed to load notifications' });
  }
}

module.exports = { getTodayNotifications };

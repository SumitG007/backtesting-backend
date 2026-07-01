const {
  isConfigured,
  getDashboardData,
  getSetupHint,
  drishtiErrorMessage,
} = require('../services/drishtiService');

async function getDrishtiDashboard(req, res) {
  try {
    if (!isConfigured()) {
      return res.json({
        ok: true,
        ...getSetupHint(),
      });
    }

    const fnoOnly = String(req.query.fnoOnly ?? 'true').toLowerCase() !== 'false';
    const data = await getDashboardData({ fnoOnly });
    return res.json({ ok: true, ...data });
  } catch (error) {
    if (error.code === 'DRISHTI_NOT_CONFIGURED') {
      return res.json({ ok: true, ...getSetupHint() });
    }
    return res.status(error.response?.status || 500).json({
      ok: false,
      configured: true,
      error: drishtiErrorMessage(error),
    });
  }
}

module.exports = {
  getDrishtiDashboard,
};

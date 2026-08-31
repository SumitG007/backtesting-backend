const chartHistory = require('../services/liquidityChartHistoryService');

async function getLiquidityOiChaseChart(_req, res) {
  try {
    const data = await chartHistory.getWeekChartPayload();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getLiquidityOiChaseChart,
};

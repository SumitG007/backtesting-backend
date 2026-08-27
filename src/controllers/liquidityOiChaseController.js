const paperEngine = require('../services/liveLiquidityOiChaseEngine');
const chartHistory = require('../services/liquidityChartHistoryService');

async function getLiquidityOiChaseStatus(_req, res) {
  try {
    const chart = chartHistory.getStatus();
    return res.json({
      ok: true,
      strategyPaused: true,
      chart,
      note: 'Liquidity strategy paused — chart history only.',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseChart(_req, res) {
  try {
    const data = await chartHistory.getWeekChartPayload();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseBook(_req, res) {
  try {
    const chart = await chartHistory.getWeekChartPayload();
    return res.json({
      ok: true,
      strategyPaused: true,
      enabled: false,
      openTrades: [],
      signal: null,
      settings: { symbol: chart.symbol },
      wallet: null,
      dateKey: chart.dateKey,
      chart,
      note: 'Strategy paused — no entries / open positions.',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseTrades(_req, res) {
  return res.json({
    ok: true,
    trades: [],
    total: 0,
    page: 1,
    pageSize: 20,
    pagination: { page: 1, pageSize: 20, totalPages: 1, totalRows: 0 },
    note: 'Strategy paused — trade history hidden.',
  });
}

async function postLiquidityOiChaseEnabled(_req, res) {
  return res.json({
    ok: true,
    enabled: false,
    note: 'Strategy paused — enable will return when rules are rebuilt.',
  });
}

async function patchLiquidityOiChaseSettings(_req, res) {
  return res.json({
    ok: true,
    settings: { symbol: 'NIFTY' },
    note: 'Strategy paused — settings locked for now.',
  });
}

async function postLiquidityOiChaseClose(_req, res) {
  try {
    if (typeof paperEngine.closeOpenTradeManual === 'function') {
      const trade = await paperEngine.closeOpenTradeManual('STRATEGY_PAUSED');
      return res.json({ ok: true, trade, note: 'Closed leftover open trade (strategy paused).' });
    }
    return res.json({ ok: true, trade: null, note: 'Strategy paused.' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getLiquidityOiChaseStatus,
  getLiquidityOiChaseChart,
  getLiquidityOiChaseBook,
  getLiquidityOiChaseTrades,
  postLiquidityOiChaseEnabled,
  patchLiquidityOiChaseSettings,
  postLiquidityOiChaseClose,
};

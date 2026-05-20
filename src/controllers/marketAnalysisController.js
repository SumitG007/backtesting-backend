const { runMultiYearAnalysis, DEFAULT_YEARS } = require('../analysis/runMultiYearAnalysis');

function parseYearsInput(raw) {
  if (Array.isArray(raw) && raw.length) {
    return raw.map(Number).filter((y) => y >= 2000 && y <= 2100);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(/[,;\s]+/)
      .map(Number)
      .filter((y) => y >= 2000 && y <= 2100);
  }
  return [...DEFAULT_YEARS];
}

async function runMarketAnalysis(req, res) {
  try {
    const symbol = String(req.body?.symbol || req.query?.symbol || 'NIFTY').toUpperCase();
    const interval = String(req.body?.interval || req.query?.interval || '5');
    if (!['1', '5', '15'].includes(interval)) {
      return res.status(400).json({ ok: false, error: 'interval must be 1, 5, or 15' });
    }
    const years = parseYearsInput(req.body?.years ?? req.query?.years);

    const result = await runMultiYearAnalysis({ symbol, interval, years });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({
        ok: false,
        error: 'Dhan API error',
        details: error.response.data,
      });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
}

function getMarketAnalysisMeta(req, res) {
  res.json({
    ok: true,
    module: 'market-analysis',
    defaultYears: DEFAULT_YEARS,
    description:
      'Loads multi-year intraday candles, computes per-day behaviour, ranks patterns, and suggests rules with a prototype index-points backtest.',
  });
}

module.exports = {
  runMarketAnalysis,
  getMarketAnalysisMeta,
};

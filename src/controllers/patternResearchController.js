const { runPatternResearch } = require('../research/runPatternResearch');
const { runMultiScenarioResearch } = require('../research/runMultiScenarioResearch');
const { formatPatternResearchReport } = require('../research/formatReport');

async function getPatternResearch(req, res) {
  try {
    const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
    const interval = String(req.query.interval || '5');
    const years = req.query.years
      ? String(req.query.years)
          .split(',')
          .map((y) => Number(y.trim()))
          .filter(Number.isFinite)
      : undefined;
    const minSamples = req.query.minSamples != null ? Number(req.query.minSamples) : undefined;
    const topN = req.query.topN != null ? Number(req.query.topN) : undefined;
    const targetPoints = req.query.targetPoints != null ? Number(req.query.targetPoints) : undefined;
    const stopPoints = req.query.stopPoints != null ? Number(req.query.stopPoints) : undefined;
    const horizonBars = req.query.horizonBars != null ? Number(req.query.horizonBars) : undefined;

    const seqLens = req.query.sequenceLengths
      ? String(req.query.sequenceLengths)
          .split(',')
          .map((n) => Number(n.trim()))
          .filter((n) => n >= 2 && n <= 5)
      : undefined;

    const result = await runPatternResearch({
      symbol,
      interval,
      years,
      minSamples,
      sequenceLengths: seqLens,
      topN,
      preferApi: req.query.preferApi === '1' || req.query.preferApi === 'true',
      outcome: {
        targetPoints,
        stopPoints,
        horizonBars,
        barIntervalMinutes: Number(interval) || 5,
      },
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Pattern research failed' });
  }
}

async function getPatternResearchReport(req, res) {
  try {
    const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
    const interval = String(req.query.interval || '5');

    const result = await runPatternResearch({
      symbol,
      interval,
      preferApi: req.query.preferApi === '1',
    });

    res.type('text/plain').send(formatPatternResearchReport(result));
  } catch (err) {
    res.status(500).type('text/plain').send(err.message || 'Pattern research failed');
  }
}

async function getMultiScenarioResearch(req, res) {
  try {
    const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
    const interval = String(req.query.interval || '5');
    const result = await runMultiScenarioResearch({
      symbol,
      interval,
      preferApi: req.query.preferApi === '1',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Multi-scenario research failed' });
  }
}

module.exports = {
  getPatternResearch,
  getPatternResearchReport,
  getMultiScenarioResearch,
};

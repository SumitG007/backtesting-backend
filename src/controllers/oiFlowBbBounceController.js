const { runBbBounceBacktest, DATES } = require('../services/oiFlowBbBounceEngine');

async function getOiFlowBbBounceBacktest(req, res) {
  try {
    const raw = String(req.query.dates || '').trim();
    const dateKeys = raw
      ? raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
      : DATES;
    const data = await runBbBounceBacktest(dateKeys.length ? dateKeys : DATES);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = { getOiFlowBbBounceBacktest };

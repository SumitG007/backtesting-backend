/**
 * Multi-year analytics for Strategy 4 (all years, popup report).
 */

const { getLotSize, getStrikeStep } = require('../utils/market');
const { parseNumberInput, parseStringInput, parseBooleanInput } = require('./backtest/parsers');
const {
  runStrategyFourMultiYearAnalysis,
  DEFAULT_YEARS,
} = require('../analysis/runStrategyFourMultiYearAnalysis');

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

function buildAnalysisSettings(req) {
  const { symbol = 'NIFTY' } = req.body || {};
  const rawIv = String(parseStringInput(req.body?.interval, '5'));
  const interval = ['1', '5', '15'].includes(rawIv) ? rawIv : '5';

  return {
    symbol: String(symbol).toUpperCase(),
    interval,
    strikeMode: parseStringInput(req.body?.strikeMode, 'ATM'),
    stopLossPoints: parseNumberInput(req.body?.stopLossPoints, 22),
    targetProfitPoints: parseNumberInput(req.body?.targetProfitPoints, 70),
    basePremiumPct: parseNumberInput(req.body?.basePremiumPct, 0.5),
    premiumLeverage: parseNumberInput(req.body?.premiumLeverage, 8),
    lotCount: parseNumberInput(req.body?.lotCount, 1),
    lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
    strikeStep: parseNumberInput(req.body?.strikeStep, getStrikeStep(symbol)),
    perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
    skipGapUpPe: parseBooleanInput(req.body?.skipGapUpPe, true),
    skipGapDownCe: parseBooleanInput(req.body?.skipGapDownCe, false),
  };
}

async function runStrategyFourAnalysis(req, res) {
  try {
    const settings = buildAnalysisSettings(req);
    const years = parseYearsInput(req.body?.years);
    const report = await runStrategyFourMultiYearAnalysis({ settings, years });
    return res.json({ ok: true, report });
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

module.exports = {
  runStrategyFourAnalysis,
};

const { buildValidationReport } = require('./buildValidationReport');
const { createRunBacktestForYear } = require('./runBacktestForYear');

const VALIDATION_YEARS = [2022, 2023, 2024, 2025, 2026];

const VALIDATION_ASSUMPTIONS = [
  'Uses your current form settings, replayed for each calendar year (2022–2026).',
  'Backtest uses candle-level execution and modeled option premium movement.',
  'Real fills, slippage, spread, IV/theta shifts, and charges can reduce live performance.',
];

/**
 * Run backtest per year (no DB persist) and build validation stats per year + combined.
 * @param {{
 *   strategyKey: string,
 *   settings: Record<string, unknown>,
 *   years?: number[],
 *   runBacktestForYear?: (year: number, settings: Record<string, unknown>) => Promise<{ trades?: unknown[] }>,
 * }} opts
 */
async function runMultiYearValidation({ strategyKey, settings, years = VALIDATION_YEARS, runBacktestForYear }) {
  const safeYears = (years?.length ? years : VALIDATION_YEARS).map(Number).filter(Number.isFinite);
  const runYear = runBacktestForYear || createRunBacktestForYear(strategyKey);
  const byYear = [];
  const allTrades = [];
  const errors = [];

  for (const year of safeYears) {
    try {
      const result = await runYear(year, settings);
      const trades = Array.isArray(result?.trades) ? result.trades : [];
      allTrades.push(...trades);
      byYear.push({
        year,
        validation: buildValidationReport(trades),
        tradeCount: trades.length,
      });
    } catch (err) {
      const message = err.message || String(err);
      errors.push({ year, error: message });
      byYear.push({
        year,
        error: message,
        validation: buildValidationReport([]),
        tradeCount: 0,
      });
    }
  }

  byYear.sort((a, b) => a.year - b.year);

  const combined = buildValidationReport(allTrades);
  return {
    validation: {
      ...combined,
      assumptions: VALIDATION_ASSUMPTIONS,
    },
    byYear,
    years: safeYears,
    errors,
  };
}

module.exports = {
  runMultiYearValidation,
  VALIDATION_YEARS,
  VALIDATION_ASSUMPTIONS,
};

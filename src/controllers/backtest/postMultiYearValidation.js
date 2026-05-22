const { runMultiYearValidation } = require('./multiYearValidation');
const { createRunBacktestForYear } = require('./runBacktestForYear');

/**
 * POST /api/strategyN/validation — same settings as /run, backtest each year 2022–2026.
 * @param {{ strategyKey: string, buildSettings: (req: import('express').Request) => { settings: Record<string, unknown> } }} opts
 */
function createPostMultiYearValidationHandler({ strategyKey, buildSettings }) {
  return async function postMultiYearValidation(req, res) {
    try {
      const { settings } = buildSettings(req);
      const report = await runMultiYearValidation({
        strategyKey,
        settings,
        runBacktestForYear: createRunBacktestForYear(strategyKey),
      });
      return res.json({
        ok: true,
        strategyKey,
        validation: report.validation,
        byYear: report.byYear,
        years: report.years,
        errors: report.errors,
      });
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
  };
}

module.exports = { createPostMultiYearValidationHandler };

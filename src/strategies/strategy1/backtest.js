/**
 * Strategy 1 — backtest entry point (you will add rules here).
 *
 * Contract: given OHLCV `candles` and normalized `settings`, return
 * `{ trades, summary }` where `summary` matches `buildStrategyRunSummary` shape.
 *
 * HTTP handlers live in `controllers/backtest/strategyOneHandlers.js`.
 */

const { buildStrategyRunSummary } = require('../shared/summary');

/**
 * @param {{ candles: unknown[], settings: Record<string, unknown> }} _
 * @returns {{ trades: unknown[], summary: ReturnType<typeof buildStrategyRunSummary> }}
 */
function runStrategyOneBacktest({ candles, settings }) {
  void candles;
  void settings;
  return { trades: [], summary: buildStrategyRunSummary([]) };
}

module.exports = {
  runStrategyOneBacktest,
};

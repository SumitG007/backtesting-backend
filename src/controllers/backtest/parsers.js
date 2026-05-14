/** Shared request parsers for backtest controllers. */

function parseNumberInput(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringInput(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = String(value).trim();
  return parsed.length > 0 ? parsed : fallback;
}

module.exports = {
  parseNumberInput,
  parseStringInput,
};

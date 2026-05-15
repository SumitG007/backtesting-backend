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

/** Empty or non-positive → null (optional field, e.g. disabled target / stop). */
function parseOptionalPositiveNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

module.exports = {
  parseNumberInput,
  parseStringInput,
  parseOptionalPositiveNumber,
};

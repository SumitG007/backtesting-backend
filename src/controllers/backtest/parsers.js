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

function parseBooleanInput(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

module.exports = {
  parseNumberInput,
  parseStringInput,
  parseOptionalPositiveNumber,
  parseBooleanInput,
};

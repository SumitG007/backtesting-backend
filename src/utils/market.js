const { PRESET_SYMBOLS, DEFAULT_LOT_SIZES } = require('../config/constants');

function resolveSymbolConfig(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  const map = PRESET_SYMBOLS[resolvedSymbol];
  return {
    symbol: resolvedSymbol,
    securityId: map?.securityId,
    exchangeSegment: map?.exchangeSegment,
    instrument: map?.instrument || 'INDEX',
  };
}

function getLotSize(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  return DEFAULT_LOT_SIZES[resolvedSymbol] || 1;
}

function getStrikeStep(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  return resolvedSymbol === 'NIFTY' ? 50 : 100;
}

function getOptionPremiumFromSpotMove({
  side,
  entrySpot,
  currentSpot,
  entryPremium,
  premiumLeverage,
  strike,
  strikeStep,
}) {
  const safeEntrySpot = Number(entrySpot);
  const safeCurrentSpot = Number(currentSpot);
  const safePremium = Math.max(0.05, Number(entryPremium) || 0.05);
  const safeLeverage = Math.max(1, Number(premiumLeverage) || 8);
  const safeStrike = Number.isFinite(Number(strike)) ? Number(strike) : safeEntrySpot;
  const safeStrikeStep = Math.max(1, Number(strikeStep) || 50);
  if (!Number.isFinite(safeEntrySpot) || safeEntrySpot <= 0) return safePremium;
  if (!Number.isFinite(safeCurrentSpot) || safeCurrentSpot <= 0) return safePremium;

  const spotMove = safeCurrentSpot - safeEntrySpot;
  const directionalSpotMove = side === 'LONG' ? spotMove : -spotMove;
  const movePctAbs = (Math.abs(spotMove) / safeEntrySpot) * 100;

  const moneynessSteps = Math.abs(safeEntrySpot - safeStrike) / safeStrikeStep;
  const baseDelta = Math.max(0.22, 0.38 - Math.min(0.16, moneynessSteps * 0.06));
  const leverageScale = Math.min(1.75, Math.max(0.75, safeLeverage / 8));
  const gammaBoost = 1 + Math.min(0.2, movePctAbs * 0.25);
  const effectiveDelta = baseDelta * leverageScale * gammaBoost;

  const premiumChange = directionalSpotMove * effectiveDelta;
  return Math.max(0.05, safePremium + premiumChange);
}

function calculateEma(values, period) {
  const k = 2 / (period + 1);
  const out = Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (Number.isNaN(v)) continue;
    ema = ema === null ? v : v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

module.exports = {
  resolveSymbolConfig,
  getLotSize,
  getStrikeStep,
  getOptionPremiumFromSpotMove,
  calculateEma,
};

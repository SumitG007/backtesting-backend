/**
 * Optional entry quality filters (settings-driven, live-safe).
 */

const { calculateRsi, calculateEma, calculateAtr } = require('../shared/indicators');

function buildDayIndicators(dayBars, settings) {
  const rsiPeriod = Math.max(2, Number(settings.rsiPeriod) || 14);
  const emaPeriod = Math.max(5, Number(settings.emaFilterPeriod) || 20);
  const atrPeriod = Math.max(2, Number(settings.atrPeriod) || 14);
  const closes = dayBars.map((c) => Number(c[4]));
  return {
    rsi: calculateRsi(dayBars, rsiPeriod),
    ema: calculateEma(closes, emaPeriod),
    atr: calculateAtr(dayBars, atrPeriod),
  };
}

function hasActiveEntryFilters(settings) {
  return (
    settings.requireBearishBreakdownCandle === true ||
    settings.requireRsiOverbought === true ||
    settings.requireBelowEma === true ||
    settings.requireEmaSlopingDown === true ||
    Number(settings.minBreakBodyPct) > 0 ||
    Number(settings.minCloseInLowerRangePct) > 0 ||
    Number(settings.minAtrPoints) > 0 ||
    Number(settings.minSetupRisePoints) > 0 ||
    settings.requireRedDaySoFar === true
  );
}

function passesEntryFilters(dayBars, j, settings, indicators) {
  if (!hasActiveEntryFilters(settings)) return true;

  const bar = dayBars[j];
  const o = Number(bar[1]);
  const h = Number(bar[2]);
  const l = Number(bar[3]);
  const c = Number(bar[4]);
  if (![o, h, l, c].every(Number.isFinite)) return false;

  const range = h - l;
  if (range <= 0) return false;

  if (settings.requireBearishBreakdownCandle === true) {
    if (c >= o) return false;
  }

  const minBody = Number(settings.minBreakBodyPct);
  if (Number.isFinite(minBody) && minBody > 0) {
    const body = Math.abs(c - o);
    if (body / range < minBody) return false;
  }

  const minClosePos = Number(settings.minCloseInLowerRangePct);
  if (Number.isFinite(minClosePos) && minClosePos > 0) {
    const pos = (c - l) / range;
    if (pos > 1 - minClosePos / 100) return false;
  }

  const { rsi, ema, atr } = indicators;

  if (settings.requireRsiOverbought === true) {
    const minRsi = Number(settings.rsiMinEntry) || 55;
    const maxRsi = Number(settings.rsiMaxEntry) || 78;
    if (!Number.isFinite(rsi[j]) || rsi[j] < minRsi || rsi[j] > maxRsi) return false;
    if (Number.isFinite(rsi[j - 1]) && rsi[j] > rsi[j - 1]) return false;
  }

  if (settings.requireBelowEma === true && Number.isFinite(ema[j])) {
    if (c >= ema[j]) return false;
  }

  if (settings.requireEmaSlopingDown === true && Number.isFinite(ema[j]) && Number.isFinite(ema[j - 3])) {
    if (ema[j] >= ema[j - 3]) return false;
  }

  const minAtr = Number(settings.minAtrPoints);
  if (Number.isFinite(minAtr) && minAtr > 0 && Number.isFinite(atr[j]) && atr[j] < minAtr) return false;

  const minRise = Number(settings.minSetupRisePoints);
  if (settings.requireRedDaySoFar === true) {
    const dayOpen = Number(dayBars[0][1]);
    if (Number.isFinite(dayOpen) && c >= dayOpen) return false;
  }

  if (Number.isFinite(minRise) && minRise > 0) {
    const lb = Math.max(5, Number(settings.setupRiseLookback) || 12);
    const start = Math.max(0, j - lb);
    let hh = -Infinity;
    let ll = Infinity;
    for (let i = start; i < j; i += 1) {
      hh = Math.max(hh, Number(dayBars[i][2]));
      ll = Math.min(ll, Number(dayBars[i][3]));
    }
    if (hh - ll < minRise) return false;
  }

  return true;
}

module.exports = {
  buildDayIndicators,
  hasActiveEntryFilters,
  passesEntryFilters,
};

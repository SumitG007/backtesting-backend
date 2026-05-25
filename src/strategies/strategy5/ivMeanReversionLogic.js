/**
 * Shared IV mean reversion signal helpers (backtest + live paper).
 */
const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');

const M915 = 555;
const M945 = 585;
const M1000 = 600;
const M1100 = 660;
const M1200 = 720;
const EOD_EXIT = 920;
const SESSION_END = 930;
const MIN_HOLD_MS = 10 * 60 * 1000;

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Opening-range width 09:15–09:45 IST from candle rows [iso,o,h,l,c,v]. */
function orIvProxyFromBars(bars) {
  let hi = -Infinity;
  let lo = Infinity;
  let n = 0;
  for (const c of bars) {
    const m = getIstClock(c[0]).minutes;
    if (m < M915 || m > M945) continue;
    const h = Number(c[2]);
    const l = Number(c[3]);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    hi = Math.max(hi, h);
    lo = Math.min(lo, l);
    n += 1;
  }
  if (n < 2 || !Number.isFinite(hi)) return null;
  return hi - lo;
}

function buildOrIvByDayFromCandles(candles) {
  const intraByDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < M915 || clock.minutes > SESSION_END) continue;
    if (!intraByDay.has(clock.dateKey)) intraByDay.set(clock.dateKey, []);
    intraByDay.get(clock.dateKey).push(c);
  }
  const orIvByDay = new Map();
  for (const [dk, bars] of intraByDay) {
    bars.sort((a, b) => new Date(a[0]) - new Date(b[0]));
    const v = orIvProxyFromBars(bars);
    if (v != null && v > 0) orIvByDay.set(dk, v);
  }
  return orIvByDay;
}

function computeMedianOrIv(orIvByDay, sortedKeys, dayIndex, ivLookbackDays, minOrHistoryDays = 3) {
  const histOr = [];
  const lookback = Math.max(5, Math.min(60, Number(ivLookbackDays) || 20));
  const minDays = Math.max(2, Math.min(15, Number(minOrHistoryDays) || 3));
  for (let j = Math.max(0, dayIndex - lookback); j < dayIndex; j += 1) {
    const v = orIvByDay.get(sortedKeys[j]);
    if (v != null) histOr.push(v);
  }
  if (histOr.length < minDays) {
    return { medianOrIv: null, sampleSize: histOr.length, histOr };
  }
  return { medianOrIv: median(histOr), sampleSize: histOr.length, histOr };
}

function passesOrSpikeSignal({
  todayOr,
  medianOrIv,
  histOr,
  ivSpikeMultiplier,
  maxSpikeMultiplier,
  spikeMode,
  orPercentileMin,
}) {
  if (!todayOr || todayOr <= 0 || !medianOrIv || medianOrIv <= 0) return false;
  const maxSpike = Math.max(
    Number(ivSpikeMultiplier) || 1.15,
    Number(maxSpikeMultiplier) || 2.5,
  );
  if (todayOr > medianOrIv * maxSpike) return false;

  const spike = Math.max(1.05, Number(ivSpikeMultiplier) || 1.15);
  const multOk = todayOr >= medianOrIv * spike;
  const mode = String(spikeMode || 'either').toLowerCase();
  if (mode === 'multiplier') return multOk;

  const pctMin = Math.max(50, Math.min(90, Number(orPercentileMin) || 65));
  const pct =
    histOr.length > 0
      ? (histOr.filter((v) => v < todayOr).length / histOr.length) * 100
      : 0;
  const pctOk = pct >= pctMin;

  if (mode === 'percentile') return pctOk;
  return multOk || pctOk;
}

function evaluateOrSpikeSignal({
  todayOr,
  medianOrIv,
  histOr,
  ivSpikeMultiplier,
  maxSpikeMultiplier,
  spikeMode,
  orPercentileMin,
}) {
  if (!todayOr || todayOr <= 0 || !medianOrIv || medianOrIv <= 0) {
    return { ok: false, reason: 'INSUFFICIENT_OR_DATA', todayOr, medianOrIv };
  }
  const spike = Math.max(1.05, Number(ivSpikeMultiplier) || 1.15);
  const maxSpike = Math.max(spike + 0.1, Number(maxSpikeMultiplier) || 2.5);
  if (todayOr > medianOrIv * maxSpike) {
    return { ok: false, reason: 'ABOVE_MAX_SPIKE', todayOr, medianOrIv, maxSpike };
  }
  if (
    !passesOrSpikeSignal({
      todayOr,
      medianOrIv,
      histOr: histOr || [],
      ivSpikeMultiplier,
      maxSpikeMultiplier,
      spikeMode,
      orPercentileMin,
    })
  ) {
    return { ok: false, reason: 'BELOW_SPIKE_THRESHOLD', todayOr, medianOrIv, spike };
  }
  const mode = String(spikeMode || 'either').toLowerCase();
  const multOk = todayOr >= medianOrIv * spike;
  let reason = 'SPIKE_OK';
  if (mode === 'either') reason = multOk ? 'MULT_OK' : 'PERCENTILE_OK';
  else if (mode === 'percentile') reason = 'PERCENTILE_OK';
  else reason = 'MULT_OK';
  return { ok: true, reason, todayOr, medianOrIv, spike, maxSpike };
}

/** @deprecated use evaluateOrSpikeSignal with histOr */
function evaluateIvSpikeSignal(args) {
  return evaluateOrSpikeSignal({ ...args, histOr: [], spikeMode: 'multiplier' });
}

function isInEntryWindow(minutes, entryEndMinutes) {
  const end = Number.isFinite(entryEndMinutes) ? entryEndMinutes : M1200;
  return minutes >= M1000 && minutes <= end;
}

function isAfterOrWindow(minutes) {
  return minutes > M945;
}

function isEodExitTime(minutes) {
  return minutes >= EOD_EXIT;
}

function postEntrySpotRange(entrySpot, highSinceEntry, lowSinceEntry) {
  if (!Number.isFinite(entrySpot)) return null;
  const hi = Number.isFinite(highSinceEntry) ? highSinceEntry : entrySpot;
  const lo = Number.isFinite(lowSinceEntry) ? lowSinceEntry : entrySpot;
  return Math.max(0, hi - lo);
}

function normalizeIvSettings(raw = {}) {
  const rawTg = raw.targetVolCrushPct;
  const hasPremiumTarget =
    rawTg != null && rawTg !== '' && Number.isFinite(Number(rawTg)) && Number(rawTg) > 0;
  const targetVolCrushPct = hasPremiumTarget
    ? Math.min(90, Math.max(5, Number(rawTg)))
    : null;

  const rawSl = raw.stopVolExpandPct;
  const hasPremiumStop =
    rawSl != null && rawSl !== '' && Number.isFinite(Number(rawSl)) && Number(rawSl) > 0;
  const stopVolExpandPct = hasPremiumStop
    ? Math.min(200, Math.max(5, Number(rawSl)))
    : null;

  const spikeModeRaw = String(raw.spikeMode || 'either').toLowerCase();
  const spikeMode = ['multiplier', 'percentile', 'either'].includes(spikeModeRaw)
    ? spikeModeRaw
    : 'either';

  const entryToTime = String(raw.entryToTime || '12:00').trim() || '12:00';

  return {
    lotCount: Math.max(1, Number(raw.lotCount) || 1),
    perTradeCost: Number.isFinite(Number(raw.perTradeCost)) && Number(raw.perTradeCost) >= 0
      ? Number(raw.perTradeCost)
      : 100,
    ivLookbackDays: Math.max(5, Math.min(60, Number(raw.ivLookbackDays) || 20)),
    ivSpikeMultiplier: Math.max(1.05, Number(raw.ivSpikeMultiplier) || 1.15),
    maxSpikeMultiplier: Math.max(
      1.15,
      Math.max(Number(raw.ivSpikeMultiplier) || 1.15, Number(raw.maxSpikeMultiplier) || 2.5),
    ),
    ivExpandStopMult: Math.max(1.2, Number(raw.ivExpandStopMult) || 1.5),
    minOrHistoryDays: Math.max(2, Math.min(15, Number(raw.minOrHistoryDays) || 3)),
    entryToTime,
    entryEndMinutes: parseClockMinutes(entryToTime, M1200),
    spikeMode,
    orPercentileMin: Math.max(50, Math.min(90, Number(raw.orPercentileMin) || 65)),
    targetVolCrushPct,
    stopVolExpandPct,
    hasPremiumTarget,
    hasPremiumStop,
  };
}

function premiumTargetsFromCredit(entryCredit, settings) {
  const credit = Math.max(0.05, Number(entryCredit) || 0.05);
  const targetPremium = settings.hasPremiumTarget
    ? credit * (1 - settings.targetVolCrushPct / 100)
    : null;
  const stopLossPremium = settings.hasPremiumStop
    ? credit * (1 + settings.stopVolExpandPct / 100)
    : null;
  return { targetPremium, stopLossPremium };
}

module.exports = {
  M915,
  M945,
  M1000,
  M1100,
  M1200,
  EOD_EXIT,
  SESSION_END,
  MIN_HOLD_MS,
  median,
  orIvProxyFromBars,
  buildOrIvByDayFromCandles,
  computeMedianOrIv,
  passesOrSpikeSignal,
  evaluateOrSpikeSignal,
  evaluateIvSpikeSignal,
  isInEntryWindow,
  isAfterOrWindow,
  isEodExitTime,
  postEntrySpotRange,
  normalizeIvSettings,
  premiumTargetsFromCredit,
};

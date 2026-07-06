/**
 * Mine recurring candle-sequence patterns from intraday sessions.
 */

const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const { isNseCashTradingDay } = require('../services/nseHolidayService');
const { encodeDayBars, sequenceKey } = require('./candleEncoding');
const { measureForwardOutcome, aggregateOutcomes } = require('./forwardOutcomes');

const MORNING_END_MINUTES = 720; // 12:00 IST
const DEFAULT_MIN_SAMPLES = 35;

function tradingDayFilter(dayKey) {
  return !isWeekendDateKey(dayKey) && isNseCashTradingDay(dayKey);
}

function addToBucket(buckets, key, sample) {
  if (!key) return;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(sample);
}

/**
 * Session prefix: first N bars of the day predict entry on bar N+1.
 * Example: seqLen=3 → bars 0,1,2 pattern → trade bar 3 open.
 */
function mineSessionPrefixPatterns({
  intraByDay,
  symbol,
  seqLen,
  outcomeOpts,
  minSamples = DEFAULT_MIN_SAMPLES,
}) {
  const buckets = new Map();

  for (const [dayKey, bars] of intraByDay) {
    if (!tradingDayFilter(dayKey)) continue;
    if (bars.length < seqLen + 2) continue;

    const encoded = encodeDayBars(bars, symbol);
    const key = sequenceKey(encoded, 0, seqLen);
    const outcome = measureForwardOutcome(bars, seqLen - 1, outcomeOpts);
    if (!outcome) continue;

    addToBucket(buckets, key, { dayKey, context: 'session_prefix', startIdx: 0, outcome });
  }

  return finalizeBuckets(buckets, {
    minSamples,
    context: 'session_prefix',
    seqLen,
    labelPrefix: `First ${seqLen} bars`,
  });
}

/**
 * Sliding morning window: any consecutive N-bar sequence before 12:00 IST.
 */
function mineSlidingMorningPatterns({
  intraByDay,
  symbol,
  seqLen,
  outcomeOpts,
  minSamples = DEFAULT_MIN_SAMPLES,
}) {
  const buckets = new Map();

  for (const [dayKey, bars] of intraByDay) {
    if (!tradingDayFilter(dayKey)) continue;
    if (bars.length < seqLen + 2) continue;

    const encoded = encodeDayBars(bars, symbol);

    for (let start = 0; start <= bars.length - seqLen - 1; start += 1) {
      const endBar = bars[start + seqLen - 1];
      const closeMin = getIstClock(endBar[0]).minutes + (Number(outcomeOpts.barIntervalMinutes) || 5);
      if (closeMin > MORNING_END_MINUTES) break;

      const key = sequenceKey(encoded, start, seqLen);
      const outcome = measureForwardOutcome(bars, start + seqLen - 1, outcomeOpts);
      if (!outcome) continue;

      addToBucket(buckets, key, {
        dayKey,
        context: 'sliding_morning',
        startIdx: start,
        outcome,
      });
    }
  }

  return finalizeBuckets(buckets, {
    minSamples,
    context: 'sliding_morning',
    seqLen,
    labelPrefix: `Morning ${seqLen}-bar sequence`,
  });
}

/**
 * Dir-only sequences (U/D/F) — fewer combos, higher sample per pattern.
 */
function mineDirOnlyPrefixPatterns({
  intraByDay,
  symbol,
  seqLen,
  outcomeOpts,
  minSamples = DEFAULT_MIN_SAMPLES,
}) {
  const buckets = new Map();

  for (const [dayKey, bars] of intraByDay) {
    if (!tradingDayFilter(dayKey)) continue;
    if (bars.length < seqLen + 2) continue;

    const encoded = encodeDayBars(bars, symbol);
    const key = encoded
      .slice(0, seqLen)
      .map((e) => e?.dir || '?')
      .join('>');
    const outcome = measureForwardOutcome(bars, seqLen - 1, outcomeOpts);
    if (!outcome) continue;

    addToBucket(buckets, key, { dayKey, context: 'dir_prefix', startIdx: 0, outcome });
  }

  return finalizeBuckets(buckets, {
    minSamples,
    context: 'dir_prefix',
    seqLen,
    labelPrefix: `First ${seqLen} bar colours`,
  });
}

function pickBestSide(stats) {
  const long = stats.longWinRate;
  const short = stats.shortWinRate;
  if (long == null && short == null) return { side: null, winRate: null };
  if (long == null) return { side: 'PE', winRate: short };
  if (short == null) return { side: 'CE', winRate: long };
  if (long >= short) return { side: 'CE', winRate: long };
  return { side: 'PE', winRate: short };
}

function finalizeBuckets(buckets, meta) {
  const patterns = [];

  for (const [sequence, samples] of buckets.entries()) {
    const stats = aggregateOutcomes(samples);
    if (stats.sampleSize < meta.minSamples) continue;

    const best = pickBestSide(stats);
    const tradingDays = new Set(samples.map((s) => s.dayKey)).size;
    const monthsSpan = estimateMonths(samples);

    patterns.push({
      id: `${meta.context}_len${meta.seqLen}_${sequence.replace(/>/g, '_')}`,
      sequence,
      context: meta.context,
      sequenceLength: meta.seqLen,
      label: `${meta.labelPrefix}: ${sequence.replace(/>/g, ' → ')}`,
      ...stats,
      bestSide: best.side,
      bestWinRate: best.winRate,
      uniqueDays: tradingDays,
      occurrencesPerMonth: monthsSpan > 0 ? Number((stats.sampleSize / monthsSpan).toFixed(1)) : null,
      tradeable:
        best.winRate != null &&
        best.winRate >= 55 &&
        stats.sampleSize >= meta.minSamples &&
        (best.side === 'CE'
          ? stats.longWinRateStdAcrossYears <= 15
          : stats.shortWinRateStdAcrossYears <= 15),
    });
  }

  patterns.sort((a, b) => {
    const wr = (b.bestWinRate || 0) - (a.bestWinRate || 0);
    if (wr !== 0) return wr;
    return b.sampleSize - a.sampleSize;
  });

  return patterns;
}

function estimateMonths(samples) {
  const keys = samples.map((s) => s.dayKey).sort();
  if (!keys.length) return 0;
  const first = keys[0];
  const last = keys[keys.length - 1];
  const [y1, m1] = first.split('-').map(Number);
  const [y2, m2] = last.split('-').map(Number);
  return Math.max(1, (y2 - y1) * 12 + (m2 - m1) + 1);
}

function mineAllPatterns({ intraByDay, symbol, outcomeOpts, minSamples, sequenceLengths }) {
  const lens = sequenceLengths?.length ? sequenceLengths : [2, 3, 4];
  const all = [];

  for (const seqLen of lens) {
    all.push(
      ...mineSessionPrefixPatterns({ intraByDay, symbol, seqLen, outcomeOpts, minSamples }),
      ...mineDirOnlyPrefixPatterns({ intraByDay, symbol, seqLen, outcomeOpts, minSamples }),
      ...mineSlidingMorningPatterns({ intraByDay, symbol, seqLen, outcomeOpts, minSamples }),
    );
  }

  const deduped = new Map();
  for (const p of all) {
    const k = `${p.context}|${p.sequenceLength}|${p.sequence}`;
    const prev = deduped.get(k);
    if (!prev || (p.bestWinRate || 0) > (prev.bestWinRate || 0)) deduped.set(k, p);
  }

  const patterns = Array.from(deduped.values());
  patterns.sort((a, b) => {
    const scoreA = (a.bestWinRate || 0) * Math.log10(a.sampleSize + 1);
    const scoreB = (b.bestWinRate || 0) * Math.log10(b.sampleSize + 1);
    return scoreB - scoreA;
  });

  return patterns;
}

module.exports = {
  DEFAULT_MIN_SAMPLES,
  mineSessionPrefixPatterns,
  mineSlidingMorningPatterns,
  mineDirOnlyPrefixPatterns,
  mineAllPatterns,
};

/**
 * Manual Console OI tape calculation (separate from OI Flow Tracker).
 *
 * Notebook rule (verified on 14:51–14:55):
 *   Bullish = Σ|CE ΔOI| on Long build + Short cover
 *           − Σ|CE ΔOI| on Writing + Long unwind
 *   Bearish = Σ|PE ΔOI| on Buying + Short cover
 *           − Σ|PE ΔOI| on Writing + Long unwind
 *
 * For 3/5/10/… min bars: walk every 1-minute step inside the bar, then apply
 * the same formula (not one act on the whole bar ΔOI).
 */
const { intervalOiFromRows } = require('./oiFlowIntervalOi');

const SESSION_FROM_MIN = 9 * 60 + 15;

function matchesInterval(minutes, intervalMin) {
  const step = Math.max(1, Number(intervalMin) || 1);
  if (!Number.isFinite(minutes)) return false;
  if (step === 1) return true;
  if (minutes < SESSION_FROM_MIN) return false;
  return (minutes - SESSION_FROM_MIN) % step === 0;
}

function dirArrow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return { arrow: '→', tone: 'flat' };
  if (n > 0) return { arrow: '↑', tone: 'up' };
  return { arrow: '↓', tone: 'down' };
}

function classifyCallAct(priceUp, oiChg) {
  if (!Number.isFinite(oiChg) || oiChg === 0 || priceUp == null) {
    return { label: '—', tone: 'flat' };
  }
  if (priceUp && oiChg > 0) return { label: 'Long build', tone: 'bull' };
  if (!priceUp && oiChg > 0) return { label: 'Writing', tone: 'bear' };
  if (priceUp && oiChg < 0) return { label: 'Short cover', tone: 'bull' };
  return { label: 'Long unwind', tone: 'bear' };
}

function classifyPutAct(priceUp, oiChg) {
  if (!Number.isFinite(oiChg) || oiChg === 0 || priceUp == null) {
    return { label: '—', tone: 'flat' };
  }
  if (priceUp && oiChg > 0) return { label: 'Writing', tone: 'bull' };
  if (!priceUp && oiChg > 0) return { label: 'Buying', tone: 'bear' };
  if (priceUp && oiChg < 0) return { label: 'Long unwind', tone: 'bull' };
  return { label: 'Short cover', tone: 'bear' };
}

function priceUpFromSpots(curr, prev) {
  const spotNow = Number(curr);
  const spotPrev = Number(prev);
  if (!Number.isFinite(spotNow) || !Number.isFinite(spotPrev)) return null;
  if (spotNow > spotPrev) return true;
  if (spotNow < spotPrev) return false;
  return null;
}

function emptyActBuckets() {
  return {
    ceBull: 0,
    ceBear: 0,
    peBull: 0,
    peBear: 0,
    callsAbs: 0,
    putsAbs: 0,
    callsNet: 0,
    putsNet: 0,
    minuteCount: 0,
    /** |ΔOI| per Call act label inside the window */
    ceByAct: {
      'Long build': 0,
      Writing: 0,
      'Short cover': 0,
      'Long unwind': 0,
    },
    /** |ΔOI| per Put act label inside the window */
    peByAct: {
      Buying: 0,
      Writing: 0,
      'Short cover': 0,
      'Long unwind': 0,
    },
  };
}

function dominantAct(byAct, toneOf) {
  let bestLabel = '—';
  let bestMag = 0;
  for (const [label, mag] of Object.entries(byAct || {})) {
    const n = Number(mag) || 0;
    if (n > bestMag) {
      bestMag = n;
      bestLabel = label;
    }
  }
  if (bestMag <= 0 || bestLabel === '—') {
    return { label: '—', tone: 'flat', mag: 0 };
  }
  return { label: bestLabel, tone: toneOf(bestLabel), mag: Math.round(bestMag) };
}

function callActTone(label) {
  if (label === 'Long build' || label === 'Short cover') return 'bull';
  if (label === 'Writing' || label === 'Long unwind') return 'bear';
  return 'flat';
}

function putActTone(label) {
  if (label === 'Writing' || label === 'Long unwind') return 'bull';
  if (label === 'Buying' || label === 'Short cover') return 'bear';
  return 'flat';
}

/** One-word scenario from Call + Put overall acts. */
function combinedOverallAct(callTone, putTone) {
  if (!callTone || !putTone || callTone === 'flat' || putTone === 'flat') {
    return { label: '—', tone: 'flat' };
  }
  if (callTone === putTone) {
    return callTone === 'bull'
      ? { label: 'Bullish', tone: 'bull' }
      : { label: 'Bearish', tone: 'bear' };
  }
  return { label: 'Fight', tone: 'warn' };
}

/**
 * Score one closed 1-minute step (prev → cur) into CE/PE bull/bear abs buckets.
 */
function accumulateMinuteStep(prev, cur, buckets) {
  if (!prev || !cur || cur.fetchOk === false || prev.fetchOk === false) return;
  const interval = intervalOiFromRows(cur, prev);
  const callsChgOi = Number.isFinite(Number(cur.callsChgOi))
    ? Number(cur.callsChgOi)
    : interval.callsChgOi;
  const putsChgOi = Number.isFinite(Number(cur.putsChgOi))
    ? Number(cur.putsChgOi)
    : interval.putsChgOi;
  const priceUp = priceUpFromSpots(cur.spotPrice, prev.spotPrice);
  const callAct = classifyCallAct(priceUp, callsChgOi);
  const putAct = classifyPutAct(priceUp, putsChgOi);

  const absC = Number.isFinite(callsChgOi) ? Math.abs(callsChgOi) : 0;
  const absP = Number.isFinite(putsChgOi) ? Math.abs(putsChgOi) : 0;

  if (callAct.label === 'Long build' || callAct.label === 'Short cover') {
    buckets.ceBull += absC;
  } else if (callAct.label === 'Writing' || callAct.label === 'Long unwind') {
    buckets.ceBear += absC;
  }

  if (putAct.label === 'Writing' || putAct.label === 'Long unwind') {
    buckets.peBull += absP;
  } else if (putAct.label === 'Buying' || putAct.label === 'Short cover') {
    buckets.peBear += absP;
  }

  if (buckets.ceByAct[callAct.label] != null && absC > 0) {
    buckets.ceByAct[callAct.label] += absC;
  }
  if (buckets.peByAct[putAct.label] != null && absP > 0) {
    buckets.peByAct[putAct.label] += absP;
  }

  if (Number.isFinite(callsChgOi)) {
    buckets.callsAbs += absC;
    buckets.callsNet += callsChgOi;
  }
  if (Number.isFinite(putsChgOi)) {
    buckets.putsAbs += absP;
    buckets.putsNet += putsChgOi;
  }
  buckets.minuteCount += 1;

  return {
    callActLabel: callAct.label,
    callActTone: callAct.tone,
    putActLabel: putAct.label,
    putActTone: putAct.tone,
    callsChgOi: Number.isFinite(callsChgOi) ? callsChgOi : null,
    putsChgOi: Number.isFinite(putsChgOi) ? putsChgOi : null,
  };
}

function scoresFromBuckets(buckets) {
  const bullish = Math.round(buckets.ceBull - buckets.ceBear);
  const bearish = Math.round(buckets.peBear - buckets.peBull);
  let bias = 'Neutral';
  let biasTone = 'flat';
  if (bullish > bearish) {
    bias = 'Bullish';
    biasTone = 'bull';
  } else if (bearish > bullish) {
    bias = 'Bearish';
    biasTone = 'bear';
  }
  return { bullish, bearish, bias, biasTone };
}

/**
 * @param {object[]} allRows — raw 1-minute Manual Console docs
 * @param {number} intervalMin
 * @param {{ displayRow?: object|null, inSession?: boolean }} opts
 */
function buildManualConsoleOiBars(allRows, intervalMin, opts = {}) {
  const step = Math.max(1, Number(intervalMin) || 1);
  const source = (Array.isArray(allRows) ? allRows : [])
    .filter((r) => r && r.fetchOk !== false && Number.isFinite(Number(r.minutes)))
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));

  const inSession = Boolean(opts.inSession);
  const displayRow = opts.displayRow || null;
  const byMin = new Map(source.map((r) => [Number(r.minutes), r]));

  const lastSaved = source.length ? source[source.length - 1] : null;
  let lastEntry = !inSession && displayRow ? displayRow : lastSaved || displayRow || null;
  if (lastEntry && !byMin.has(Number(lastEntry.minutes))) {
    byMin.set(Number(lastEntry.minutes), lastEntry);
  }

  const chrono1m = Array.from(byMin.values()).sort(
    (a, b) => Number(a.minutes) - Number(b.minutes),
  );
  const chrono1mByMin = new Map(chrono1m.map((r) => [Number(r.minutes), r]));

  // Interval endpoints (grid) + live last entry
  const endpoints = [];
  for (const row of chrono1m) {
    if (matchesInterval(row.minutes, step)) endpoints.push(row);
  }
  if (
    lastEntry
    && !endpoints.some((r) => Number(r.minutes) === Number(lastEntry.minutes))
  ) {
    endpoints.push({
      ...lastEntry,
      isLastEntry: true,
      afterClose: !inSession,
    });
    endpoints.sort((a, b) => Number(a.minutes) - Number(b.minutes));
  } else if (lastEntry) {
    const hit = endpoints.find((r) => Number(r.minutes) === Number(lastEntry.minutes));
    if (hit) {
      hit.isLastEntry = true;
      hit.afterClose = !inSession;
    }
  }

  const enriched = [];
  for (let idx = 0; idx < endpoints.length; idx += 1) {
    const row = endpoints[idx];
    const endMin = Number(row.minutes);
    const prevBar = idx > 0 ? endpoints[idx - 1] : null;
    const prevEnd = prevBar ? Number(prevBar.minutes) : endMin - step;
    const windowStart = idx === 0 ? Math.max(SESSION_FROM_MIN, endMin - step) : prevEnd;

    // 1-min walk → overall Call/Put act (dominant |ΔOI| inside window) + notebook scores
    const buckets = emptyActBuckets();
    let lastStepActs = null;
    for (let m = windowStart + 1; m <= endMin; m += 1) {
      const cur = chrono1mByMin.get(m);
      const prev = chrono1mByMin.get(m - 1);
      if (!cur || !prev) continue;
      const stepActs = accumulateMinuteStep(prev, cur, buckets);
      if (stepActs) lastStepActs = stepActs;
    }

    const { bullish, bearish, bias, biasTone } = scoresFromBuckets(buckets);
    const overallCall = dominantAct(buckets.ceByAct, callActTone);
    const overallPut = dominantAct(buckets.peByAct, putActTone);
    const scenario = combinedOverallAct(overallCall.tone, overallPut.tone);

    // Same as OI Flow Tracker tape (rows without strikes): interval ΔOI =
    // dayCall/dayPut change between consecutive displayed bar endpoints.
    const prevDayCall = prevBar != null ? Number(prevBar.dayCallChgOi) : NaN;
    const prevDayPut = prevBar != null ? Number(prevBar.dayPutChgOi) : NaN;
    const dayCallChgOi = Number.isFinite(Number(row.dayCallChgOi)) ? Number(row.dayCallChgOi) : null;
    const dayPutChgOi = Number.isFinite(Number(row.dayPutChgOi)) ? Number(row.dayPutChgOi) : null;
    let callsChgOi = null;
    let putsChgOi = null;
    if (prevBar) {
      const overlap = intervalOiFromRows(row, prevBar);
      // Prefer day Δ between endpoints — matches /api/oi-flow/today stripped rows.
      if (Number.isFinite(dayCallChgOi) && Number.isFinite(prevDayCall)) {
        callsChgOi = dayCallChgOi - prevDayCall;
      } else {
        callsChgOi = overlap.callsChgOi;
      }
      if (Number.isFinite(dayPutChgOi) && Number.isFinite(prevDayPut)) {
        putsChgOi = dayPutChgOi - prevDayPut;
      } else {
        putsChgOi = overlap.putsChgOi;
      }
    }
    const chngInDir =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
        ? putsChgOi - callsChgOi
        : null;
    const dir = dirArrow(chngInDir);
    const diffInOi =
      Number.isFinite(dayPutChgOi) && Number.isFinite(dayCallChgOi)
        ? dayPutChgOi - dayCallChgOi
        : Number.isFinite(Number(row.diffInOi))
          ? Number(row.diffInOi)
          : null;

    // Call/Put act for the bar = tracker-style (spot move × interval ΔOI)
    const spotNow = Number(row.spotPrice);
    const spotPrev = prevBar ? Number(prevBar.spotPrice) : NaN;
    const priceUp =
      Number.isFinite(spotNow) && Number.isFinite(spotPrev)
        ? spotNow > spotPrev
          ? true
          : spotNow < spotPrev
            ? false
            : null
        : null;
    const callAct = prevBar
      ? classifyCallAct(priceUp, callsChgOi)
      : { label: '—', tone: 'flat' };
    const putAct = prevBar
      ? classifyPutAct(priceUp, putsChgOi)
      : { label: '—', tone: 'flat' };
    // Overall act prefers combined interval acts (same as tracker Match idea)
    const intervalScenario = combinedOverallAct(callAct.tone, putAct.tone);

    const isLastEntry = Boolean(row.isLastEntry)
      || (inSession && lastSaved && endMin === Number(lastSaved.minutes));
    const offGrid = isLastEntry && !row.afterClose && !matchesInterval(endMin, step);

    const futNow = Number(row.futPrice);
    enriched.push({
      dateKey: row.dateKey,
      minutes: endMin,
      time: row.time,
      srNo: idx + 1,
      spotPrice: Number.isFinite(spotNow) ? spotNow : null,
      futPrice: Number.isFinite(futNow) ? futNow : null,
      windowStartMin: windowStart,
      windowEndMin: endMin,
      minuteCount: buckets.minuteCount,
      /** Tracker-style acts on bar interval ΔOI */
      callActLabel: callAct.label,
      callActTone: callAct.tone,
      putActLabel: putAct.label,
      putActTone: putAct.tone,
      /** Combined Call+Put: Bullish | Bearish | Fight */
      overallAct: intervalScenario.label,
      overallActTone: intervalScenario.tone,
      /** Dominant 1-min acts inside window (kept for reference) */
      overallCallAct: overallCall.label,
      overallCallTone: overallCall.tone,
      overallCallOi: overallCall.mag,
      overallPutAct: overallPut.label,
      overallPutTone: overallPut.tone,
      overallPutOi: overallPut.mag,
      bullish,
      bearish,
      bias,
      biasTone,
      ceBullAbs: Math.round(buckets.ceBull),
      ceBearAbs: Math.round(buckets.ceBear),
      peBullAbs: Math.round(buckets.peBull),
      peBearAbs: Math.round(buckets.peBear),
      dayCallChgOi,
      dayPutChgOi,
      callsChgOi: Number.isFinite(callsChgOi) ? callsChgOi : null,
      putsChgOi: Number.isFinite(putsChgOi) ? putsChgOi : null,
      diffInOi,
      chngInDir,
      dirOfChng: dir.arrow,
      dirTone: dir.tone,
      lastCallActLabel: lastStepActs?.callActLabel || '—',
      lastPutActLabel: lastStepActs?.putActLabel || '—',
      fetchOk: row.fetchOk !== false,
      isLastEntry,
      offGrid: Boolean(offGrid),
      afterClose: Boolean(row.afterClose),
      sessionOpen: !prevBar,
    });
  }

  return enriched.reverse();
}

module.exports = {
  SESSION_FROM_MIN,
  matchesInterval,
  buildManualConsoleOiBars,
  classifyCallAct,
  classifyPutAct,
  scoresFromBuckets,
  accumulateMinuteStep,
};

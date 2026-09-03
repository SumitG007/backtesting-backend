/**
 * OI Flow act labels, Match/Fight, session buildup — shared with OI Wall Reaction.
 */
const { intervalOiFromRows } = require('./oiFlowIntervalOi');

const SESSION_FROM = 9 * 60 + 15;

const BUILDUP_ROWS = [
  { label: 'Long build', ceKey: 'Long build', peKey: 'Buying' },
  { label: 'Writing', ceKey: 'Writing', peKey: 'Writing' },
  { label: 'Long unwind', ceKey: 'Long unwind', peKey: 'Long unwind' },
  { label: 'Short cover', ceKey: 'Short cover', peKey: 'Short cover' },
];

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
  // Standard put OI: long put build = bear, put writing = bull.
  if (priceUp && oiChg > 0) return { label: 'Writing', tone: 'bull' };
  if (!priceUp && oiChg > 0) return { label: 'Buying', tone: 'bear' };
  if (priceUp && oiChg < 0) return { label: 'Long unwind', tone: 'bull' };
  return { label: 'Short cover', tone: 'bear' };
}

function actMatchLabel(callTone, putTone) {
  if (!callTone || !putTone || callTone === 'flat' || putTone === 'flat') {
    return { text: '—', tone: 'flat', isMatch: false, isFight: false };
  }
  if (callTone === putTone) {
    return { text: 'Match', tone: callTone, isMatch: true, isFight: false };
  }
  return { text: 'Fight', tone: 'warn', isMatch: false, isFight: true };
}

function sentimentFromChng(chngInDir) {
  if (!Number.isFinite(chngInDir) || chngInDir === 0) return { label: 'Neutral', tone: 'flat' };
  return chngInDir > 0 ? { label: 'Bull', tone: 'bull' } : { label: 'Bear', tone: 'bear' };
}

function priceUpFromSpots(curr, prev) {
  const spotNow = Number(curr);
  const spotPrev = Number(prev);
  if (!Number.isFinite(spotNow) || !Number.isFinite(spotPrev)) return null;
  if (spotNow > spotPrev) return true;
  if (spotNow < spotPrev) return false;
  return null;
}

function emptyActBucket() {
  return { oi: 0, mins: 0 };
}

function remarkForBuildup(label, ceOi, peOi) {
  const ce = Math.abs(Number(ceOi) || 0);
  const pe = Math.abs(Number(peOi) || 0);
  if (ce === 0 && pe === 0) return { text: '—', tone: 'flat' };
  if (ce === pe) return { text: '—', tone: 'flat' };
  const peMore = pe > ce;
  if (label === 'Long build') return peMore ? { text: 'Bear', tone: 'bear' } : { text: 'Bull', tone: 'bull' };
  if (label === 'Writing') return peMore ? { text: 'Bull', tone: 'bull' } : { text: 'Bear', tone: 'bear' };
  if (label === 'Long unwind') return peMore ? { text: 'Bull', tone: 'bull' } : { text: 'Bear', tone: 'bear' };
  return peMore ? { text: 'Bear', tone: 'bear' } : { text: 'Bull', tone: 'bull' };
}

function computeBuildupOverall(rows, displayRow) {
  const byMin = new Map();
  for (const row of rows || []) {
    if (!row || row.fetchOk === false) continue;
    const m = Number(row.minutes);
    if (!Number.isFinite(m)) continue;
    byMin.set(m, row);
  }
  if (displayRow && displayRow.fetchOk !== false) {
    const m = Number(displayRow.minutes);
    if (Number.isFinite(m)) byMin.set(m, displayRow);
  }
  const ordered = [...byMin.values()].sort((a, b) => Number(a.minutes) - Number(b.minutes));

  const ce = {
    'Long build': emptyActBucket(),
    Writing: emptyActBucket(),
    'Short cover': emptyActBucket(),
    'Long unwind': emptyActBucket(),
  };
  const pe = {
    Buying: emptyActBucket(),
    Writing: emptyActBucket(),
    'Short cover': emptyActBucket(),
    'Long unwind': emptyActBucket(),
  };

  let dominantAct = '—';
  let dominantMag = 0;

  for (let i = 1; i < ordered.length; i += 1) {
    const row = ordered[i];
    const prev = ordered[i - 1];
    if (Number(row.minutes) < SESSION_FROM) continue;
    const interval = intervalOiFromRows(row, prev);
    const callsChgOi = Number.isFinite(Number(row.callsChgOi))
      ? Number(row.callsChgOi)
      : interval.callsChgOi;
    const putsChgOi = Number.isFinite(Number(row.putsChgOi))
      ? Number(row.putsChgOi)
      : interval.putsChgOi;
    const priceUp = priceUpFromSpots(row.spotPrice, prev.spotPrice);
    const callAct = classifyCallAct(priceUp, callsChgOi);
    const putAct = classifyPutAct(priceUp, putsChgOi);
    if (ce[callAct.label] && Number.isFinite(callsChgOi) && callsChgOi !== 0) {
      ce[callAct.label].oi += callsChgOi;
      ce[callAct.label].mins += 1;
    }
    if (pe[putAct.label] && Number.isFinite(putsChgOi) && putsChgOi !== 0) {
      pe[putAct.label].oi += putsChgOi;
      pe[putAct.label].mins += 1;
    }
  }

  const summaryRows = BUILDUP_ROWS.map((def) => {
    const ceOi = ce[def.ceKey]?.oi || 0;
    const peOi = pe[def.peKey]?.oi || 0;
    const mag = Math.abs(ceOi) + Math.abs(peOi);
    if (mag > dominantMag) {
      dominantMag = mag;
      dominantAct = def.label;
    }
    return {
      label: def.label,
      ceOi,
      peOi,
      remark: remarkForBuildup(def.label, ceOi, peOi),
    };
  });

  let bullScore = 0;
  let bearScore = 0;
  for (const r of summaryRows) {
    if (r.remark.tone === 'bull') bullScore += Math.abs(r.ceOi) + Math.abs(r.peOi);
    if (r.remark.tone === 'bear') bearScore += Math.abs(r.ceOi) + Math.abs(r.peOi);
  }
  const overall =
    bullScore === bearScore
      ? { text: 'Neutral', tone: 'flat' }
      : bullScore > bearScore
        ? { text: 'Bull', tone: 'bull' }
        : { text: 'Bear', tone: 'bear' };

  return { overall, dominantAct, rows: summaryRows };
}

function enrichMinuteBars(rows, displayRow) {
  const byMin = new Map();
  for (const row of rows || []) {
    if (!row || row.fetchOk === false) continue;
    const m = Number(row.minutes);
    if (!Number.isFinite(m)) continue;
    byMin.set(m, row);
  }
  if (displayRow && displayRow.fetchOk !== false) {
    const m = Number(displayRow.minutes);
    if (Number.isFinite(m)) byMin.set(m, displayRow);
  }
  const ordered = [...byMin.values()].sort((a, b) => Number(a.minutes) - Number(b.minutes));

  const enriched = [];
  let curBull = 0;
  let curBear = 0;

  for (let i = 1; i < ordered.length; i += 1) {
    const row = ordered[i];
    const prev = ordered[i - 1];
    const interval = intervalOiFromRows(row, prev);
    const callsChgOi = Number.isFinite(Number(row.callsChgOi))
      ? Number(row.callsChgOi)
      : interval.callsChgOi;
    const putsChgOi = Number.isFinite(Number(row.putsChgOi))
      ? Number(row.putsChgOi)
      : interval.putsChgOi;
    const priceUp = priceUpFromSpots(row.spotPrice, prev.spotPrice);
    const spotDelta = Number.isFinite(Number(row.spotPrice)) && Number.isFinite(Number(prev.spotPrice))
      ? Number(row.spotPrice) - Number(prev.spotPrice)
      : null;
    const callAct = classifyCallAct(priceUp, callsChgOi);
    const putAct = classifyPutAct(priceUp, putsChgOi);
    const actMatch = actMatchLabel(callAct.tone, putAct.tone);
    const chngInDir =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi) ? putsChgOi - callsChgOi : null;
    const sentiment = sentimentFromChng(chngInDir);

    if (sentiment.tone === 'bull') {
      curBull += 1;
      curBear = 0;
    } else if (sentiment.tone === 'bear') {
      curBear += 1;
      curBull = 0;
    } else {
      curBull = 0;
      curBear = 0;
    }

    enriched.push({
      minutes: row.minutes,
      time: row.time,
      spotPrice: row.spotPrice,
      spotDelta,
      callAct,
      putAct,
      actMatch,
      sentiment,
      streak: sentiment.tone === 'bull' ? curBull : sentiment.tone === 'bear' ? curBear : 0,
      streakLabel:
        sentiment.tone === 'bull'
          ? `${curBull}B`
          : sentiment.tone === 'bear'
            ? `${curBear}Be`
            : '—',
    });
  }

  return enriched.reverse();
}

module.exports = {
  classifyCallAct,
  classifyPutAct,
  actMatchLabel,
  computeBuildupOverall,
  enrichMinuteBars,
};

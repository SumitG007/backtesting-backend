/**
 * Interval ΔOI on overlapping ATM-window strikes only.
 * Strikes that enter/leave when ATM hops are ignored.
 */

function compactStrikes(snapshotStrikes) {
  if (!Array.isArray(snapshotStrikes)) return [];
  return snapshotStrikes
    .map((r) => {
      const strike = Number(r?.strike);
      if (!Number.isFinite(strike)) return null;
      const callOi = Number(r.callOi);
      const putOi = Number(r.putOi);
      const callChgOi = Number(r.callChgOi);
      const putChgOi = Number(r.putChgOi);
      return {
        strike,
        callOi: Number.isFinite(callOi) ? callOi : null,
        putOi: Number.isFinite(putOi) ? putOi : null,
        callChgOi: Number.isFinite(callChgOi) ? callChgOi : null,
        putChgOi: Number.isFinite(putChgOi) ? putChgOi : null,
      };
    })
    .filter(Boolean);
}

function strikeSideDelta(curr, prev, chgKey, oiKey) {
  const cChg = Number(curr?.[chgKey]);
  const pChg = Number(prev?.[chgKey]);
  if (Number.isFinite(cChg) && Number.isFinite(pChg)) return cChg - pChg;
  const cOi = Number(curr?.[oiKey]);
  const pOi = Number(prev?.[oiKey]);
  if (Number.isFinite(cOi) && Number.isFinite(pOi)) return cOi - pOi;
  return null;
}

function overlapIntervalOi(currStrikes, prevStrikes) {
  if (!Array.isArray(currStrikes) || !Array.isArray(prevStrikes)) return null;
  if (!currStrikes.length || !prevStrikes.length) return null;
  const prevBy = new Map(prevStrikes.map((r) => [Number(r.strike), r]));
  let calls = 0;
  let puts = 0;
  let callHits = 0;
  let putHits = 0;
  for (const curr of currStrikes) {
    const prev = prevBy.get(Number(curr.strike));
    if (!prev) continue;
    const cd = strikeSideDelta(curr, prev, 'callChgOi', 'callOi');
    const pd = strikeSideDelta(curr, prev, 'putChgOi', 'putOi');
    if (Number.isFinite(cd)) {
      calls += cd;
      callHits += 1;
    }
    if (Number.isFinite(pd)) {
      puts += pd;
      putHits += 1;
    }
  }
  if (callHits === 0 && putHits === 0) return null;
  return {
    callsChgOi: callHits ? calls : null,
    putsChgOi: putHits ? puts : null,
  };
}

function intervalOiFromRows(row, prev) {
  const overlap = overlapIntervalOi(row?.strikes, prev?.strikes);
  if (overlap) return overlap;
  if (prev) {
    const dayC = Number(row?.dayCallChgOi);
    const prevC = Number(prev.dayCallChgOi);
    const dayP = Number(row?.dayPutChgOi);
    const prevP = Number(prev.dayPutChgOi);
    return {
      callsChgOi: Number.isFinite(dayC) && Number.isFinite(prevC) ? dayC - prevC : null,
      putsChgOi: Number.isFinite(dayP) && Number.isFinite(prevP) ? dayP - prevP : null,
    };
  }
  return {
    callsChgOi: Number.isFinite(Number(row?.dayCallChgOi)) ? 0 : null,
    putsChgOi: Number.isFinite(Number(row?.dayPutChgOi)) ? 0 : null,
  };
}

module.exports = {
  compactStrikes,
  overlapIntervalOi,
  intervalOiFromRows,
};

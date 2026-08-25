/**
 * Liquidity OI Chase signal — sweep/break + OI Flow fuel (Lead / Streak / ΔPCR).
 */
const { intervalOiFromRows } = require('../utils/oiFlowIntervalOi');

function classifyCallAct(priceUp, oiChg) {
  const oi = Number(oiChg);
  if (!Number.isFinite(oi) || oi === 0 || priceUp == null) return { label: '—', tone: 'flat' };
  if (priceUp && oi > 0) return { label: 'Long build', tone: 'bull' };
  if (!priceUp && oi > 0) return { label: 'Writing', tone: 'bear' };
  if (priceUp && oi < 0) return { label: 'Short cover', tone: 'bull' };
  return { label: 'Long unwind', tone: 'bear' };
}

function classifyPutAct(priceUp, oiChg) {
  const oi = Number(oiChg);
  if (!Number.isFinite(oi) || oi === 0 || priceUp == null) return { label: '—', tone: 'flat' };
  if (!priceUp && oi > 0) return { label: 'Buying', tone: 'bull' };
  if (priceUp && oi > 0) return { label: 'Writing', tone: 'bear' };
  if (!priceUp && oi < 0) return { label: 'Short cover', tone: 'bull' };
  return { label: 'Long unwind', tone: 'bear' };
}

function enrichOiWindow(minuteRows, windowMins = 15) {
  const rows = Array.isArray(minuteRows)
    ? [...minuteRows].filter((r) => r?.fetchOk !== false).sort((a, b) => Number(a.minutes) - Number(b.minutes))
    : [];
  if (!rows.length) {
    return { lead: 'flat', streak: 0, streakSide: null, deltaPcr: null, pcr: null, topAct: null, bars: { bull: 0, bear: 0 } };
  }
  const lastMinutes = Number(rows[rows.length - 1].minutes);
  const cutoff = Number(windowMins) > 0 ? lastMinutes - Number(windowMins) : -Infinity;

  let callAbs = 0;
  let putAbs = 0;
  let bull = 0;
  let bear = 0;
  const sentiments = [];
  const actMag = {
    'Long build': 0,
    Writing: 0,
    'Long unwind': 0,
    'Short cover': 0,
    Buying: 0,
  };

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (Number(row.minutes) < cutoff) continue;
    const prev = i > 0 ? rows[i - 1] : null;
    const interval = intervalOiFromRows(row, prev);
    const callsChgOi = Number.isFinite(Number(row.callsChgOi)) ? Number(row.callsChgOi) : interval.callsChgOi;
    const putsChgOi = Number.isFinite(Number(row.putsChgOi)) ? Number(row.putsChgOi) : interval.putsChgOi;
    if (Number.isFinite(callsChgOi)) callAbs += Math.abs(callsChgOi);
    if (Number.isFinite(putsChgOi)) putAbs += Math.abs(putsChgOi);

    const spotNow = Number(row.spotPrice);
    const spotPrev = prev ? Number(prev.spotPrice) : NaN;
    const priceUp =
      Number.isFinite(spotNow) && Number.isFinite(spotPrev)
        ? spotNow > spotPrev
          ? true
          : spotNow < spotPrev
            ? false
            : null
        : null;
    const callAct = classifyCallAct(priceUp, callsChgOi);
    const putAct = classifyPutAct(priceUp, putsChgOi);
    if (actMag[callAct.label] != null && Number.isFinite(callsChgOi)) actMag[callAct.label] += Math.abs(callsChgOi);
    if (actMag[putAct.label] != null && Number.isFinite(putsChgOi)) actMag[putAct.label] += Math.abs(putsChgOi);

    const chngInDir =
      Number.isFinite(putsChgOi) && Number.isFinite(callsChgOi) ? putsChgOi - callsChgOi : null;
    let sent = 'Neutral';
    if (Number.isFinite(chngInDir) && chngInDir > 0) {
      sent = 'Bull';
      bull += 1;
    } else if (Number.isFinite(chngInDir) && chngInDir < 0) {
      sent = 'Bear';
      bear += 1;
    }
    sentiments.push(sent);
  }

  let lead = 'flat';
  if (putAbs > callAbs * 1.05) lead = 'puts';
  else if (callAbs > putAbs * 1.05) lead = 'calls';

  let streak = 0;
  let streakSide = null;
  for (let i = sentiments.length - 1; i >= 0; i -= 1) {
    const s = sentiments[i];
    if (s !== 'Bull' && s !== 'Bear') break;
    if (!streakSide) streakSide = s;
    if (s !== streakSide) break;
    streak += 1;
  }

  let topAct = null;
  let topMag = 0;
  for (const [k, v] of Object.entries(actMag)) {
    if (v > topMag) {
      topMag = v;
      topAct = k;
    }
  }

  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  const callOi = Number(last?.callOiTotal);
  const putOi = Number(last?.putOiTotal);
  const pcr = callOi > 0 && Number.isFinite(putOi) ? putOi / callOi : null;
  const prevCall = Number(prev?.callOiTotal);
  const prevPut = Number(prev?.putOiTotal);
  const prevPcr = prevCall > 0 && Number.isFinite(prevPut) ? prevPut / prevCall : null;
  const deltaPcr = Number.isFinite(pcr) && Number.isFinite(prevPcr) ? pcr - prevPcr : null;

  return {
    lead,
    streak,
    streakSide,
    deltaPcr,
    pcr,
    topAct: topMag > 0 ? topAct : null,
    bars: { bull, bear },
    callAbs,
    putAbs,
  };
}

/**
 * Gate sweep break with OI fuel.
 * @returns {{ status, buyLive, optionType, ... }}
 */
function buildChaseSignal({ sweep, oiFuel, settings = {} }) {
  const minStreak = Math.max(1, Math.floor(Number(settings.minStreak) || 2));
  const maxDeltaPcrFight = Number(settings.maxDeltaPcrFight) || 0.08;

  if (!sweep || sweep.status === 'WAIT') {
    return {
      status: 'WAIT',
      buyLive: false,
      optionType: null,
      detail: sweep?.detail || 'Waiting for liquidity sweep+break',
      oiFuel,
      sweep,
    };
  }
  if (sweep.status === 'CONFLICT') {
    return {
      status: 'CONFLICT',
      buyLive: false,
      optionType: null,
      detail: sweep.detail,
      oiFuel,
      sweep,
    };
  }

  const side = sweep.side;
  const fuel = oiFuel || {};
  const streakOk = fuel.streak >= minStreak && (
    (side === 'CE' && fuel.streakSide === 'Bull') ||
    (side === 'PE' && fuel.streakSide === 'Bear')
  );
  const leadOk =
    (side === 'CE' && (fuel.lead === 'puts' || fuel.lead === 'flat')) ||
    (side === 'PE' && (fuel.lead === 'calls' || fuel.lead === 'flat'));

  // Soft ΔPCR: CE chase shouldn't see big PCR dump; PE chase shouldn't see big PCR spike
  let pcrOk = true;
  if (Number.isFinite(fuel.deltaPcr)) {
    if (side === 'CE' && fuel.deltaPcr < -maxDeltaPcrFight) pcrOk = false;
    if (side === 'PE' && fuel.deltaPcr > maxDeltaPcrFight) pcrOk = false;
  }

  const topOk =
    !fuel.topAct ||
    (side === 'CE' && ['Writing', 'Long build', 'Buying', 'Short cover'].includes(fuel.topAct)) ||
    (side === 'PE' && ['Writing', 'Buying', 'Long build', 'Short cover'].includes(fuel.topAct));

  if (!streakOk) {
    return {
      status: 'NEAR',
      buyLive: false,
      optionType: side,
      detail: `Sweep ok · need streak ≥${minStreak} ${side === 'CE' ? 'Bull' : 'Bear'} (now ${fuel.streak || 0})`,
      oiFuel: fuel,
      sweep,
    };
  }
  if (!leadOk) {
    return {
      status: 'CAUTION',
      buyLive: false,
      optionType: side,
      detail: `OI lead fights chase (lead=${fuel.lead})`,
      oiFuel: fuel,
      sweep,
    };
  }
  if (!pcrOk) {
    return {
      status: 'CAUTION',
      buyLive: false,
      optionType: side,
      detail: `ΔPCR fights chase (${Number(fuel.deltaPcr).toFixed(3)})`,
      oiFuel: fuel,
      sweep,
    };
  }
  if (!topOk) {
    return {
      status: 'NEAR',
      buyLive: false,
      optionType: side,
      detail: `Top act ${fuel.topAct} weak for ${side}`,
      oiFuel: fuel,
      sweep,
    };
  }

  return {
    status: 'TAKE_ENTRY',
    buyLive: true,
    optionType: side,
    detail: `${sweep.detail} · streak ${fuel.streak}${fuel.streakSide === 'Bull' ? 'B' : 'Be'} · lead ${fuel.lead}`,
    oiFuel: fuel,
    sweep,
    stopSpot: sweep.stopSpot,
    targetSpot: sweep.targetSpot,
  };
}

module.exports = {
  enrichOiWindow,
  buildChaseSignal,
  classifyCallAct,
  classifyPutAct,
};

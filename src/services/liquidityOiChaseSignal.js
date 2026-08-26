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
    return {
      lead: 'flat',
      streak: 0,
      streakSide: null,
      deltaPcr: null,
      pcr: null,
      topAct: null,
      bars: { bull: 0, bear: 0 },
      rowCount: 0,
    };
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
    rowCount: rows.length,
  };
}

function buildChaseChecks({
  sweep,
  oiFuel,
  settings = {},
  swingsReady,
  barCount,
  needBars,
  streakOk,
  leadOk,
  pcrOk,
  topOk,
  inWindow = true,
}) {
  const minStreak = Math.max(1, Math.floor(Number(settings.minStreak) || 2));
  const fuel = oiFuel || {};
  const side = sweep?.side || null;
  const sweepStatus = String(sweep?.status || 'WAIT').toUpperCase();
  const sweepOk = sweepStatus === 'SWEEP_BREAK';
  const sweepNear = sweepStatus === 'NEAR' || sweepStatus === 'WATCHING';

  return [
    {
      id: 'win',
      name: 'Trade window',
      short: 'Win',
      ok: Boolean(inWindow),
      value: inWindow ? 'open' : 'shut',
      need: `${settings.tradeFromTime || '09:30'}–${settings.tradeToTime || '14:00'}`,
      note: inWindow ? 'Inside window' : 'Outside trade window',
    },
    {
      id: 'swings',
      name: '5m swings',
      short: 'Swg',
      ok: Boolean(swingsReady),
      value: `${barCount || 0}/${needBars || '?'}`,
      need: `${needBars || '—'} bars`,
      note: swingsReady
        ? `${sweep?.highCount ?? '—'}H / ${sweep?.lowCount ?? '—'}L pools`
        : `Need ${needBars || '—'} confirmed 5m bars`,
    },
    {
      id: 'sweep',
      name: 'Sweep+break',
      short: 'Swp',
      ok: sweepOk,
      value: sweepOk ? (side || 'yes') : sweepNear ? sweepStatus : '—',
      need: 'Wick + close through pool',
      note: sweep?.detail || 'Waiting for liquidity sweep+break',
    },
    {
      id: 'streak',
      name: 'OI streak',
      short: 'Str',
      ok: Boolean(streakOk),
      value: fuel.streak
        ? `${fuel.streak}${fuel.streakSide === 'Bull' ? 'B' : fuel.streakSide === 'Bear' ? 'Be' : ''}`
        : '0',
      need: `≥${minStreak} ${side === 'PE' ? 'Bear' : side === 'CE' ? 'Bull' : 'aligned'}`,
      note: streakOk
        ? `Streak aligned for ${side}`
        : `Need streak ≥${minStreak} ${side === 'PE' ? 'Bear' : 'Bull'}`,
    },
    {
      id: 'lead',
      name: 'OI lead',
      short: 'Lead',
      ok: Boolean(leadOk),
      value: fuel.lead || '—',
      need: side === 'CE' ? 'puts/flat' : side === 'PE' ? 'calls/flat' : 'aligned',
      note: leadOk ? `Lead ok (${fuel.lead})` : `Lead fights chase (${fuel.lead || '—'})`,
    },
    {
      id: 'pcr',
      name: 'ΔPCR soft',
      short: 'ΔPCR',
      ok: Boolean(pcrOk),
      value: Number.isFinite(Number(fuel.deltaPcr))
        ? `${Number(fuel.deltaPcr) > 0 ? '+' : ''}${Number(fuel.deltaPcr).toFixed(3)}`
        : '—',
      need: `fight ≤ ${Number(settings.maxDeltaPcrFight) || 0.08}`,
      note: pcrOk ? 'ΔPCR not fighting' : 'ΔPCR fights chase',
    },
    {
      id: 'act',
      name: 'Top act',
      short: 'Act',
      ok: Boolean(topOk),
      value: fuel.topAct || '—',
      need: 'Not fighting side',
      note: topOk ? (fuel.topAct ? `Top ${fuel.topAct}` : 'No top act') : `Top act ${fuel.topAct} weak`,
    },
  ];
}

/**
 * Gate sweep break with OI fuel.
 * Daily profile: streak ≥1 required; lead/topAct optional (settings.requireLead / requireTopAct).
 * @returns {{ status, buyLive, optionType, checks, ... }}
 */
function buildChaseSignal({ sweep, oiFuel, settings = {}, inWindow = true }) {
  const minStreak = Math.max(1, Math.floor(Number(settings.minStreak) || 1));
  const maxDeltaPcrFight = Number(settings.maxDeltaPcrFight) || 0.15;
  const requireLead = settings.requireLead === true;
  const requireTopAct = settings.requireTopAct === true;
  const fuel = oiFuel || {};
  const barCount = Number(sweep?.barCount) || 0;
  const needBars = Number(sweep?.needBars) || 0;
  const swingsReady = Boolean(sweep?.swingsReady);

  const baseMeta = {
    oiFuel: fuel,
    sweep,
    checks: null,
    at: new Date().toISOString(),
  };

  const attach = (payload, gate = {}) => {
    const checks = buildChaseChecks({
      sweep,
      oiFuel: fuel,
      settings,
      swingsReady,
      barCount,
      needBars,
      inWindow,
      streakOk: gate.streakOk,
      leadOk: gate.leadOk,
      pcrOk: gate.pcrOk,
      topOk: gate.topOk,
    });
    return { ...baseMeta, ...payload, checks };
  };

  if (!sweep || sweep.status === 'WAIT') {
    const streakReady = fuel.streak >= minStreak;
    return attach({
      status: 'WAIT',
      buyLive: false,
      optionType: null,
      detail: sweep?.detail || 'Waiting for liquidity sweep+break',
      headline: swingsReady ? 'No sweep yet' : 'Building swings',
    }, {
      streakOk: streakReady,
      leadOk: true,
      pcrOk: true,
      topOk: true,
    });
  }

  if (sweep.status === 'CONFLICT') {
    return attach({
      status: 'CONFLICT',
      buyLive: false,
      optionType: null,
      detail: sweep.detail,
      headline: 'Both sides swept',
    }, { streakOk: false, leadOk: true, pcrOk: true, topOk: true });
  }

  const evalFuel = (side) => {
    const streakAligned = Boolean(side) && fuel.streak >= minStreak && (
      (side === 'CE' && fuel.streakSide === 'Bull') ||
      (side === 'PE' && fuel.streakSide === 'Bear')
    );
    const leadAligned =
      !side ||
      (side === 'CE' && (fuel.lead === 'puts' || fuel.lead === 'flat')) ||
      (side === 'PE' && (fuel.lead === 'calls' || fuel.lead === 'flat'));
    let pcrOk = true;
    if (side && Number.isFinite(fuel.deltaPcr)) {
      if (side === 'CE' && fuel.deltaPcr < -maxDeltaPcrFight) pcrOk = false;
      if (side === 'PE' && fuel.deltaPcr > maxDeltaPcrFight) pcrOk = false;
    }
    const topAligned =
      !fuel.topAct || !side ||
      (side === 'CE' && ['Writing', 'Long build', 'Buying', 'Short cover'].includes(fuel.topAct)) ||
      (side === 'PE' && ['Writing', 'Buying', 'Long build', 'Short cover'].includes(fuel.topAct));
    return {
      streakOk: streakAligned,
      leadOk: requireLead ? leadAligned : true,
      leadAligned,
      pcrOk,
      topOk: requireTopAct ? topAligned : true,
      topAligned,
    };
  };

  if (sweep.status === 'WATCHING' || sweep.status === 'NEAR') {
    const side = sweep.side || null;
    const gate = evalFuel(side);
    return attach({
      status: sweep.status,
      buyLive: false,
      optionType: side,
      detail: sweep.detail,
      headline: sweep.status === 'NEAR' ? `Near ${side} break` : `Watch ${side || 'pool'}`,
      stopSpot: null,
      targetSpot: null,
    }, {
      streakOk: gate.streakOk,
      leadOk: gate.leadAligned,
      pcrOk: gate.pcrOk,
      topOk: gate.topAligned,
    });
  }

  const side = sweep.side;
  const gate = evalFuel(side);

  if (!gate.streakOk) {
    return attach({
      status: 'NEAR',
      buyLive: false,
      optionType: side,
      detail: `Sweep ok · need streak ≥${minStreak} ${side === 'CE' ? 'Bull' : 'Bear'} (now ${fuel.streak || 0})`,
      headline: `Prepare ${side} · need streak`,
      stopSpot: sweep.stopSpot,
      targetSpot: sweep.targetSpot,
    }, {
      streakOk: false,
      leadOk: gate.leadAligned,
      pcrOk: gate.pcrOk,
      topOk: gate.topAligned,
    });
  }
  if (requireLead && !gate.leadAligned) {
    return attach({
      status: 'CAUTION',
      buyLive: false,
      optionType: side,
      detail: `OI lead fights chase (lead=${fuel.lead})`,
      headline: `Lead fights ${side}`,
      stopSpot: sweep.stopSpot,
      targetSpot: sweep.targetSpot,
    }, {
      streakOk: true,
      leadOk: false,
      pcrOk: gate.pcrOk,
      topOk: gate.topAligned,
    });
  }
  if (!gate.pcrOk) {
    return attach({
      status: 'CAUTION',
      buyLive: false,
      optionType: side,
      detail: `ΔPCR fights chase (${Number(fuel.deltaPcr).toFixed(3)})`,
      headline: `ΔPCR fights ${side}`,
      stopSpot: sweep.stopSpot,
      targetSpot: sweep.targetSpot,
    }, {
      streakOk: true,
      leadOk: gate.leadAligned,
      pcrOk: false,
      topOk: gate.topAligned,
    });
  }
  if (requireTopAct && !gate.topAligned) {
    return attach({
      status: 'NEAR',
      buyLive: false,
      optionType: side,
      detail: `Top act ${fuel.topAct} weak for ${side}`,
      headline: `Weak act for ${side}`,
      stopSpot: sweep.stopSpot,
      targetSpot: sweep.targetSpot,
    }, {
      streakOk: true,
      leadOk: gate.leadAligned,
      pcrOk: true,
      topOk: false,
    });
  }

  const softNote = !gate.leadAligned
    ? ` · lead soft (${fuel.lead})`
    : '';
  return attach({
    status: 'TAKE_ENTRY',
    buyLive: true,
    optionType: side,
    detail: `${sweep.detail} · streak ${fuel.streak}${fuel.streakSide === 'Bull' ? 'B' : 'Be'} · lead ${fuel.lead}${softNote}`,
    headline: side === 'CE' ? 'Buy CE · chase' : 'Buy PE · chase',
    stopSpot: sweep.stopSpot,
    targetSpot: sweep.targetSpot,
  }, {
    streakOk: true,
    leadOk: gate.leadAligned,
    pcrOk: true,
    topOk: gate.topAligned,
  });
}

module.exports = {
  enrichOiWindow,
  buildChaseSignal,
  buildChaseChecks,
  classifyCallAct,
  classifyPutAct,
};

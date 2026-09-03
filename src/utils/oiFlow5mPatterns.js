/**
 * Closed 5m OI Flow bars → CALL BUY / PUT BUY pattern tests.
 * Live rules (from today research): CALL = E, PUT = B.
 */
const { intervalOiFromRows } = require('./oiFlowIntervalOi');

const SESSION_FROM = 9 * 60 + 15;
const STEP_5M = 5;

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

function actMatch(callTone, putTone) {
  if (!callTone || !putTone || callTone === 'flat' || putTone === 'flat') {
    return { text: '—', tone: 'flat' };
  }
  if (callTone === putTone) return { text: 'Match', tone: callTone };
  return { text: 'Fight', tone: 'warn' };
}

function flowStrength({
  flowBias,
  spotDelta,
  chngInDir,
  oiVelocity,
  streak,
  deltaPcr,
  act,
  oiMigration,
  intervalMin,
}) {
  if (flowBias !== 'Bull' && flowBias !== 'Bear') {
    return { label: 'Neutral', tone: 'flat', score: 0 };
  }
  const bull = flowBias === 'Bull';
  const step = Math.max(1, Number(intervalMin) || 1);
  const magFloor = 5000 * step;
  const velFloor = 4000;
  let pts = 1;
  let max = 1;
  max += 1;
  const spot = Number(spotDelta);
  if (Number.isFinite(spot) && ((bull && spot > 0) || (!bull && spot < 0))) pts += 1;
  max += 1;
  if (Number.isFinite(Math.abs(Number(chngInDir))) && Math.abs(Number(chngInDir)) >= magFloor) {
    pts += 1;
  }
  max += 1;
  if (Number.isFinite(Number(oiVelocity)) && Number(oiVelocity) >= velFloor) pts += 1;
  max += 1;
  const st = Number(streak) || 0;
  if (st >= 3) pts += 1;
  else if (st >= 2) pts += 0.5;
  max += 1;
  const dPcr = Number(deltaPcr);
  if (Number.isFinite(dPcr) && ((bull && dPcr >= 0.01) || (!bull && dPcr <= -0.01))) pts += 1;
  max += 1;
  if (act === 'Match') pts += 1;
  else if (act === 'Fight') pts -= 0.5;
  max += 1;
  if ((bull && oiMigration === 'up') || (!bull && oiMigration === 'down')) pts += 1;
  const ratio = max > 0 ? pts / max : 0;
  return {
    label: ratio >= 0.65 ? (bull ? 'Strong Bull' : 'Strong Bear') : bull ? 'Bull' : 'Bear',
    tone: bull ? 'bull' : 'bear',
    score: Math.round(ratio * 100),
  };
}

function matchesInterval(minutes, step) {
  if (step === 1) return true;
  if (!Number.isFinite(minutes) || minutes < SESSION_FROM) return false;
  return (minutes - SESSION_FROM) % step === 0;
}

/** Live entry patterns used on the tracker Signal column + Mongo persistence. */
const LIVE_PATTERNS = [
  {
    id: 'E',
    side: 'CALL',
    decision: 'CALL BUY',
    name: 'Strong Bull + Spot↑≥5 + Match',
    shortName: 'SB↑≥5 Match',
    test: (b) =>
      b.strength?.label === 'Strong Bull'
      && Number(b.spotDelta) >= 5
      && b.act === 'Match',
  },
  {
    id: 'B',
    side: 'PUT',
    decision: 'PUT BUY',
    name: 'Strong Bear + Spot↓ + Match',
    shortName: 'SBe↓ Match',
    test: (b) =>
      b.strength?.label === 'Strong Bear'
      && Number(b.spotDelta) < 0
      && b.act === 'Match',
  },
];

/**
 * Build closed 5m bars from 1m OiFlowMinuteRow docs (skips session-open).
 */
function build5mBars(rows, step = STEP_5M) {
  const byMin = new Map();
  for (const row of rows || []) {
    if (!row || row.fetchOk === false) continue;
    if (!matchesInterval(row.minutes, step)) continue;
    byMin.set(row.minutes, row);
  }
  const chrono = [...byMin.values()].sort((a, b) => a.minutes - b.minutes);
  const enriched = [];
  for (let i = 0; i < chrono.length; i += 1) {
    const row = chrono[i];
    const prev = i > 0 ? chrono[i - 1] : null;
    if (!prev) continue;
    const interval = intervalOiFromRows(row, prev);
    const callsChgOi = interval.callsChgOi;
    const putsChgOi = interval.putsChgOi;
    const chngInDir =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi) ? putsChgOi - callsChgOi : null;
    const spotNow = Number(row.spotPrice);
    const spotPrev = Number(prev.spotPrice);
    const spotDelta =
      Number.isFinite(spotNow) && Number.isFinite(spotPrev) ? spotNow - spotPrev : null;
    const priceUp = Number.isFinite(spotDelta)
      ? spotDelta > 0
        ? true
        : spotDelta < 0
          ? false
          : null
      : null;
    const callAct = classifyCallAct(priceUp, callsChgOi);
    const putAct = classifyPutAct(priceUp, putsChgOi);
    const am = actMatch(callAct.tone, putAct.tone);
    const callOiTot = Number(row.callOiTotal);
    const putOiTot = Number(row.putOiTotal);
    const pcr =
      Number.isFinite(callOiTot) && callOiTot > 0 && Number.isFinite(putOiTot)
        ? putOiTot / callOiTot
        : null;
    const prevCall = Number(prev.callOiTotal);
    const prevPut = Number(prev.putOiTotal);
    const prevPcr =
      Number.isFinite(prevCall) && prevCall > 0 && Number.isFinite(prevPut)
        ? prevPut / prevCall
        : null;
    const deltaPcr =
      Number.isFinite(pcr) && Number.isFinite(prevPcr) ? pcr - prevPcr : null;
    const flowBias =
      !Number.isFinite(chngInDir) || chngInDir === 0
        ? 'Neutral'
        : chngInDir > 0
          ? 'Bull'
          : 'Bear';
    const oiVelocity =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
        ? (Math.abs(callsChgOi) + Math.abs(putsChgOi)) / step
        : null;
    enriched.push({
      time: row.time,
      minutes: row.minutes,
      dateKey: row.dateKey,
      symbol: row.symbol || 'NIFTY',
      spot: spotNow,
      atm: row.atm,
      spotDelta,
      chngInDir,
      flowBias,
      callAct: callAct.label,
      putAct: putAct.label,
      act: am.text,
      pcr,
      deltaPcr,
      oiVelocity,
      oiMigration: row.oiMigration || null,
      streak: 0,
      strength: null,
    });
  }
  for (let i = 0; i < enriched.length; i += 1) {
    const cur = enriched[i];
    const prev = i > 0 ? enriched[i - 1] : null;
    if (cur.flowBias !== 'Bull' && cur.flowBias !== 'Bear') cur.streak = 0;
    else if (prev && prev.flowBias === cur.flowBias) cur.streak = (prev.streak || 1) + 1;
    else cur.streak = 1;
    cur.strength = flowStrength({
      flowBias: cur.flowBias,
      spotDelta: cur.spotDelta,
      chngInDir: cur.chngInDir,
      oiVelocity: cur.oiVelocity,
      streak: cur.streak,
      deltaPcr: cur.deltaPcr,
      act: cur.act,
      oiMigration: cur.oiMigration,
      intervalMin: step,
    });
  }
  return enriched;
}

/** First matching LIVE pattern on a closed 5m bar, or null. */
function matchLivePattern(bar) {
  if (!bar) return null;
  for (const pattern of LIVE_PATTERNS) {
    if (pattern.test(bar)) {
      return {
        patternId: pattern.id,
        patternName: pattern.name,
        shortName: pattern.shortName,
        side: pattern.side,
        decision: pattern.decision,
        tone: pattern.side === 'CALL' ? 'call' : 'put',
      };
    }
  }
  return null;
}

function isClosed5mMinutes(minutes) {
  return matchesInterval(Number(minutes), STEP_5M);
}

module.exports = {
  SESSION_FROM,
  STEP_5M,
  LIVE_PATTERNS,
  build5mBars,
  matchLivePattern,
  isClosed5mMinutes,
  matchesInterval,
};

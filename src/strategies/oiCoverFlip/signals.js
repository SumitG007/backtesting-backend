/**
 * OI Cover Flip (OCF) — peanut harvest.
 * Signal: prev Long build|Writing → Call Short cover + Match + SpotΔ≥min
 * Risk: +targetPts / −stopPts · harvest until SL after target · 1 recovery after first SL
 */
const { build5mBars } = require('../../utils/oiFlow5mPatterns');
const { round } = require('../../utils/oiFlowPlaybook');

const STEP_DEFAULT = 5;
const TARGET_PTS = 6;
const STOP_PTS = 4;
const MIN_SPOT_DELTA = 3;

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  const step = niftyStep();
  return Math.round(s / step) * step;
}

function scoreCoverUp(prev, cur, minSpotDelta) {
  if (cur.callAct !== 'Short cover') return null;
  if (!(prev.callAct === 'Writing' || prev.callAct === 'Long build')) return null;
  if (cur.act !== 'Match') return null;
  if (!(Number(cur.spotDelta) >= minSpotDelta)) return null;
  let s = 40;
  if (prev.callAct === 'Long build') s += 15;
  if (prev.callAct === 'Writing') s += 10;
  if (cur.putAct === 'Writing') s += 15;
  if (cur.strength?.label === 'Strong Bull') s += 20;
  else if (cur.strength?.label === 'Bull') s += 5;
  if (Number(cur.spotDelta) >= 5) s += 10;
  if (Number(cur.spotDelta) >= 10) s += 10;
  if (Number.isFinite(Number(cur.deltaPcr)) && Number(cur.deltaPcr) >= 0) s += 5;
  return s;
}

function levelsFromEntry(entrySpot, targetPts, stopPts) {
  const entry = Number(entrySpot);
  const tp = Math.max(0.5, Number(targetPts) || TARGET_PTS);
  const sl = Math.max(0.5, Number(stopPts) || STOP_PTS);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return {
    entrySpot: round(entry, 1),
    stopSpot: round(entry - sl, 1),
    targetSpot: round(entry + tp, 1),
    riskPts: round(sl, 1),
    rewardPts: round(tp, 1),
  };
}

function parseHhmm(raw, fallbackMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return fallbackMin;
  return Number(m[1]) * 60 + Number(m[2]);
}

function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const displayRow = tape?.displayRow || null;
  const step = Math.max(5, Math.floor(Number(settings.stepMin) || STEP_DEFAULT));
  const targetPts = Math.max(0.5, Number(settings.targetPts) || TARGET_PTS);
  const stopPts = Math.max(0.5, Number(settings.stopPts) || STOP_PTS);
  const minSpotDelta = Math.max(1, Number(settings.minSpotDelta) || MIN_SPOT_DELTA);
  const fromMin = parseHhmm(settings.tradeFromTime, 9 * 60 + 45);
  const toMin = parseHhmm(settings.tradeToTime, 13 * 60 + 30);

  const spotNow = Number(displayRow?.spotPrice ?? displayRow?.spot);
  const atm = Number(displayRow?.atm) || atmStrike(spotNow);

  const base = {
    status: 'WATCHING',
    buyLive: false,
    optionType: null,
    entryStrike: atm,
    levelStrike: atm,
    spot: Number.isFinite(spotNow) ? round(spotNow, 1) : null,
    atm: Number.isFinite(atm) ? atm : null,
    strength: null,
    spotDelta: null,
    act: null,
    callAct: null,
    putAct: null,
    flowBias: null,
    streak: null,
    deltaPcr: null,
    patternId: null,
    patternName: null,
    barTime: null,
    barMinutes: null,
    riskPts: null,
    rewardPts: null,
    stopSpot: null,
    targetSpot: null,
    score: null,
    dayDone: Boolean(opts.dayDone),
    checks: [],
    detail: 'Waiting for Cover Flip UP',
    why: 'Long build|Writing → Short cover + Match + Spot↑',
    headline: null,
    rules: {
      stepMin: step,
      targetPts,
      stopPts,
      minSpotDelta,
      tradeFrom: settings.tradeFromTime || '09:45',
      tradeTo: settings.tradeToTime || '13:30',
    },
  };

  if (opts.dayDone) {
    return {
      ...base,
      status: 'DONE',
      detail: 'Day book locked',
      why: opts.dayLockReason || 'Harvest SL or 2nd SL · day done',
    };
  }

  const raw = rows
    .filter((r) => r && r.fetchOk !== false)
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));
  if (!raw.length) {
    return { ...base, detail: 'No OI Flow tape yet', why: 'Waiting for minute captures' };
  }

  const bars = build5mBars(raw, step);
  if (bars.length < 2) {
    return { ...base, detail: 'Need 2+ closed 5m bars', why: 'Cover Flip needs prev→cur' };
  }

  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const sc = scoreCoverUp(prev, cur, minSpotDelta);
  const inSession = Number(cur.minutes) >= fromMin && Number(cur.minutes) <= toMin;

  const checks = [
    {
      id: 'prev',
      name: 'Prev Call act',
      short: 'Prev',
      ok: prev.callAct === 'Writing' || prev.callAct === 'Long build',
      value: prev.callAct || '—',
      need: 'Long build | Writing',
      note: 'Setup bar',
    },
    {
      id: 'cover',
      name: 'Call Short cover',
      short: 'Cover',
      ok: cur.callAct === 'Short cover',
      value: cur.callAct || '—',
      need: 'Short cover',
      note: 'MM cover flip',
    },
    {
      id: 'match',
      name: 'Act Match',
      short: 'Match',
      ok: cur.act === 'Match',
      value: cur.act || '—',
      need: 'Match',
      note: 'Call+Put agree',
    },
    {
      id: 'spot',
      name: 'Spot Δ',
      short: 'Spot',
      ok: Number(cur.spotDelta) >= minSpotDelta,
      value: Number.isFinite(Number(cur.spotDelta)) ? String(round(cur.spotDelta, 1)) : '—',
      need: `≥ ${minSpotDelta}`,
      note: 'Price confirms cover',
    },
  ];

  const sharedMeta = {
    strength: cur.strength?.label,
    flowBias: cur.flowBias,
    streak: cur.streak,
    deltaPcr: round(cur.deltaPcr, 4),
    spotDelta: round(cur.spotDelta),
    act: cur.act,
    callAct: cur.callAct,
    putAct: cur.putAct,
    prevCallAct: prev.callAct,
    prevPutAct: prev.putAct,
    score: sc,
    barTime: cur.time,
    barMinutes: cur.minutes,
    checks,
  };

  if (!inSession) {
    return {
      ...base,
      ...sharedMeta,
      detail: `Outside entry window · last 5m ${cur.time}`,
      why: `Entries ${base.rules.tradeFrom}–${base.rules.tradeTo} IST`,
    };
  }

  if (
    sc != null
    && Number.isFinite(Number(opts.lastEntryBarMinutes))
    && Number(opts.lastEntryBarMinutes) === Number(cur.minutes)
  ) {
    return {
      ...base,
      ...sharedMeta,
      detail: `Already entered on ${cur.time}`,
      why: 'One entry per signal bar',
    };
  }

  if (sc != null) {
    const lv = levelsFromEntry(cur.spot, targetPts, stopPts);
    if (!lv) {
      return { ...base, ...sharedMeta, detail: 'Invalid entry spot', why: 'Need bar close spot' };
    }
    const entryAtm = atmStrike(lv.entrySpot) || atm;
    return {
      ...base,
      ...sharedMeta,
      status: 'TAKE_ENTRY',
      buyLive: true,
      optionType: 'CE',
      entryStrike: entryAtm,
      levelStrike: entryAtm,
      patternId: 'OCF_UP',
      patternName: `Cover Flip UP · ${prev.callAct}→${cur.callAct}`,
      stopSpot: lv.stopSpot,
      targetSpot: lv.targetSpot,
      riskPts: lv.riskPts,
      rewardPts: lv.rewardPts,
      entrySpotPlan: lv.entrySpot,
      checks: checks.map((c) => ({ ...c, ok: true })),
      detail: `CE ${entryAtm} @ ${cur.time} · +${targetPts}/−${stopPts} · score ${sc}`,
      why: 'Peanut harvest · ATM CE at bar close',
      headline: 'COVER FLIP UP',
    };
  }

  return {
    ...base,
    ...sharedMeta,
    detail: `Last 5m ${cur.time} · no Cover Flip`,
    why: 'Need prev Long build|Writing → Short cover + Match + Spot↑',
  };
}

module.exports = {
  buildSignalFromOiFlow,
  scoreCoverUp,
  levelsFromEntry,
  STEP_DEFAULT,
  TARGET_PTS,
  STOP_PTS,
  MIN_SPOT_DELTA,
};

/**
 * Cover Scalp (OCC) — option +5/−5 · no flip.
 * UP: Long build|Writing → Call SC + Match + SpotΔ≥min
 * DN: Put SC + Match + SpotΔ≤−min
 * Day: lock +5 / −10 option pts · 15m pause after SL (engine)
 */
const { build5mBars } = require('../../utils/oiFlow5mPatterns');
const { round } = require('../../utils/oiFlowPlaybook');

const STEP_DEFAULT = 5;
const OPTION_TP_PTS = 5;
const OPTION_SL_PTS = 5;
const STOP_PTS = OPTION_SL_PTS;
const MIN_SPOT_DELTA = 3;

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.round(s / niftyStep()) * niftyStep();
}

function scoreUp(prev, cur, minSpotDelta) {
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
  return s;
}

function scoreDn(prev, cur, minSpotDelta) {
  if (cur.putAct !== 'Short cover') return null;
  if (cur.act !== 'Match') return null;
  if (!(Number(cur.spotDelta) <= -minSpotDelta)) return null;
  let s = 40;
  if (prev.putAct === 'Long build' || prev.putAct === 'Writing') s += 20;
  else if (prev.putAct === 'Buying') s += 5;
  if (cur.callAct === 'Writing') s += 15;
  if (cur.strength?.label === 'Strong Bear') s += 20;
  else if (cur.strength?.label === 'Bear') s += 5;
  if (Number(cur.spotDelta) <= -5) s += 10;
  if (Number(cur.spotDelta) <= -10) s += 10;
  return s;
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
  const optionTpPts = Math.max(1, Number(settings.optionTpPts) || OPTION_TP_PTS);
  const optionSlPts = Math.max(1, Number(settings.optionSlPts) || OPTION_SL_PTS);
  const minSpotDelta = Math.max(1, Number(settings.minSpotDelta) || MIN_SPOT_DELTA);
  const minFlipScore = Math.max(0, Number(settings.minFlipScore) || 90);
  const minAbsDeltaFlip = Math.max(0, Number(settings.minAbsDeltaFlip) || 10);
  const fromMin = parseHhmm(settings.tradeFromTime, 9 * 60 + 45);
  const toMin = parseHhmm(settings.tradeToTime, 14 * 60 + 30);

  const spotNow = Number(displayRow?.spotPrice ?? displayRow?.spot);
  const atm = Number(displayRow?.atm) || atmStrike(spotNow);
  const openSide = opts.openOptionType === 'PE' ? 'SHORT' : opts.openOptionType === 'CE' ? 'LONG' : null;

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
    riskPts: optionSlPts,
    rewardPts: optionTpPts,
    stopSpot: null,
    targetSpot: null,
    noTarget: false,
    score: null,
    coverSide: null,
    flipOpposite: false,
    dayDone: Boolean(opts.dayDone),
    checks: [],
    detail: 'Waiting for Cover signal',
    why: `UP/DN Cover · option +${optionTpPts}/−${optionSlPts} · no flip · day +${Number(settings.dailyTarget) || 5}/−${Number(settings.dailyLoss) || 10}`,
    headline: null,
    rules: {
      stepMin: step,
      optionTpPts,
      optionSlPts,
      minSpotDelta,
      dailyTarget: Number(settings.dailyTarget) || 5,
      dailyLoss: Number(settings.dailyLoss) || 10,
      tradeFrom: settings.tradeFromTime || '09:45',
      tradeTo: settings.tradeToTime || '14:30',
    },
  };

  if (opts.dayDone) {
    return {
      ...base,
      status: 'DONE',
      detail: 'Day book locked',
      why: opts.dayLockReason || 'Day target / loss hit',
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
    return { ...base, detail: 'Need 2+ closed 5m bars', why: 'Cover needs prev→cur' };
  }

  const cur = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const up = scoreUp(prev, cur, minSpotDelta);
  const dn = scoreDn(prev, cur, minSpotDelta);
  let side = null;
  let sc = null;
  if (up != null && dn != null) {
    if (up >= dn) {
      side = 'LONG';
      sc = up;
    } else {
      side = 'SHORT';
      sc = dn;
    }
  } else if (up != null) {
    side = 'LONG';
    sc = up;
  } else if (dn != null) {
    side = 'SHORT';
    sc = dn;
  }

  const inSession = Number(cur.minutes) >= fromMin && Number(cur.minutes) <= toMin;
  const sharedMeta = {
    strength: cur.strength?.label,
    flowBias: cur.flowBias,
    streak: cur.streak,
    deltaPcr: round(cur.deltaPcr, 4),
    spotDelta: round(cur.spotDelta),
    act: cur.act,
    callAct: cur.callAct,
    putAct: cur.putAct,
    score: sc,
    coverSide: side,
    barTime: cur.time,
    barMinutes: cur.minutes,
  };

  const checks = [
    {
      id: 'cover',
      name: 'Cover flip',
      short: 'Cover',
      ok: side != null,
      value: side === 'LONG' ? `UP ${cur.callAct}` : side === 'SHORT' ? `DN ${cur.putAct}` : '—',
      need: 'UP Call SC or DN Put SC',
      note: 'Both sides',
    },
    {
      id: 'match',
      name: 'Match',
      short: 'Match',
      ok: cur.act === 'Match',
      value: cur.act || '—',
      need: 'Match',
      note: 'Agreeing acts',
    },
    {
      id: 'spot',
      name: 'Spot Δ',
      short: 'Spot',
      ok: side != null,
      value: Number.isFinite(Number(cur.spotDelta)) ? String(round(cur.spotDelta, 1)) : '—',
      need: `≥+${minSpotDelta} / ≤−${minSpotDelta}`,
      note: 'Direction confirm',
    },
  ];

  // Flip disabled — hold open trade until option TP/SL or EOD
  const allowFlip = Boolean(settings.allowFlip);
  if (allowFlip && openSide && side && side !== openSide) {
    const strongEnough =
      sc >= minFlipScore && Math.abs(Number(cur.spotDelta)) >= minAbsDeltaFlip;
    if (strongEnough) {
      const entry = Number(cur.spot);
      const optionType = side === 'LONG' ? 'CE' : 'PE';
      const entryAtm = atmStrike(entry) || atm;
      return {
        ...base,
        ...sharedMeta,
        checks,
        status: 'TAKE_ENTRY',
        buyLive: true,
        flipOpposite: true,
        optionType,
        entryStrike: entryAtm,
        levelStrike: entryAtm,
        patternId: side === 'LONG' ? 'OCC_UP' : 'OCC_DN',
        patternName: side === 'LONG' ? 'Cover UP flip' : 'Cover DN flip',
        stopSpot: null,
        targetSpot: null,
        riskPts: optionSlPts,
        rewardPts: optionTpPts,
        entrySpotPlan: round(entry, 1),
        detail: `FLIP → ${optionType} ${entryAtm} @ ${cur.time} · opt +${optionTpPts}/−${optionSlPts}`,
        why: 'Opposite Cover · close & reverse',
        headline: 'FLIP',
      };
    }
  }

  if (!inSession) {
    return {
      ...base,
      ...sharedMeta,
      checks,
      detail: `Outside entry window · last 5m ${cur.time}`,
      why: `Entries ${base.rules.tradeFrom}–${base.rules.tradeTo} IST`,
    };
  }

  if (
    side
    && Number.isFinite(Number(opts.lastEntryBarMinutes))
    && Number(opts.lastEntryBarMinutes) === Number(cur.minutes)
  ) {
    return {
      ...base,
      ...sharedMeta,
      checks,
      detail: `Already entered on ${cur.time}`,
      why: 'One entry per signal bar',
    };
  }

  // Same side while open — keep watching
  if (openSide && side === openSide) {
    return {
      ...base,
      ...sharedMeta,
      checks,
      detail: `Riding ${openSide} · same-side Cover ignored`,
      why: `Hold until option +${optionTpPts}/−${optionSlPts} or EOD (no flip)`,
    };
  }

  if (side && !openSide) {
    const entry = Number(cur.spot);
    const optionType = side === 'LONG' ? 'CE' : 'PE';
    const entryAtm = atmStrike(entry) || atm;
    return {
      ...base,
      ...sharedMeta,
      status: 'TAKE_ENTRY',
      buyLive: true,
      optionType,
      entryStrike: entryAtm,
      levelStrike: entryAtm,
      patternId: side === 'LONG' ? 'OCC_UP' : 'OCC_DN',
      patternName: side === 'LONG' ? 'Cover UP' : 'Cover DN',
      stopSpot: null,
      targetSpot: null,
      riskPts: optionSlPts,
      rewardPts: optionTpPts,
      entrySpotPlan: round(entry, 1),
      checks: checks.map((c) => ({ ...c, ok: true })),
      detail: `${optionType} ${entryAtm} @ ${cur.time} · opt +${optionTpPts}/−${optionSlPts} · score ${sc}`,
      why: 'Cover Match · ATM scalp · no flip',
      headline: side === 'LONG' ? 'COVER UP' : 'COVER DN',
    };
  }

  return {
    ...base,
    ...sharedMeta,
    checks,
    detail: `Last 5m ${cur.time} · no Cover`,
    why: 'Need UP or DN Cover Match with Spot Δ',
  };
}

module.exports = {
  buildSignalFromOiFlow,
  scoreUp,
  scoreDn,
  STEP_DEFAULT,
  OPTION_TP_PTS,
  OPTION_SL_PTS,
  STOP_PTS,
  MIN_SPOT_DELTA,
};

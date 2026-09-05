/**
 * OI Trap Expansion (OTE) — elite trap → reversal → expansion.
 * Entry: T≥90 · R≥75 · E≥70 · no TP · SL −stopPts · stop after 1 SL once green
 */
const { build5mBars } = require('../../utils/oiFlow5mPatterns');
const { intervalOiFromRows } = require('../../utils/oiFlowIntervalOi');
const { round } = require('../../utils/oiFlowPlaybook');

const STEP_DEFAULT = 5;
const STOP_PTS = 8;
const TRAP_MIN = 90;
const REV_MIN = 75;
const EXP_MIN = 70;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.round(s / niftyStep()) * niftyStep();
}

function parseHhmm(raw, fallbackMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return fallbackMin;
  return Number(m[1]) * 60 + Number(m[2]);
}

function enrichBars(rows, step) {
  const bars = build5mBars(rows, step);
  const byMin = new Map();
  for (const row of rows || []) {
    if (row?.fetchOk === false) continue;
    byMin.set(row.minutes, row);
  }
  const chrono = [...byMin.values()].sort((a, b) => a.minutes - b.minutes);
  const prevByMin = new Map();
  for (let i = 1; i < chrono.length; i += 1) prevByMin.set(chrono[i].minutes, chrono[i - 1]);
  return bars.map((b) => {
    const row = byMin.get(b.minutes);
    const prev = prevByMin.get(b.minutes);
    const interval = row && prev ? intervalOiFromRows(row, prev) : { callsChgOi: null, putsChgOi: null };
    const callsChgOi = interval.callsChgOi;
    const putsChgOi = interval.putsChgOi;
    const netOi =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi) ? callsChgOi + putsChgOi : null;
    return { ...b, callsChgOi, putsChgOi, netOi, diffOi: b.chngInDir };
  });
}

function dominantPressure(b) {
  let bull = 0;
  let bear = 0;
  const net = Number(b.netOi);
  const diff = Number(b.diffOi);
  const vel = Number(b.oiVelocity);
  const dPcr = Number(b.deltaPcr);
  const spot = Number(b.spotDelta);
  const str = b.strength?.label || '';
  if (b.flowBias === 'Bull') bull += 25;
  if (b.flowBias === 'Bear') bear += 25;
  if (str.includes('Bull')) bull += str.startsWith('Strong') ? 20 : 10;
  if (str.includes('Bear')) bear += str.startsWith('Strong') ? 20 : 10;
  if (Number.isFinite(diff)) {
    if (diff > 0) bull += clamp(Math.abs(diff) / 5e6, 0, 15);
    if (diff < 0) bear += clamp(Math.abs(diff) / 5e6, 0, 15);
  }
  if (Number.isFinite(net)) {
    const add = clamp(Math.abs(net) / 8e6, 0, 12);
    if (b.flowBias === 'Bull' || (Number.isFinite(diff) && diff > 0)) bull += add;
    else if (b.flowBias === 'Bear' || (Number.isFinite(diff) && diff < 0)) bear += add;
  }
  if (Number.isFinite(vel) && vel >= 8000) {
    const add = clamp(vel / 20000, 0, 10);
    if (bull >= bear) bull += add;
    else bear += add;
  }
  if (Number.isFinite(dPcr)) {
    if (dPcr >= 0.02) bull += 8;
    if (dPcr <= -0.02) bear += 8;
  }
  if (Number.isFinite(spot)) {
    if (spot > 2) bull += 3;
    if (spot < -2) bear += 3;
  }
  if (bull > bear + 8) return { side: 'BULL', mag: round(bull, 1) };
  if (bear > bull + 8) return { side: 'BEAR', mag: round(bear, 1) };
  return { side: 'NEUTRAL', mag: round(Math.max(bull, bear), 1) };
}

function pressureFailure(pressure, spotDelta) {
  const spot = Number(spotDelta);
  if (!Number.isFinite(spot)) return { fail: false, kind: null };
  if (pressure.side === 'BULL' && pressure.mag >= 40 && spot <= 1) {
    return { fail: true, kind: 'BULL_PRESSURE_FAILURE' };
  }
  if (pressure.side === 'BEAR' && pressure.mag >= 40 && spot >= -1) {
    return { fail: true, kind: 'BEAR_PRESSURE_FAILURE' };
  }
  return { fail: false, kind: null };
}

function trapScore(b, pressure, fail, lookback) {
  if (!fail.fail) return 0;
  let s = 0;
  const spot = Number(b.spotDelta);
  const vel = Number(b.oiVelocity);
  const dPcr = Number(b.deltaPcr);
  const net = Number(b.netOi);
  s += clamp((pressure.mag - 35) * 0.8, 0, 25);
  if (fail.kind === 'BULL_PRESSURE_FAILURE') {
    if (spot <= 0) s += 10;
    if (spot <= -5) s += 15;
    if (spot <= -12) s += 15;
    if (Number.isFinite(dPcr) && dPcr >= 0.05) s += 10;
    if (Number.isFinite(dPcr) && dPcr >= 0.2) s += 8;
  } else {
    if (spot >= 0) s += 10;
    if (spot >= 5) s += 15;
    if (spot >= 12) s += 15;
    if (Number.isFinite(dPcr) && dPcr <= -0.05) s += 10;
    if (Number.isFinite(dPcr) && dPcr <= -0.2) s += 8;
  }
  if (Number.isFinite(vel) && vel >= 10000) s += 8;
  if (Number.isFinite(vel) && vel >= 20000) s += 7;
  if (Number.isFinite(net) && Math.abs(net) >= 2e7) s += 8;
  if (lookback?.length) {
    const recent = lookback.map((x) => Number(x.spotDelta)).filter(Number.isFinite);
    if (fail.kind === 'BULL_PRESSURE_FAILURE' && recent.some((x) => x >= 3) && spot <= -5) s += 12;
    if (fail.kind === 'BEAR_PRESSURE_FAILURE' && recent.some((x) => x <= -3) && spot >= 5) s += 12;
  }
  if (b.strength?.label?.startsWith('Strong')) s += 5;
  return clamp(Math.round(s), 0, 100);
}

function reversalScore(b, prev, failKind, trapSide) {
  let s = 0;
  const spot = Number(b.spotDelta);
  const net = Number(b.netOi);
  const prevNet = Number(prev?.netOi);
  const dPcr = Number(b.deltaPcr);
  const bearishRev = failKind === 'BULL_PRESSURE_FAILURE' || trapSide === 'BULL';
  if (bearishRev) {
    if (spot < 0) s += 12;
    if (spot <= -8) s += 18;
    if (spot <= -15) s += 12;
    if (Number.isFinite(net) && net < 0) s += 20;
    if (Number.isFinite(net) && Number.isFinite(prevNet) && prevNet > 0 && net < 0) s += 15;
    if (b.flowBias === 'Bear') s += 10;
    if (b.strength?.label?.includes('Bear')) s += 8;
    if (b.flowBias === 'Bull' && Number.isFinite(net) && net < 0) s += 8;
    if (Number.isFinite(dPcr) && dPcr < 0) s += 8;
  } else {
    if (spot > 0) s += 12;
    if (spot >= 8) s += 18;
    if (spot >= 15) s += 12;
    if (Number.isFinite(net) && net > 0) s += 20;
    if (Number.isFinite(net) && Number.isFinite(prevNet) && prevNet < 0 && net > 0) s += 15;
    if (b.flowBias === 'Bull') s += 10;
    if (b.strength?.label?.includes('Bull')) s += 8;
    if (Number.isFinite(dPcr) && dPcr > 0) s += 8;
  }
  return clamp(Math.round(s), 0, 100);
}

function expansionScore(b, prev, direction, trapSpot) {
  let s = 0;
  const spot = Number(b.spot);
  const spotDelta = Number(b.spotDelta);
  const net = Number(b.netOi);
  if (direction === 'DOWN') {
    if (spotDelta < 0) s += 15;
    if (spotDelta <= -8) s += 15;
    if (Number.isFinite(trapSpot) && spot < trapSpot - 5) s += 15;
    if (Number.isFinite(trapSpot) && spot < trapSpot - 15) s += 10;
    if (Number.isFinite(net) && net < 0) s += 15;
    if (b.flowBias === 'Bear' || b.strength?.label?.includes('Bear')) s += 8;
  } else {
    if (spotDelta > 0) s += 15;
    if (spotDelta >= 8) s += 15;
    if (Number.isFinite(trapSpot) && spot > trapSpot + 5) s += 15;
    if (Number.isFinite(trapSpot) && spot > trapSpot + 15) s += 10;
    if (Number.isFinite(net) && net > 0) s += 15;
    if (b.flowBias === 'Bull' || b.strength?.label?.includes('Bull')) s += 8;
  }
  if (Number(b.oiVelocity) >= 8000) s += 8;
  if (b.act === 'Match') s += 5;
  if (prev && direction === 'DOWN' && Number(prev.spotDelta) > 2 && spotDelta < -3) s += 8;
  if (prev && direction === 'UP' && Number(prev.spotDelta) < -2 && spotDelta > 3) s += 8;
  return clamp(Math.round(s), 0, 100);
}

function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const displayRow = tape?.displayRow || null;
  const step = Math.max(5, Math.floor(Number(settings.stepMin) || STEP_DEFAULT));
  const stopPts = Math.max(0.5, Number(settings.stopPts) || STOP_PTS);
  const trapMin = Math.max(50, Number(settings.trapMin) || TRAP_MIN);
  const revMin = Math.max(40, Number(settings.revMin) || REV_MIN);
  const expMin = Math.max(40, Number(settings.expMin) || EXP_MIN);
  const fromMin = parseHhmm(settings.tradeFromTime, 9 * 60 + 45);
  const toMin = parseHhmm(settings.tradeToTime, 14 * 60 + 30);

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
    trapScore: 0,
    revScore: 0,
    expScore: 0,
    trapState: 'NORMAL',
    noTarget: true,
    dayDone: Boolean(opts.dayDone),
    checks: [],
    detail: 'Waiting for Trap → Reversal → Expansion',
    why: `Elite T≥${trapMin} R≥${revMin} E≥${expMin}`,
    headline: null,
    rules: {
      stepMin: step,
      stopPts,
      trapMin,
      revMin,
      expMin,
      tradeFrom: settings.tradeFromTime || '09:45',
      tradeTo: settings.tradeToTime || '14:30',
    },
  };

  if (opts.dayDone) {
    return {
      ...base,
      status: 'DONE',
      detail: 'Day book locked',
      why: opts.dayLockReason || '1 SL after green · day done',
    };
  }

  const raw = rows
    .filter((r) => r && r.fetchOk !== false)
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));
  if (!raw.length) {
    return { ...base, detail: 'No OI Flow tape yet', why: 'Waiting for minute captures' };
  }

  const bars = enrichBars(raw, step);
  if (!bars.length) {
    return { ...base, detail: 'No closed 5m bars', why: 'Need completed intervals' };
  }

  let activeTrap = null;
  let lastEval = null;

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const m = Number(b.minutes);
    if (m < fromMin) continue;
    const prev = i > 0 ? bars[i - 1] : null;
    const lookback = bars.slice(Math.max(0, i - 3), i);
    const pressure = dominantPressure(b);
    const fail = pressureFailure(pressure, b.spotDelta);
    let tScore = fail.fail ? trapScore(b, pressure, fail, lookback) : 0;
    if (activeTrap && !fail.fail) tScore = Math.max(0, activeTrap.trapScore - 8);

    if (fail.fail && tScore >= 40) {
      const side = fail.kind.startsWith('BULL') ? 'BULL' : 'BEAR';
      if (!activeTrap || activeTrap.side !== side) {
        activeTrap = { side, trapScore: tScore, trapSpot: Number(b.spot), failKind: fail.kind };
      } else {
        activeTrap.trapScore = Math.max(activeTrap.trapScore, tScore);
      }
    }

    let rScore = 0;
    let eScore = 0;
    let state = fail.fail ? 'PRESSURE_FAILURE' : 'NORMAL';
    let side = null;

    if (activeTrap) {
      tScore = Math.max(tScore, activeTrap.trapScore);
      rScore = reversalScore(b, prev, activeTrap.failKind, activeTrap.side);
      const revDir = activeTrap.side === 'BULL' ? 'DOWN' : 'UP';
      eScore = expansionScore(b, prev, revDir, activeTrap.trapSpot);
      if (tScore >= 70 && rScore >= 65) {
        state = activeTrap.side === 'BULL' ? 'BULL_TRAP_CONFIRMED' : 'BEAR_TRAP_CONFIRMED';
        if (eScore >= 40) state = 'EXPANSION_WATCH';
        if (tScore >= trapMin && rScore >= revMin && eScore >= expMin) {
          state = revDir === 'DOWN' ? 'BIG_MOVE_DOWN' : 'BIG_MOVE_UP';
          side = revDir === 'DOWN' ? 'SHORT' : 'LONG';
        }
      } else if (rScore >= 40) state = 'EARLY_REVERSAL';
    }

    lastEval = {
      bar: b,
      tScore,
      rScore,
      eScore,
      state,
      side,
      pressure: pressure.side,
    };
  }

  if (!lastEval) {
    return { ...base, detail: 'No bars in session yet', why: 'Waiting for window' };
  }

  const { bar: cur, tScore, rScore, eScore, state, side, pressure } = lastEval;
  const inSession = Number(cur.minutes) >= fromMin && Number(cur.minutes) <= toMin;

  const checks = [
    { id: 'trap', name: 'Trap score', short: 'Trap', ok: tScore >= trapMin, value: String(tScore), need: `≥${trapMin}`, note: 'Pressure failure' },
    { id: 'rev', name: 'Reversal score', short: 'Rev', ok: rScore >= revMin, value: String(rScore), need: `≥${revMin}`, note: 'Control change' },
    { id: 'exp', name: 'Expansion score', short: 'Exp', ok: eScore >= expMin, value: String(eScore), need: `≥${expMin}`, note: 'Momentum' },
  ];

  const shared = {
    strength: cur.strength?.label,
    flowBias: cur.flowBias,
    spotDelta: round(cur.spotDelta),
    act: cur.act,
    callAct: cur.callAct,
    putAct: cur.putAct,
    barTime: cur.time,
    barMinutes: cur.minutes,
    trapScore: tScore,
    revScore: rScore,
    expScore: eScore,
    trapState: state,
    pressure,
    checks,
  };

  if (!inSession) {
    return {
      ...base,
      ...shared,
      detail: `Outside entry · ${cur.time} · ${state} T/R/E ${tScore}/${rScore}/${eScore}`,
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
      ...shared,
      detail: `Already entered on ${cur.time}`,
      why: 'One entry per signal bar',
    };
  }

  if (side && state.startsWith('BIG_MOVE')) {
    const entry = Number(cur.spot);
    const stopSpot = side === 'LONG' ? entry - stopPts : entry + stopPts;
    const optionType = side === 'LONG' ? 'CE' : 'PE';
    const entryAtm = atmStrike(entry) || atm;
    return {
      ...base,
      ...shared,
      status: 'TAKE_ENTRY',
      buyLive: true,
      optionType,
      entryStrike: entryAtm,
      levelStrike: entryAtm,
      patternId: state,
      patternName: state.replace(/_/g, ' '),
      stopSpot: round(stopSpot, 1),
      targetSpot: null,
      riskPts: stopPts,
      rewardPts: null,
      entrySpotPlan: round(entry, 1),
      checks: checks.map((c) => ({ ...c, ok: true })),
      detail: `${optionType} ${entryAtm} @ ${cur.time} · ${state} · T/R/E ${tScore}/${rScore}/${eScore}`,
      why: 'Elite trap expansion · no TP · SL only',
      headline: state === 'BIG_MOVE_UP' ? 'BIG MOVE UP' : 'BIG MOVE DOWN',
    };
  }

  return {
    ...base,
    ...shared,
    detail: `${cur.time} · ${state} · T/R/E ${tScore}/${rScore}/${eScore}`,
    why: side ? 'Scores building' : 'Need elite Trap+Rev+Exp',
  };
}

module.exports = {
  buildSignalFromOiFlow,
  STEP_DEFAULT,
  STOP_PTS,
  TRAP_MIN,
  REV_MIN,
  EXP_MIN,
};

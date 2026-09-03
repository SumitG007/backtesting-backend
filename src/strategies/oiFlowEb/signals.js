/**
 * OI Flow E/B — closed 15m Strong Bull/Bear + Spot Δ + Match → ATM CE/PE.
 */
const {
  build5mBars,
  matchLivePattern,
  attachCandleRange,
  STEP,
  BUF,
  RISK_MIN,
  RISK_MAX,
  R_MULT,
  TP_CAP,
  MAX_HOLD,
  DAILY_TARGET,
  DAILY_LOSS,
  round,
} = require('../../utils/oiFlowPlaybook');

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  const step = niftyStep();
  return Math.round(s / step) * step;
}

/**
 * @param {object} tape — oiFlow listTodayRows payload
 * @param {object} settings
 * @param {{ dayLocked?: boolean, dayPts?: number, dayStopReason?: string|null, lastEntryBarMinutes?: number|null }} opts
 */
function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const displayRow = tape?.displayRow || null;
  const step = Math.max(5, Math.floor(Number(settings.stepMin) || STEP));
  const callMinSpotDelta = Number(settings.callMinSpotDelta);
  const minCallDelta = Number.isFinite(callMinSpotDelta) ? callMinSpotDelta : 5;
  const riskMin = Math.max(1, Number(settings.riskMin) || RISK_MIN);
  const riskMax = Math.max(riskMin, Number(settings.riskMax) || RISK_MAX);
  const buffer = Math.max(0, Number(settings.slBufferPts) || BUF);
  const rMult = Math.max(0.5, Number(settings.rMult) || R_MULT);
  const tpCap = Math.max(1, Number(settings.tpCap) || TP_CAP);
  const maxHoldMin = Math.max(5, Number(settings.maxHoldMin) || MAX_HOLD);
  const dailyTarget = Math.max(1, Number(settings.dailyTarget) || DAILY_TARGET);
  const dailyLoss = Math.max(1, Number(settings.dailyLoss) || DAILY_LOSS);

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
    patternId: null,
    patternName: null,
    barTime: null,
    barMinutes: null,
    riskPts: null,
    rewardPts: null,
    stopSpot: null,
    targetSpot: null,
    dayPts: Number.isFinite(Number(opts.dayPts)) ? Number(opts.dayPts) : 0,
    dayLocked: Boolean(opts.dayLocked),
    checks: [],
    detail: 'Waiting for closed 15m E/B bar',
    why: 'Need Strong Bull/Bear + Spot Δ + Act Match on a closed 15m candle',
    headline: null,
    rules: {
      stepMin: step,
      riskMin,
      riskMax,
      buffer,
      rMult,
      tpCap,
      maxHoldMin,
      dailyTarget,
      dailyLoss,
      callMinSpotDelta: minCallDelta,
    },
  };

  if (opts.dayLocked) {
    return {
      ...base,
      status: 'DONE',
      detail: opts.dayStopReason || `Day locked · pts ${base.dayPts}`,
      why: 'Daily target or loss hit — no more entries today',
      headline: 'Day locked',
      checks: [
        {
          id: 'day',
          name: 'Day lock',
          short: 'Day',
          ok: false,
          value: String(base.dayPts),
          need: `+${dailyTarget} / −${dailyLoss}`,
          note: opts.dayStopReason || 'Locked',
        },
      ],
    };
  }

  const raw = rows
    .filter((r) => r && r.fetchOk !== false)
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));
  if (!raw.length) {
    return { ...base, detail: 'No OI Flow tape yet', why: 'Waiting for minute captures' };
  }

  const rawByMin = new Map(raw.map((r) => [Number(r.minutes), r]));
  let bars = build5mBars(raw, step);
  bars = attachCandleRange(bars, rawByMin);
  if (!bars.length) {
    return { ...base, detail: 'No closed 15m bars yet', why: 'Need a completed 15m interval' };
  }

  const lastClosed = bars[bars.length - 1];
  const strength = lastClosed?.strength?.label || null;
  const spotDelta = round(lastClosed?.spotDelta);
  const act = lastClosed?.act || null;

  const strengthOkBull = strength === 'Strong Bull';
  const strengthOkBear = strength === 'Strong Bear';
  const spotOkCall = Number.isFinite(spotDelta) && spotDelta >= minCallDelta;
  const spotOkPut = Number.isFinite(spotDelta) && spotDelta < 0;
  const actOk = act === 'Match';

  const checks = [
    {
      id: 'strength',
      name: 'Strength',
      short: 'Str',
      ok: strengthOkBull || strengthOkBear,
      value: strength || '—',
      need: 'Strong Bull / Strong Bear',
      note: 'OI flow confirmation score',
    },
    {
      id: 'spot',
      name: 'Spot Δ',
      short: 'SpotΔ',
      ok: spotOkCall || spotOkPut,
      value: spotDelta == null ? '—' : String(spotDelta),
      need: `CALL ≥+${minCallDelta} · PUT <0`,
      note: 'Price trigger on closed bar',
    },
    {
      id: 'act',
      name: 'Act',
      short: 'Act',
      ok: actOk,
      value: act || '—',
      need: 'Match',
      note: 'Call + Put tones agree',
    },
    {
      id: 'bar',
      name: '15m closed',
      short: '15m',
      ok: Boolean(lastClosed?.time),
      value: lastClosed?.time || '—',
      need: `Closed ${step}m`,
      note: 'Never trade the forming bar',
    },
  ];

  let match = null;
  if (strengthOkBull && spotOkCall && actOk) {
    match = {
      patternId: 'E',
      side: 'CALL',
      decision: 'CALL BUY',
      patternName: `Strong Bull + Spot↑≥${minCallDelta} + Match`,
      shortName: `SB↑≥${minCallDelta} Match`,
    };
  } else if (strengthOkBear && spotOkPut && actOk) {
    match = matchLivePattern(lastClosed) || {
      patternId: 'B',
      side: 'PUT',
      decision: 'PUT BUY',
      patternName: 'Strong Bear + Spot↓ + Match',
      shortName: 'SBe↓ Match',
    };
  }

  if (
    match
    && Number.isFinite(Number(opts.lastEntryBarMinutes))
    && Number(opts.lastEntryBarMinutes) === Number(lastClosed.minutes)
  ) {
    return {
      ...base,
      status: 'WATCHING',
      strength,
      spotDelta,
      act,
      barTime: lastClosed.time,
      barMinutes: lastClosed.minutes,
      checks,
      detail: `Already traded ${lastClosed.time} bar`,
      why: 'One entry per closed 15m bar — waiting for the next bar',
      headline: `${match.decision} · done this bar`,
    };
  }

  if (match) {
    const side = match.side;
    const optionType = side === 'CALL' ? 'CE' : 'PE';
    const entry = Number(lastClosed.spot);
    const high = Number(lastClosed.high);
    const low = Number(lastClosed.low);
    const rawRisk = side === 'CALL' ? entry - (low - buffer) : high + buffer - entry;
    const risk = Math.min(riskMax, Math.max(riskMin, rawRisk));
    const reward = Math.min(tpCap, risk * rMult);
    const stopSpot = side === 'CALL' ? entry - risk : entry + risk;
    const targetSpot = side === 'CALL' ? entry + reward : entry - reward;
    const lv = {
      entry: round(entry, 1),
      rawRisk: round(rawRisk),
      risk: round(risk),
      reward: round(reward),
      stopSpot: round(stopSpot, 1),
      targetSpot: round(targetSpot, 1),
      clamped: rawRisk > riskMax || rawRisk < riskMin,
    };

    return {
      ...base,
      status: 'TAKE_ENTRY',
      buyLive: true,
      optionType,
      entryStrike: atm,
      levelStrike: atm,
      strength,
      spotDelta,
      act,
      patternId: match.patternId,
      patternName: match.patternName || match.shortName,
      shortName: match.shortName,
      decision: match.decision,
      barTime: lastClosed.time,
      barMinutes: lastClosed.minutes,
      candleHigh: round(high, 1),
      candleLow: round(low, 1),
      riskPts: lv.risk,
      rewardPts: lv.reward,
      rawRisk: lv.rawRisk,
      stopSpot: lv.stopSpot,
      targetSpot: lv.targetSpot,
      clamped: lv.clamped,
      entrySpot: lv.entry,
      checks: checks.map((c) => ({ ...c, ok: true })),
      detail: `${match.decision} · ATM ${atm} · SL ${lv.risk} TP ${lv.reward}`,
      why: `${match.patternName} on closed ${lastClosed.time}`,
      headline: `${optionType} · ${atm}`,
      maxHoldMin,
    };
  }

  if (strengthOkBull || strengthOkBear) {
    const sideHint = strengthOkBull ? 'CALL' : 'PUT';
    return {
      ...base,
      status: 'NEAR',
      optionType: sideHint === 'CALL' ? 'CE' : 'PE',
      strength,
      spotDelta,
      act,
      barTime: lastClosed.time,
      barMinutes: lastClosed.minutes,
      checks,
      detail: `${strength} — waiting Spot Δ + Match`,
      why:
        strengthOkBull && !spotOkCall
          ? `Need Spot Δ ≥ +${minCallDelta}`
          : strengthOkBear && !spotOkPut
            ? 'Need Spot Δ < 0'
            : !actOk
              ? 'Need Act Match'
              : 'Almost ready',
      headline: `${sideHint} setup forming`,
    };
  }

  return {
    ...base,
    status: 'WATCHING',
    strength,
    spotDelta,
    act,
    barTime: lastClosed?.time || null,
    barMinutes: lastClosed?.minutes ?? null,
    checks,
    detail: lastClosed?.time
      ? `${lastClosed.time} · ${strength || 'Neutral'} · Δ ${spotDelta ?? '—'} · ${act || '—'}`
      : 'Scanning closed 15m bars',
    why: 'Waiting for Strong Bull/Bear + Spot trigger + Match',
  };
}

module.exports = {
  buildSignalFromOiFlow,
  atmStrike,
};

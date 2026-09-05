/**
 * OI Flow Continuation — closed 5m bars.
 * Setup: streak≥2 + Strong Bull/Bear + flow agrees + ΔPCR same sign.
 * Arm signal candle H/L → wait for later bar break → ATM CE/PE.
 * Risk on Nifty: SL = signal extreme, TP = 1.5R (exit option when spot hits).
 */
const {
  build5mBars,
  attachCandleRange,
  round,
  DAILY_TARGET,
  DAILY_LOSS,
} = require('../../utils/oiFlowPlaybook');

const STEP_DEFAULT = 5;
const R_MULT_DEFAULT = 1.5;

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  const step = niftyStep();
  return Math.round(s / step) * step;
}

function isBuySetup(bar) {
  return (
    bar?.flowBias === 'Bull'
    && Number(bar.streak) >= 2
    && bar.strength?.label === 'Strong Bull'
    && Number.isFinite(Number(bar.deltaPcr))
    && Number(bar.deltaPcr) > 0
  );
}

function isSellSetup(bar) {
  return (
    bar?.flowBias === 'Bear'
    && Number(bar.streak) >= 2
    && bar.strength?.label === 'Strong Bear'
    && Number.isFinite(Number(bar.deltaPcr))
    && Number(bar.deltaPcr) < 0
  );
}

function levelsFromSignal(side, signalHigh, signalLow, rMult) {
  const high = Number(signalHigh);
  const low = Number(signalLow);
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  const entry = side === 'CALL' ? high : low;
  const stopSpot = side === 'CALL' ? low : high;
  const risk = Math.abs(entry - stopSpot);
  if (!(risk > 0)) return null;
  const reward = risk * rMult;
  const targetSpot = side === 'CALL' ? entry + reward : entry - reward;
  return {
    entrySpot: round(entry, 1),
    stopSpot: round(stopSpot, 1),
    targetSpot: round(targetSpot, 1),
    riskPts: round(risk, 1),
    rewardPts: round(reward, 1),
  };
}

/**
 * @param {object} tape
 * @param {object} settings
 * @param {{ dayLocked?: boolean, dayPts?: number, dayStopReason?: string|null, lastEntryBarMinutes?: number|null, pending?: object|null }} opts
 */
function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const displayRow = tape?.displayRow || null;
  const step = Math.max(5, Math.floor(Number(settings.stepMin) || STEP_DEFAULT));
  const rMult = Math.max(0.5, Number(settings.rMult) || R_MULT_DEFAULT);
  const minStreak = Math.max(2, Math.floor(Number(settings.minStreak) || 2));
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
    signalHigh: null,
    signalLow: null,
    dayPts: Number.isFinite(Number(opts.dayPts)) ? Number(opts.dayPts) : 0,
    dayLocked: Boolean(opts.dayLocked),
    pending: null,
    clearPending: false,
    checks: [],
    detail: 'Waiting for 5m continuation setup',
    why: 'Need 2B+/Strong Bull/Bull flow/ΔPCR+ or 2Be+/Strong Bear/Bear flow/ΔPCR−, then price break',
    headline: null,
    rules: {
      stepMin: step,
      rMult,
      minStreak,
      dailyTarget,
      dailyLoss,
    },
  };

  if (opts.dayLocked) {
    return {
      ...base,
      status: 'DONE',
      clearPending: true,
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
    return { ...base, detail: 'No closed 5m bars yet', why: 'Need a completed 5m interval' };
  }

  const pending = opts.pending && typeof opts.pending === 'object' ? opts.pending : null;

  // --- Armed: wait for break of signal H/L on a later closed bar ---
  if (pending?.side && Number.isFinite(Number(pending.signalMinutes))) {
    const side = pending.side === 'PUT' ? 'PUT' : 'CALL';
    const signalHigh = Number(pending.signalHigh);
    const signalLow = Number(pending.signalLow);
    const sigMin = Number(pending.signalMinutes);

    for (const bar of bars) {
      if (Number(bar.minutes) <= sigMin) continue;

      if (side === 'CALL' && isSellSetup(bar)) {
        return {
          ...base,
          status: 'WATCHING',
          clearPending: true,
          strength: bar.strength?.label,
          flowBias: bar.flowBias,
          streak: bar.streak,
          deltaPcr: round(bar.deltaPcr, 4),
          barTime: bar.time,
          barMinutes: bar.minutes,
          detail: 'Pending BUY cancelled — opposite Strong Bear setup',
          why: 'Reversal package appeared before breakout',
          headline: 'Pending cleared',
        };
      }
      if (side === 'PUT' && isBuySetup(bar)) {
        return {
          ...base,
          status: 'WATCHING',
          clearPending: true,
          strength: bar.strength?.label,
          flowBias: bar.flowBias,
          streak: bar.streak,
          deltaPcr: round(bar.deltaPcr, 4),
          barTime: bar.time,
          barMinutes: bar.minutes,
          detail: 'Pending SELL cancelled — opposite Strong Bull setup',
          why: 'Reversal package appeared before breakdown',
          headline: 'Pending cleared',
        };
      }

      const high = Number(bar.high);
      const low = Number(bar.low);
      const broke =
        side === 'CALL'
          ? Number.isFinite(high) && high > signalHigh
          : Number.isFinite(low) && low < signalLow;

      if (!broke) continue;

      if (
        Number.isFinite(Number(opts.lastEntryBarMinutes))
        && Number(opts.lastEntryBarMinutes) === Number(bar.minutes)
      ) {
        return {
          ...base,
          status: 'WATCHING',
          clearPending: true,
          detail: `Already entered on ${bar.time}`,
          why: 'One entry per confirm bar',
        };
      }

      const lv = levelsFromSignal(side, signalHigh, signalLow, rMult);
      if (!lv) {
        return {
          ...base,
          status: 'WATCHING',
          clearPending: true,
          detail: 'Invalid signal range',
          why: 'Signal high/low not usable',
        };
      }

      const optionType = side === 'CALL' ? 'CE' : 'PE';
      const entryAtm = atmStrike(lv.entrySpot) || atm;

      return {
        ...base,
        status: 'TAKE_ENTRY',
        buyLive: true,
        clearPending: true,
        optionType,
        entryStrike: entryAtm,
        levelStrike: entryAtm,
        strength: pending.strength || null,
        flowBias: pending.flowBias || null,
        streak: pending.streak || null,
        deltaPcr: pending.deltaPcr != null ? Number(pending.deltaPcr) : null,
        patternId: side === 'CALL' ? 'CONT_B' : 'CONT_Be',
        patternName:
          side === 'CALL'
            ? 'Continuation BUY · Nifty high break → ATM CE'
            : 'Continuation SELL · Nifty low break → ATM PE',
        barTime: bar.time,
        barMinutes: bar.minutes,
        signalHigh: round(signalHigh, 1),
        signalLow: round(signalLow, 1),
        stopSpot: lv.stopSpot,
        targetSpot: lv.targetSpot,
        riskPts: lv.riskPts,
        rewardPts: lv.rewardPts,
        entrySpotPlan: lv.entrySpot,
        detail: `${optionType} ${entryAtm} · break @ ${bar.time}`,
        why: `Nifty ${side === 'CALL' ? 'broke signal high' : 'broke signal low'} → enter ATM ${optionType}`,
        headline: side === 'CALL' ? 'BUY confirm' : 'SELL confirm',
        checks: [
          { id: 'setup', name: 'OI setup', short: 'OI', ok: true, value: 'Armed', need: 'Valid', note: 'Held from signal' },
          {
            id: 'break',
            name: 'Price break',
            short: 'Brk',
            ok: true,
            value: bar.time,
            need: side === 'CALL' ? `> ${signalHigh}` : `< ${signalLow}`,
            note: 'Confirm candle',
          },
          {
            id: 'risk',
            name: '1.5R plan',
            short: 'R',
            ok: true,
            value: `${lv.riskPts} → ${lv.rewardPts}`,
            need: `${rMult}R`,
            note: 'Nifty SL / target',
          },
        ],
      };
    }

    // Still waiting
    const lv = levelsFromSignal(
      pending.side === 'PUT' ? 'PUT' : 'CALL',
      signalHigh,
      signalLow,
      rMult,
    );
    return {
      ...base,
      status: 'WAIT_BREAK',
      pending: { ...pending },
      optionType: pending.side === 'PUT' ? 'PE' : 'CE',
      strength: pending.strength || null,
      flowBias: pending.flowBias || null,
      streak: pending.streak || null,
      deltaPcr: pending.deltaPcr != null ? Number(pending.deltaPcr) : null,
      barTime: pending.signalTime || null,
      barMinutes: pending.signalMinutes,
      signalHigh: round(signalHigh, 1),
      signalLow: round(signalLow, 1),
      stopSpot: lv?.stopSpot ?? null,
      targetSpot: lv?.targetSpot ?? null,
      riskPts: lv?.riskPts ?? null,
      rewardPts: lv?.rewardPts ?? null,
      detail: `Armed ${pending.side === 'PUT' ? 'SELL' : 'BUY'} · wait Nifty ${pending.side === 'PUT' ? 'low' : 'high'} break`,
      why: `Signal ${pending.signalTime} H ${signalHigh} / L ${signalLow} — no break yet`,
      headline: 'Wait price confirm',
      checks: [
        {
          id: 'setup',
          name: 'OI setup',
          short: 'OI',
          ok: true,
          value: `${pending.streak || '—'} ${pending.strength || ''}`.trim(),
          need: `≥${minStreak} + Strong`,
          note: 'Signal candle locked',
        },
        {
          id: 'break',
          name: 'Price break',
          short: 'Brk',
          ok: false,
          value: '—',
          need: pending.side === 'PUT' ? `Low < ${signalLow}` : `High > ${signalHigh}`,
          note: 'Later 5m candle',
        },
      ],
    };
  }

  // --- Fresh setup on latest closed bar ---
  const lastClosed = bars[bars.length - 1];
  const buy = isBuySetup(lastClosed) && Number(lastClosed.streak) >= minStreak;
  const sell = isSellSetup(lastClosed) && Number(lastClosed.streak) >= minStreak;

  const checks = [
    {
      id: 'streak',
      name: 'Streak',
      short: 'Stk',
      ok: Number(lastClosed.streak) >= minStreak && (lastClosed.flowBias === 'Bull' || lastClosed.flowBias === 'Bear'),
      value: lastClosed.streak != null ? `${lastClosed.streak}${lastClosed.flowBias === 'Bull' ? 'B' : lastClosed.flowBias === 'Bear' ? 'Be' : ''}` : '—',
      need: `≥${minStreak}B / ≥${minStreak}Be`,
      note: 'Same-bias closed bars',
    },
    {
      id: 'strength',
      name: 'Strength',
      short: 'Str',
      ok: lastClosed.strength?.label === 'Strong Bull' || lastClosed.strength?.label === 'Strong Bear',
      value: lastClosed.strength?.label || '—',
      need: 'Strong Bull / Strong Bear',
      note: 'OI flow score',
    },
    {
      id: 'flow',
      name: 'Flow bias',
      short: 'Flow',
      ok: lastClosed.flowBias === 'Bull' || lastClosed.flowBias === 'Bear',
      value: lastClosed.flowBias || '—',
      need: 'Bull / Bear',
      note: 'ΔOI direction',
    },
    {
      id: 'pcr',
      name: 'ΔPCR',
      short: 'ΔPCR',
      ok:
        (lastClosed.flowBias === 'Bull' && Number(lastClosed.deltaPcr) > 0)
        || (lastClosed.flowBias === 'Bear' && Number(lastClosed.deltaPcr) < 0),
      value: Number.isFinite(Number(lastClosed.deltaPcr)) ? String(round(lastClosed.deltaPcr, 4)) : '—',
      need: 'Same sign as flow',
      note: 'Must agree with bias',
    },
  ];

  if (
    (buy || sell)
    && Number.isFinite(Number(opts.lastEntryBarMinutes))
    && Number(opts.lastEntryBarMinutes) === Number(lastClosed.minutes)
  ) {
    return {
      ...base,
      status: 'WATCHING',
      strength: lastClosed.strength?.label,
      flowBias: lastClosed.flowBias,
      streak: lastClosed.streak,
      deltaPcr: round(lastClosed.deltaPcr, 4),
      spotDelta: round(lastClosed.spotDelta),
      act: lastClosed.act,
      barTime: lastClosed.time,
      barMinutes: lastClosed.minutes,
      checks,
      detail: `Setup already used at ${lastClosed.time}`,
      why: 'Waiting for a new signal candle',
    };
  }

  if (buy || sell) {
    const side = buy ? 'CALL' : 'PUT';
    const high = Number(lastClosed.high);
    const low = Number(lastClosed.low);
    const lv = levelsFromSignal(side, high, low, rMult);
    const nextPending = {
      side,
      signalMinutes: lastClosed.minutes,
      signalTime: lastClosed.time,
      signalHigh: high,
      signalLow: low,
      strength: lastClosed.strength?.label,
      flowBias: lastClosed.flowBias,
      streak: lastClosed.streak,
      deltaPcr: round(lastClosed.deltaPcr, 4),
      atm: atmStrike(lastClosed.spot) || atm,
    };
    return {
      ...base,
      status: 'WAIT_BREAK',
      pending: nextPending,
      optionType: buy ? 'CE' : 'PE',
      strength: lastClosed.strength?.label,
      flowBias: lastClosed.flowBias,
      streak: lastClosed.streak,
      deltaPcr: round(lastClosed.deltaPcr, 4),
      spotDelta: round(lastClosed.spotDelta),
      act: lastClosed.act,
      patternId: buy ? 'CONT_B' : 'CONT_Be',
      patternName: buy ? 'Continuation BUY armed' : 'Continuation SELL armed',
      barTime: lastClosed.time,
      barMinutes: lastClosed.minutes,
      signalHigh: round(high, 1),
      signalLow: round(low, 1),
      stopSpot: lv?.stopSpot ?? null,
      targetSpot: lv?.targetSpot ?? null,
      riskPts: lv?.riskPts ?? null,
      rewardPts: lv?.rewardPts ?? null,
      checks: checks.map((c) => ({ ...c, ok: true })),
      detail: `Armed ${buy ? 'BUY' : 'SELL'} @ ${lastClosed.time} · wait break`,
      why: buy
        ? `Wait for a later 5m candle high > ${round(high, 1)} then buy ATM CE`
        : `Wait for a later 5m candle low < ${round(low, 1)} then buy ATM PE`,
      headline: buy ? 'BUY armed' : 'SELL armed',
    };
  }

  return {
    ...base,
    status: 'WATCHING',
    strength: lastClosed.strength?.label,
    flowBias: lastClosed.flowBias,
    streak: lastClosed.streak,
    deltaPcr: round(lastClosed.deltaPcr, 4),
    spotDelta: round(lastClosed.spotDelta),
    act: lastClosed.act,
    barTime: lastClosed.time,
    barMinutes: lastClosed.minutes,
    checks,
    detail: `Last 5m ${lastClosed.time} · no full setup`,
    why: 'Need streak + Strong + flow + ΔPCR agreement',
    headline: null,
  };
}

module.exports = {
  buildSignalFromOiFlow,
  isBuySetup,
  isSellSetup,
  levelsFromSignal,
  STEP_DEFAULT,
  R_MULT_DEFAULT,
};

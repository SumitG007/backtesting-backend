/**
 * Flow Match Scalp — closed 3m OI Flow bar.
 * Strong Bull/Bear + Match + spot with flow → ATM CE/PE.
 * Engine adds green 1m strike candle before fill · +2/−3.
 */
const { build5mBars } = require('../../utils/oiFlow5mPatterns');

const STEP_3M = 3;

function round(n, d = 1) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  const step = niftyStep();
  return Math.round(s / step) * step;
}

function latestClosed3mBar(rows, clockMinutes) {
  const bars = build5mBars(rows, STEP_3M);
  const clock = Number(clockMinutes);
  const closed = Number.isFinite(clock)
    ? bars.filter((b) => Number(b.minutes) < clock)
    : bars;
  return closed.length ? closed[closed.length - 1] : null;
}

function strengthIsStrong(label) {
  return label === 'Strong Bull' || label === 'Strong Bear';
}

function spotWithFlow(bar) {
  const d = Number(bar?.spotDelta);
  if (!Number.isFinite(d) || d === 0) return false;
  if (bar.flowBias === 'Bull') return d > 0;
  if (bar.flowBias === 'Bear') return d < 0;
  return false;
}

/**
 * Latest closed 3m OI Flow bar → side when Strong + Match + spot aligned.
 * @param {object} tape — oiFlow listTodayRows payload
 * @param {object} settings
 * @param {object} opts — clockMinutes, lastEntryBarMinutes, dayLocked, dayPts
 */
function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const displayRow = tape?.displayRow || null;
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const clockMinutes = Number.isFinite(Number(opts.clockMinutes))
    ? Number(opts.clockMinutes)
    : Number(displayRow?.minutes);
  const bar = latestClosed3mBar(rows, clockMinutes);
  const lastUsedBar = Number(opts.lastEntryBarMinutes);

  const optionSlPts = Math.max(1, Number(settings.optionSlPts) || 3);
  const optionTpPts = Math.max(1, Number(settings.optionTpPts) || 2);

  const spotNow = Number(bar?.spot ?? displayRow?.spotPrice ?? displayRow?.spot);
  const atm = Number(bar?.atm) || Number(displayRow?.atm) || atmStrike(spotNow);
  const strengthLabel = bar?.strength?.label || 'Neutral';
  const act = bar?.act || '—';
  const bias = bar?.flowBias || 'Neutral';
  const flowTime = bar?.time || null;
  const flowMinutes = Number.isFinite(Number(bar?.minutes)) ? Number(bar.minutes) : null;

  const base = {
    status: 'WATCHING',
    buyLive: false,
    optionType: null,
    entryStrike: atm,
    levelStrike: atm,
    spot: Number.isFinite(spotNow) ? round(spotNow, 1) : null,
    atm: Number.isFinite(atm) ? atm : null,
    flowBias: bias,
    chngInDir: Number.isFinite(Number(bar?.chngInDir)) ? Number(bar.chngInDir) : null,
    flowTime,
    barTime: flowTime,
    barMinutes: flowMinutes,
    strength: strengthLabel,
    spotDelta: Number.isFinite(Number(bar?.spotDelta)) ? Number(bar.spotDelta) : null,
    act,
    callAct: bar?.callAct || null,
    putAct: bar?.putAct || null,
    patternId: null,
    patternName: null,
    riskPts: optionSlPts,
    rewardPts: optionTpPts,
    dayPts: Number.isFinite(Number(opts.dayPts)) ? Number(opts.dayPts) : 0,
    dayLocked: Boolean(opts.dayLocked),
    checks: [],
    detail: 'Waiting for closed 3m Strong + Match',
    why: 'Need closed 3m Strong Bull/Bear, Match, and spot with flow',
    headline: null,
    rules: {
      optionSlPts,
      optionTpPts,
      mode: 'closed_3m_match',
      stepMin: STEP_3M,
    },
  };

  if (!bar) {
    return {
      ...base,
      status: 'WAIT',
      detail: 'No closed 3m OI Flow bar yet',
      why: 'Waiting for a finished 3-minute flow bar',
      headline: 'Waiting 3m bar',
      checks: [
        {
          id: 'bar',
          name: 'Closed 3m bar',
          short: '3m',
          ok: false,
          value: '—',
          need: 'Closed bar',
          note: 'No bar',
        },
      ],
    };
  }

  const strongOk = strengthIsStrong(strengthLabel);
  const matchOk = act === 'Match';
  const spotOk = spotWithFlow(bar);
  const atmOk = Number.isFinite(atm);
  const sameBar = Number.isFinite(flowMinutes) && Number.isFinite(lastUsedBar) && flowMinutes === lastUsedBar;

  const checks = [
    {
      id: 'bar',
      name: 'Closed 3m bar',
      short: '3m',
      ok: true,
      value: flowTime || String(flowMinutes),
      need: 'Finished 3m',
      note: 'Not forming',
    },
    {
      id: 'strength',
      name: 'Flow strength',
      short: 'Str',
      ok: strongOk,
      value: strengthLabel,
      need: 'Strong Bull / Strong Bear',
      note: bias,
    },
    {
      id: 'match',
      name: 'CE/PE acts',
      short: 'Act',
      ok: matchOk,
      value: act,
      need: 'Match',
      note: [bar.callAct, bar.putAct].filter(Boolean).join(' · ') || '—',
    },
    {
      id: 'spot',
      name: 'Spot with flow',
      short: 'Spot',
      ok: spotOk,
      value: Number.isFinite(Number(bar.spotDelta))
        ? `${bar.spotDelta > 0 ? '+' : ''}${round(bar.spotDelta, 1)}`
        : '—',
      need: 'Bull + up · Bear + down',
      note: bias,
    },
    {
      id: 'atm',
      name: 'ATM strike',
      short: 'ATM',
      ok: atmOk,
      value: atmOk ? String(atm) : '—',
      need: 'Valid ATM',
      note: Number.isFinite(spotNow) ? `Spot ${round(spotNow, 1)}` : '—',
    },
  ];

  if (sameBar) {
    return {
      ...base,
      status: 'WATCHING',
      checks: [
        ...checks,
        {
          id: 'used',
          name: 'This 3m bar',
          short: 'Bar',
          ok: false,
          value: 'used',
          need: 'New closed 3m',
          note: 'Already traded this bar',
        },
      ],
      detail: `3m ${flowTime || flowMinutes} already used`,
      why: 'Wait for the next closed 3m bar',
      headline: 'Bar used · wait next 3m',
    };
  }

  if (!strongOk || !matchOk || !spotOk || !atmOk) {
    let why = 'Wait for Strong + Match + spot with flow on a closed 3m bar';
    if (act === 'Fight') why = 'Fight — CE and PE OI disagree · skip';
    else if (!strongOk) why = `Strength ${strengthLabel} — need Strong Bull or Strong Bear`;
    else if (!matchOk) why = `Acts ${act} — need Match`;
    else if (!spotOk) why = 'Spot not with flow on this 3m bar';
    return {
      ...base,
      status: 'WATCHING',
      checks,
      detail: `${strengthLabel} · ${act} · ${bias}`,
      why,
      headline: `${strengthLabel} · ${act}`,
    };
  }

  const optionType = strengthLabel === 'Strong Bull' ? 'CE' : 'PE';
  return {
    ...base,
    status: 'TAKE_ENTRY',
    buyLive: true,
    optionType,
    entryStrike: atm,
    levelStrike: atm,
    patternId: strengthLabel === 'Strong Bull' ? 'match_strong_bull' : 'match_strong_bear',
    patternName: `${strengthLabel} + Match`,
    checks,
    detail: `${strengthLabel} Match → ${optionType} ATM ${atm ?? '—'} · 3m ${flowTime || ''}`,
    why: `Closed 3m ${strengthLabel} + Match + spot with flow · buy ATM ${optionType} · +${optionTpPts}/−${optionSlPts}`,
    headline: optionType === 'CE' ? `Buy CE · ${atm ?? '—'}` : `Buy PE · ${atm ?? '—'}`,
    entrySpot: Number.isFinite(spotNow) ? spotNow : null,
  };
}

module.exports = {
  buildSignalFromOiFlow,
  atmStrike,
  latestClosed3mBar,
  STEP_3M,
};

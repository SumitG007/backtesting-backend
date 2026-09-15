/**
 * Flow Scalp E/B — live / forming OI Flow Bias (not closed 15m E/B).
 * Bull → ATM CE · Bear → ATM PE · Neutral → wait.
 * Engine adds green 1m strike candle before fill · +2/−3.
 */
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

function biasFromRow(row) {
  if (!row) return { bias: null, chngInDir: null };
  let bias = String(row.sentiment || '').trim();
  const chng = Number(row.chngInDir);
  if (bias !== 'Bull' && bias !== 'Bear' && bias !== 'Neutral') {
    if (!Number.isFinite(chng) || chng === 0) bias = 'Neutral';
    else bias = chng > 0 ? 'Bull' : 'Bear';
  }
  return { bias, chngInDir: Number.isFinite(chng) ? chng : null };
}

/**
 * Latest forming / display OI Flow row Bias → side.
 * @param {object} tape — oiFlow listTodayRows payload
 * @param {object} settings
 */
function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const displayRow = tape?.displayRow || null;
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const latest =
    displayRow
    || rows.find((r) => r && r.fetchOk !== false)
    || rows[0]
    || null;

  const optionSlPts = Math.max(1, Number(settings.optionSlPts) || 3);
  const optionTpPts = Math.max(1, Number(settings.optionTpPts) || 2);

  const spotNow = Number(latest?.spotPrice ?? latest?.spot);
  const atm = Number(latest?.atm) || atmStrike(spotNow);
  const { bias, chngInDir } = biasFromRow(latest);
  const flowTime = latest?.time || null;
  const flowMinutes = Number.isFinite(Number(latest?.minutes)) ? Number(latest.minutes) : null;

  const base = {
    status: 'WATCHING',
    buyLive: false,
    optionType: null,
    entryStrike: atm,
    levelStrike: atm,
    spot: Number.isFinite(spotNow) ? round(spotNow, 1) : null,
    atm: Number.isFinite(atm) ? atm : null,
    flowBias: bias,
    chngInDir,
    flowTime,
    barTime: flowTime,
    barMinutes: flowMinutes,
    strength: null,
    spotDelta: Number.isFinite(Number(latest?.spotDelta)) ? Number(latest.spotDelta) : null,
    act: latest?.act || null,
    patternId: bias ? `live_bias_${String(bias).toLowerCase()}` : null,
    patternName: bias ? `Live Bias ${bias}` : null,
    riskPts: optionSlPts,
    rewardPts: optionTpPts,
    dayPts: Number.isFinite(Number(opts.dayPts)) ? Number(opts.dayPts) : 0,
    dayLocked: Boolean(opts.dayLocked),
    checks: [],
    detail: 'Waiting for live OI Flow Bias',
    why: 'Need Bias Bull (CE) or Bear (PE) on the forming / latest flow tape',
    headline: null,
    rules: {
      optionSlPts,
      optionTpPts,
      mode: 'live_bias',
    },
  };

  if (!latest) {
    return {
      ...base,
      status: 'WAIT',
      detail: 'No OI Flow row yet',
      why: 'Waiting for OI Flow Tracker minute tape',
      headline: 'Waiting flow',
      checks: [
        {
          id: 'flow',
          name: 'OI Flow Bias',
          short: 'Bias',
          ok: false,
          value: '—',
          need: 'Bull or Bear',
          note: 'No row',
        },
      ],
    };
  }

  const biasOk = bias === 'Bull' || bias === 'Bear';
  const checks = [
    {
      id: 'flow',
      name: 'OI Flow Bias (now)',
      short: 'Bias',
      ok: biasOk,
      value: bias || '—',
      need: 'Bull → CE · Bear → PE',
      note: flowTime ? `As of ${flowTime}` : 'Latest / forming tape',
    },
    {
      id: 'atm',
      name: 'ATM strike',
      short: 'ATM',
      ok: Number.isFinite(atm),
      value: Number.isFinite(atm) ? String(atm) : '—',
      need: 'Valid ATM',
      note: Number.isFinite(spotNow) ? `Spot ${round(spotNow, 1)}` : '—',
    },
  ];

  if (!biasOk) {
    return {
      ...base,
      status: 'WATCHING',
      checks,
      detail: `Bias ${bias || 'Neutral'} · no side`,
      why: 'Neutral / missing Bias — wait for Bull or Bear on the live tape',
      headline: `Bias ${bias || '—'} · wait`,
    };
  }

  const optionType = bias === 'Bull' ? 'CE' : 'PE';
  return {
    ...base,
    status: 'TAKE_ENTRY',
    buyLive: true,
    optionType,
    entryStrike: atm,
    levelStrike: atm,
    checks,
    detail: `Live Bias ${bias} → ${optionType} ATM ${atm ?? '—'}`,
    why: `Flow now ${bias} · buy ATM ${optionType} · +${optionTpPts}/−${optionSlPts} (needs green candle)`,
    headline: bias === 'Bull' ? `Buy CE · ${atm ?? '—'}` : `Buy PE · ${atm ?? '—'}`,
    entrySpot: Number.isFinite(spotNow) ? spotNow : null,
  };
}

module.exports = {
  buildSignalFromOiFlow,
  atmStrike,
  biasFromRow,
};

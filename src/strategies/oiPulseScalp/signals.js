/**
 * OI Pulse Scalp (OPS-3) — closed 5m bars.
 * 3-point entry on signal bar close (no next-bar wait):
 *  1) Activity recipe  2) Strong flow Match + ΔPCR  3) Spot Δ confirms
 * Risk: +targetPts / −stopPts on Nifty · time-stop N bars · streak 1..maxStreak
 * Session: tradeFrom..tradeTo · no daily trade cap · recipe must reset before re-entry
 */
const { build5mBars } = require('../../utils/oiFlow5mPatterns');
const { round } = require('../../utils/oiFlowPlaybook');

const STEP_DEFAULT = 5;
const TARGET_PTS = 3;
const STOP_PTS = 6;
const TIME_STOP_BARS = 2;
const MAX_STREAK = 3;
const ENTRY_FROM_MIN = 9 * 60 + 45; // 09:45
const ENTRY_TO_MIN = 14 * 60; // no new entries from 14:00

function niftyStep() {
  return 50;
}

function atmStrike(spot) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  const step = niftyStep();
  return Math.round(s / step) * step;
}

function recipeKey(callAct, putAct) {
  return `${callAct || '—'}|${putAct || '—'}`;
}

function isBuyRecipe(bar) {
  return bar?.callAct === 'Short cover' && bar?.putAct === 'Writing';
}

function isSellRecipe(bar) {
  return (
    bar?.callAct === 'Writing'
    && (bar?.putAct === 'Buying' || bar?.putAct === 'Short cover')
  );
}

function isBuySetup(bar, maxStreak) {
  const streak = Number(bar?.streak) || 0;
  return (
    isBuyRecipe(bar)
    && bar?.flowBias === 'Bull'
    && bar?.strength?.label === 'Strong Bull'
    && bar?.act === 'Match'
    && Number.isFinite(Number(bar.deltaPcr))
    && Number(bar.deltaPcr) >= 0
    && Number(bar.spotDelta) > 0
    && streak >= 1
    && streak <= maxStreak
  );
}

function isSellSetup(bar, maxStreak) {
  const streak = Number(bar?.streak) || 0;
  return (
    isSellRecipe(bar)
    && bar?.flowBias === 'Bear'
    && bar?.strength?.label === 'Strong Bear'
    && bar?.act === 'Match'
    && Number.isFinite(Number(bar.deltaPcr))
    && Number(bar.deltaPcr) <= 0
    && Number(bar.spotDelta) < 0
    && streak >= 1
    && streak <= maxStreak
  );
}

function levelsFromEntry(side, entrySpot, targetPts, stopPts) {
  const entry = Number(entrySpot);
  const tp = Math.max(0.5, Number(targetPts) || TARGET_PTS);
  const sl = Math.max(0.5, Number(stopPts) || STOP_PTS);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return {
    entrySpot: round(entry, 1),
    stopSpot: round(side === 'CALL' ? entry - sl : entry + sl, 1),
    targetSpot: round(side === 'CALL' ? entry + tp : entry - tp, 1),
    riskPts: round(sl, 1),
    rewardPts: round(tp, 1),
  };
}

/**
 * @param {object} tape
 * @param {object} settings
 * @param {{ lastEntryBarMinutes?: number|null, lastRecipeKey?: string|null }} opts
 */
function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const displayRow = tape?.displayRow || null;
  const step = Math.max(5, Math.floor(Number(settings.stepMin) || STEP_DEFAULT));
  const targetPts = Math.max(0.5, Number(settings.targetPts) || TARGET_PTS);
  const stopPts = Math.max(0.5, Number(settings.stopPts) || STOP_PTS);
  const timeStopBars = Math.max(1, Math.floor(Number(settings.timeStopBars) || TIME_STOP_BARS));
  const maxStreak = Math.max(1, Math.floor(Number(settings.maxStreak) || MAX_STREAK));
  const fromMin = ENTRY_FROM_MIN;
  const toMin = ENTRY_TO_MIN;

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
    recipeKey: null,
    clearRecipe: false,
    checks: [],
    detail: 'Waiting for OPS-3 5m scalp setup',
    why: 'Need recipe + Strong Match + Spot Δ confirm · streak 1–3 · 09:45–14:00',
    headline: null,
    rules: {
      stepMin: step,
      targetPts,
      stopPts,
      timeStopBars,
      maxStreak,
      tradeFrom: '09:45',
      tradeTo: '14:00',
    },
  };

  const raw = rows
    .filter((r) => r && r.fetchOk !== false)
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));
  if (!raw.length) {
    return { ...base, detail: 'No OI Flow tape yet', why: 'Waiting for minute captures' };
  }

  const bars = build5mBars(raw, step);
  if (!bars.length) {
    return { ...base, detail: 'No closed 5m bars yet', why: 'Need a completed 5m interval' };
  }

  const lastClosed = bars[bars.length - 1];
  const rk = recipeKey(lastClosed.callAct, lastClosed.putAct);
  let lastRecipe = opts.lastRecipeKey || null;
  let clearRecipe = false;
  if (lastRecipe && rk !== lastRecipe) {
    clearRecipe = true;
    lastRecipe = null;
  }

  const buy = isBuySetup(lastClosed, maxStreak);
  const sell = isSellSetup(lastClosed, maxStreak);
  const inSession =
    Number(lastClosed.minutes) >= fromMin && Number(lastClosed.minutes) < toMin;

  const checks = [
    {
      id: 'recipe',
      name: 'Activity recipe',
      short: 'Act',
      ok: isBuyRecipe(lastClosed) || isSellRecipe(lastClosed),
      value: `${lastClosed.callAct || '—'} / ${lastClosed.putAct || '—'}`,
      need: 'SC+Writing / Writing+Buy|SC',
      note: 'Call + Put act pair',
    },
    {
      id: 'flow',
      name: 'Strong flow Match',
      short: 'Flow',
      ok:
        (lastClosed.strength?.label === 'Strong Bull' || lastClosed.strength?.label === 'Strong Bear')
        && lastClosed.act === 'Match',
      value: `${lastClosed.strength?.label || '—'} · ${lastClosed.act || '—'}`,
      need: 'Strong + Match',
      note: 'Bias must be Strong',
    },
    {
      id: 'pcr',
      name: 'ΔPCR',
      short: 'ΔPCR',
      ok:
        (buy && Number(lastClosed.deltaPcr) >= 0)
        || (sell && Number(lastClosed.deltaPcr) <= 0)
        || (
          !buy
          && !sell
          && Number.isFinite(Number(lastClosed.deltaPcr))
        ),
      value: Number.isFinite(Number(lastClosed.deltaPcr))
        ? String(round(lastClosed.deltaPcr, 4))
        : '—',
      need: 'BUY ≥0 · SELL ≤0',
      note: 'Must not fight',
    },
    {
      id: 'spot',
      name: 'Spot Δ confirm',
      short: 'Spot',
      ok:
        (buy && Number(lastClosed.spotDelta) > 0)
        || (sell && Number(lastClosed.spotDelta) < 0)
        || Number.isFinite(Number(lastClosed.spotDelta)),
      value: Number.isFinite(Number(lastClosed.spotDelta))
        ? String(round(lastClosed.spotDelta, 1))
        : '—',
      need: 'BUY >0 · SELL <0',
      note: 'Same-bar price confirm',
    },
    {
      id: 'streak',
      name: 'Streak',
      short: 'Stk',
      ok: Number(lastClosed.streak) >= 1 && Number(lastClosed.streak) <= maxStreak,
      value: lastClosed.streak != null
        ? `${lastClosed.streak}${lastClosed.flowBias === 'Bull' ? 'B' : lastClosed.flowBias === 'Bear' ? 'Be' : ''}`
        : '—',
      need: `1–${maxStreak}`,
      note: 'Skip late chase',
    },
  ];

  const sharedMeta = {
    clearRecipe,
    strength: lastClosed.strength?.label,
    flowBias: lastClosed.flowBias,
    streak: lastClosed.streak,
    deltaPcr: round(lastClosed.deltaPcr, 4),
    spotDelta: round(lastClosed.spotDelta),
    act: lastClosed.act,
    callAct: lastClosed.callAct,
    putAct: lastClosed.putAct,
    recipeKey: rk,
    barTime: lastClosed.time,
    barMinutes: lastClosed.minutes,
    checks,
  };

  if (!inSession) {
    return {
      ...base,
      ...sharedMeta,
      status: 'WATCHING',
      detail: `Outside entry window · last 5m ${lastClosed.time}`,
      why: 'Entries only 09:45 → before 14:00',
    };
  }

  if (
    (buy || sell)
    && Number.isFinite(Number(opts.lastEntryBarMinutes))
    && Number(opts.lastEntryBarMinutes) === Number(lastClosed.minutes)
  ) {
    return {
      ...base,
      ...sharedMeta,
      status: 'WATCHING',
      detail: `Already entered on ${lastClosed.time}`,
      why: 'One entry per signal bar',
    };
  }

  if ((buy || sell) && lastRecipe && lastRecipe === rk) {
    return {
      ...base,
      ...sharedMeta,
      status: 'WATCHING',
      detail: `Recipe still running · ${rk}`,
      why: 'Wait until Call/Put act pair changes before re-entry',
    };
  }

  if (buy || sell) {
    const side = buy ? 'CALL' : 'PUT';
    const lv = levelsFromEntry(side, lastClosed.spot, targetPts, stopPts);
    if (!lv) {
      return {
        ...base,
        ...sharedMeta,
        status: 'WATCHING',
        detail: 'Invalid entry spot',
        why: 'Need a valid bar close spot',
      };
    }
    const optionType = buy ? 'CE' : 'PE';
    const entryAtm = atmStrike(lv.entrySpot) || atm;
    return {
      ...base,
      ...sharedMeta,
      status: 'TAKE_ENTRY',
      buyLive: true,
      optionType,
      entryStrike: entryAtm,
      levelStrike: entryAtm,
      patternId: buy ? 'OPS3_B' : 'OPS3_S',
      patternName: buy
        ? 'OPS-3 BUY · SC+Writing · Strong Bull'
        : 'OPS-3 SELL · Writing+Buy/SC · Strong Bear',
      stopSpot: lv.stopSpot,
      targetSpot: lv.targetSpot,
      riskPts: lv.riskPts,
      rewardPts: lv.rewardPts,
      entrySpotPlan: lv.entrySpot,
      checks: checks.map((c) => ({ ...c, ok: true })),
      detail: `${optionType} ${entryAtm} @ ${lastClosed.time} · +${targetPts}/−${stopPts}`,
      why: `Enter at bar close · time-stop ${timeStopBars} bars · recipe ${rk}`,
      headline: buy ? 'BUY scalp' : 'SELL scalp',
    };
  }

  return {
    ...base,
    ...sharedMeta,
    status: 'WATCHING',
    detail: `Last 5m ${lastClosed.time} · no OPS-3 setup`,
    why: 'Need all 3 points on this closed bar',
    headline: null,
  };
}

module.exports = {
  buildSignalFromOiFlow,
  isBuySetup,
  isSellSetup,
  isBuyRecipe,
  isSellRecipe,
  levelsFromEntry,
  recipeKey,
  STEP_DEFAULT,
  TARGET_PTS,
  STOP_PTS,
  TIME_STOP_BARS,
  MAX_STREAK,
};

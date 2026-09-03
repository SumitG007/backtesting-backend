/**
 * One-off: analyze today's OI Flow 5-min closed bars for lead→next patterns.
 * Does not print secrets. Run from backend: node scripts/analyzeOiFlow5mScenarios.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const OiFlowMinuteRow = require('../src/models/oiFlowMinuteRow');
const { getIstClock } = require('../src/utils/dateTime');
const { intervalOiFromRows } = require('../src/utils/oiFlowIntervalOi');

// Minimal act / strength helpers (mirrors OI Flow Tracker page).
function classifyCallAct(priceUp, oiChg) {
  if (!Number.isFinite(oiChg) || oiChg === 0 || priceUp == null) return { label: '—', tone: 'flat' };
  if (priceUp && oiChg > 0) return { label: 'Long build', tone: 'bull' };
  if (!priceUp && oiChg > 0) return { label: 'Writing', tone: 'bear' };
  if (priceUp && oiChg < 0) return { label: 'Short cover', tone: 'bull' };
  return { label: 'Long unwind', tone: 'bear' };
}
function classifyPutAct(priceUp, oiChg) {
  if (!Number.isFinite(oiChg) || oiChg === 0 || priceUp == null) return { label: '—', tone: 'flat' };
  if (priceUp && oiChg > 0) return { label: 'Writing', tone: 'bull' };
  if (!priceUp && oiChg > 0) return { label: 'Buying', tone: 'bear' };
  if (priceUp && oiChg < 0) return { label: 'Long unwind', tone: 'bull' };
  return { label: 'Short cover', tone: 'bear' };
}
function actMatch(callTone, putTone) {
  if (!callTone || !putTone || callTone === 'flat' || putTone === 'flat') return { text: '—', tone: 'flat' };
  if (callTone === putTone) return { text: 'Match', tone: callTone };
  return { text: 'Fight', tone: 'warn' };
}
function flowStrength({ flowBias, spotDelta, chngInDir, oiVelocity, streak, deltaPcr, actMatch: am, oiMigration, intervalMin }) {
  if (flowBias !== 'Bull' && flowBias !== 'Bear') return { label: 'Neutral', tone: 'flat', score: 0 };
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
  if (Number.isFinite(Math.abs(Number(chngInDir))) && Math.abs(Number(chngInDir)) >= magFloor) pts += 1;
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
  if (am?.text === 'Match') pts += 1;
  else if (am?.text === 'Fight') pts -= 0.5;
  max += 1;
  if ((bull && oiMigration === 'up') || (!bull && oiMigration === 'down')) pts += 1;
  const ratio = max > 0 ? pts / max : 0;
  const strong = ratio >= 0.65;
  return {
    label: strong ? (bull ? 'Strong Bull' : 'Strong Bear') : bull ? 'Bull' : 'Bear',
    tone: bull ? 'bull' : 'bear',
    score: Math.round(ratio * 100),
  };
}

function matchesInterval(minutes, step) {
  const SESSION_FROM = 9 * 60 + 15;
  if (step === 1) return true;
  if (!Number.isFinite(minutes) || minutes < SESSION_FROM) return false;
  return (minutes - SESSION_FROM) % step === 0;
}

function build5m(rows, step = 5) {
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
    if (!prev) continue; // skip session open
    const interval = intervalOiFromRows(row, prev);
    const callsChgOi = interval.callsChgOi;
    const putsChgOi = interval.putsChgOi;
    const chngInDir =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi) ? putsChgOi - callsChgOi : null;
    const spotNow = Number(row.spotPrice);
    const spotPrev = Number(prev.spotPrice);
    const spotDelta =
      Number.isFinite(spotNow) && Number.isFinite(spotPrev) ? spotNow - spotPrev : null;
    const priceUp =
      Number.isFinite(spotDelta) ? (spotDelta > 0 ? true : spotDelta < 0 ? false : null) : null;
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
      Number.isFinite(prevCall) && prevCall > 0 && Number.isFinite(prevPut) ? prevPut / prevCall : null;
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
      spot: spotNow,
      spotDelta,
      callsChgOi,
      putsChgOi,
      chngInDir,
      flowBias,
      callAct: callAct.label,
      putAct: putAct.label,
      act: am.text,
      pcr,
      deltaPcr,
      oiVelocity,
      oiMigration: row.oiMigration || null,
      dominantStrike: row.dominantStrike ?? null,
      streak: 0,
      strength: null,
    });
  }
  for (let i = 0; i < enriched.length; i += 1) {
    const cur = enriched[i];
    const prev = i > 0 ? enriched[i - 1] : null;
    if (cur.flowBias !== 'Bull' && cur.flowBias !== 'Bear') {
      cur.streak = 0;
    } else if (prev && prev.flowBias === cur.flowBias) {
      cur.streak = (prev.streak || 1) + 1;
    } else {
      cur.streak = 1;
    }
    cur.strength = flowStrength({
      flowBias: cur.flowBias,
      spotDelta: cur.spotDelta,
      chngInDir: cur.chngInDir,
      oiVelocity: cur.oiVelocity,
      streak: cur.streak,
      deltaPcr: cur.deltaPcr,
      actMatch: { text: cur.act },
      oiMigration: cur.oiMigration,
      intervalMin: step,
    });
  }
  return enriched;
}

function spotBucket(d) {
  if (!Number.isFinite(d) || d === 0) return 'flat';
  if (d > 0) return d >= 10 ? 'up10+' : 'up';
  return d <= -10 ? 'down10+' : 'down';
}

function nextOutcome(next) {
  if (!next) return null;
  const spot = spotBucket(next.spotDelta);
  const str = next.strength?.label || next.flowBias;
  return { spot, strength: str, flowBias: next.flowBias, act: next.act };
}

function countMap(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI missing — cannot load today tape.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const dateKey = process.argv[2] || getIstClock(new Date()).dateKey;
  const rows = await OiFlowMinuteRow.find({
    symbol: 'NIFTY',
    dateKey,
    fetchOk: true,
  })
    .sort({ minutes: 1 })
    .select({
      minutes: 1,
      time: 1,
      spotPrice: 1,
      dayCallChgOi: 1,
      dayPutChgOi: 1,
      callsChgOi: 1,
      putsChgOi: 1,
      callOiTotal: 1,
      putOiTotal: 1,
      strikes: 1,
      oiMigration: 1,
      dominantStrike: 1,
      fetchOk: 1,
    })
    .lean();

  console.log(`dateKey=${dateKey} rawMinutes=${rows.length}`);
  const bars = build5m(rows, 5);
  console.log(`closed5mBars=${bars.length} (excl. session-open print)\n`);

  // Print tape summary
  console.log('=== 5m closed bars ===');
  for (const b of bars) {
    const sd = Number.isFinite(b.spotDelta) ? (b.spotDelta > 0 ? '+' : '') + b.spotDelta.toFixed(1) : '—';
    console.log(
      `${b.time}  spotΔ=${sd.padStart(7)}  bias=${(b.flowBias || '').padEnd(7)}  str=${(b.strength?.label || '').padEnd(11)}  act=${(b.act || '').padEnd(5)}  CE=${b.callAct} PE=${b.putAct}  mig=${b.oiMigration || '—'}`,
    );
  }

  // Scenario: given THIS bar traits → what next bar does
  const pairs = [];
  for (let i = 0; i < bars.length - 1; i += 1) {
    const cur = bars[i];
    const next = bars[i + 1];
    pairs.push({ cur, next, outcome: nextOutcome(next) });
  }

  const scenarios = [
    {
      name: 'Strong Bull + Spot↑',
      test: (b) => b.strength?.label === 'Strong Bull' && Number(b.spotDelta) > 0,
    },
    {
      name: 'Strong Bear + Spot↓',
      test: (b) => b.strength?.label === 'Strong Bear' && Number(b.spotDelta) < 0,
    },
    {
      name: 'Strong Bull + Spot↓ (divergence)',
      test: (b) => b.strength?.label === 'Strong Bull' && Number(b.spotDelta) < 0,
    },
    {
      name: 'Strong Bear + Spot↑ (divergence)',
      test: (b) => b.strength?.label === 'Strong Bear' && Number(b.spotDelta) > 0,
    },
    {
      name: 'Bull + Spot↑ + Act Match',
      test: (b) => b.flowBias === 'Bull' && Number(b.spotDelta) > 0 && b.act === 'Match',
    },
    {
      name: 'Bear + Spot↓ + Act Match',
      test: (b) => b.flowBias === 'Bear' && Number(b.spotDelta) < 0 && b.act === 'Match',
    },
    {
      name: 'Bull + Spot↑',
      test: (b) => b.flowBias === 'Bull' && Number(b.spotDelta) > 0,
    },
    {
      name: 'Bear + Spot↓',
      test: (b) => b.flowBias === 'Bear' && Number(b.spotDelta) < 0,
    },
    {
      name: 'Act Fight',
      test: (b) => b.act === 'Fight',
    },
    {
      name: 'Streak ≥ 3 Bull',
      test: (b) => b.flowBias === 'Bull' && b.streak >= 3,
    },
    {
      name: 'Streak ≥ 3 Bear',
      test: (b) => b.flowBias === 'Bear' && b.streak >= 3,
    },
    {
      name: 'SpotΔ ≥ +10',
      test: (b) => Number(b.spotDelta) >= 10,
    },
    {
      name: 'SpotΔ ≤ −10',
      test: (b) => Number(b.spotDelta) <= -10,
    },
  ];

  console.log('\n=== Lead bar → next 5m outcome (need n≥3 to claim pattern) ===');
  const hits = [];
  for (const sc of scenarios) {
    const matched = pairs.filter((p) => sc.test(p.cur));
    const n = matched.length;
    if (n === 0) continue;
    const nextSpot = countMap(matched.map((p) => p.outcome.spot));
    const nextStr = countMap(matched.map((p) => p.outcome.strength));
    const nextBias = countMap(matched.map((p) => p.outcome.flowBias));
    const topSpot = nextSpot[0];
    const topBias = nextBias[0];
    const spotPct = topSpot ? Math.round((100 * topSpot[1]) / n) : 0;
    const biasPct = topBias ? Math.round((100 * topBias[1]) / n) : 0;
    const line = {
      name: sc.name,
      n,
      nextSpotDominant: topSpot ? `${topSpot[0]} ${spotPct}%` : '—',
      nextBiasDominant: topBias ? `${topBias[0]} ${biasPct}%` : '—',
      nextStrengthTop: nextStr
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(', '),
      strongClaim: n >= 3 && (spotPct >= 70 || biasPct >= 70),
    };
    hits.push(line);
    console.log(
      `\n[${sc.name}] n=${n}` +
        `\n  next SpotΔ bucket: ${nextSpot.map(([k, v]) => `${k}=${v}(${Math.round((100 * v) / n)}%)`).join(' · ')}` +
        `\n  next Flow Bias:    ${nextBias.map(([k, v]) => `${k}=${v}(${Math.round((100 * v) / n)}%)`).join(' · ')}` +
        `\n  next Strength:     ${line.nextStrengthTop}` +
        (line.strongClaim ? '\n  ★ notable (≥70% with n≥3)' : ''),
    );
  }

  const notable = hits.filter((h) => h.strongClaim).sort((a, b) => b.n - a.n);
  console.log('\n=== Notable scenarios today (≥70% next-bar agreement, n≥3) ===');
  if (!notable.length) {
    console.log('None reached a stable ~70–90% claim on this sample alone.');
  } else {
    for (const h of notable) {
      console.log(`- ${h.name}: n=${h.n} → next Spot ${h.nextSpotDominant}, next Bias ${h.nextBiasDominant}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

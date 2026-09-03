/**
 * Build CALL/PUT buy patterns from today's 5m OI Flow closed bars,
 * then measure forward spot-point P&L after each signal.
 *
 * node scripts/analyzeOiFlow5mPatternsPnL.js [dateKey]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const OiFlowMinuteRow = require('../src/models/oiFlowMinuteRow');
const { getIstClock } = require('../src/utils/dateTime');
const { intervalOiFromRows } = require('../src/utils/oiFlowIntervalOi');

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
function flowStrength({ flowBias, spotDelta, chngInDir, oiVelocity, streak, deltaPcr, act, oiMigration, intervalMin }) {
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
  if (act === 'Match') pts += 1;
  else if (act === 'Fight') pts -= 0.5;
  max += 1;
  if ((bull && oiMigration === 'up') || (!bull && oiMigration === 'down')) pts += 1;
  const ratio = max > 0 ? pts / max : 0;
  return {
    label: ratio >= 0.65 ? (bull ? 'Strong Bull' : 'Strong Bear') : bull ? 'Bull' : 'Bear',
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

/** Candidate signal definitions — evaluated after a 5m bar closes. */
const PATTERNS = [
  {
    id: 'A',
    side: 'CALL',
    name: 'Strong Bull + Spot↑ + Match',
    test: (b) =>
      b.strength?.label === 'Strong Bull'
      && Number(b.spotDelta) > 0
      && b.act === 'Match',
  },
  {
    id: 'B',
    side: 'PUT',
    name: 'Strong Bear + Spot↓ + Match',
    test: (b) =>
      b.strength?.label === 'Strong Bear'
      && Number(b.spotDelta) < 0
      && b.act === 'Match',
  },
  {
    id: 'C',
    side: 'CALL',
    name: 'Strong Bull + Spot↑ + streak≥2',
    test: (b) =>
      b.strength?.label === 'Strong Bull'
      && Number(b.spotDelta) > 0
      && b.streak >= 2,
  },
  {
    id: 'D',
    side: 'PUT',
    name: 'Strong Bear + Spot↓ + streak≥2',
    test: (b) =>
      b.strength?.label === 'Strong Bear'
      && Number(b.spotDelta) < 0
      && b.streak >= 2,
  },
  {
    id: 'E',
    side: 'CALL',
    name: 'Strong Bull + Spot↑≥5 + Match',
    test: (b) =>
      b.strength?.label === 'Strong Bull'
      && Number(b.spotDelta) >= 5
      && b.act === 'Match',
  },
  {
    id: 'F',
    side: 'PUT',
    name: 'Strong Bear + Spot↓≤−5 + Match',
    test: (b) =>
      b.strength?.label === 'Strong Bear'
      && Number(b.spotDelta) <= -5
      && b.act === 'Match',
  },
  {
    id: 'G',
    side: 'CALL',
    name: 'Bull streak≥3 + Spot↑ + Match',
    test: (b) =>
      b.flowBias === 'Bull'
      && b.streak >= 3
      && Number(b.spotDelta) > 0
      && b.act === 'Match',
  },
  {
    id: 'H',
    side: 'PUT',
    name: 'Bear streak≥3 + Spot↓ + Match',
    test: (b) =>
      b.flowBias === 'Bear'
      && b.streak >= 3
      && Number(b.spotDelta) < 0
      && b.act === 'Match',
  },
  {
    id: 'I',
    side: 'CALL',
    name: 'Strong Bull only (ignore spot)',
    test: (b) => b.strength?.label === 'Strong Bull' && b.act === 'Match',
  },
  {
    id: 'J',
    side: 'PUT',
    name: 'Strong Bear only (ignore spot)',
    test: (b) => b.strength?.label === 'Strong Bear' && b.act === 'Match',
  },
];

/**
 * Entry at close of signal bar (spot). Exit after holdBars subsequent 5m closes.
 * CALL profit = nextSpot - entrySpot; PUT = entrySpot - nextSpot.
 * Also report 1-bar and 3-bar holds.
 */
function evaluatePattern(bars, pattern, { cooldownBars = 1 } = {}) {
  const trades = [];
  let cooldownUntil = -1;
  for (let i = 0; i < bars.length - 1; i += 1) {
    if (i < cooldownUntil) continue;
    const bar = bars[i];
    if (!pattern.test(bar)) continue;
    const entrySpot = Number(bar.spot);
    if (!Number.isFinite(entrySpot)) continue;

    const holdDefs = [
      { label: 'next1', hold: 1 },
      { label: 'next3', hold: 3 },
      { label: 'next6', hold: 6 }, // ~30 min
    ];
    const results = {};
    for (const h of holdDefs) {
      const exitIdx = Math.min(i + h.hold, bars.length - 1);
      const exitSpot = Number(bars[exitIdx].spot);
      if (!Number.isFinite(exitSpot)) continue;
      const raw = exitSpot - entrySpot;
      const pts = pattern.side === 'CALL' ? raw : -raw;
      results[h.label] = {
        pts: Number(pts.toFixed(1)),
        exitTime: bars[exitIdx].time,
        barsHeld: exitIdx - i,
      };
    }
    trades.push({
      time: bar.time,
      side: pattern.side,
      entrySpot,
      spotDelta: bar.spotDelta,
      strength: bar.strength?.label,
      streak: bar.streak,
      act: bar.act,
      ...results,
    });
    cooldownUntil = i + cooldownBars;
  }
  return trades;
}

function summarize(trades, key) {
  const rows = trades.filter((t) => t[key]);
  if (!rows.length) return null;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let sum = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let best = -Infinity;
  let worst = Infinity;
  for (const t of rows) {
    const p = t[key].pts;
    sum += p;
    best = Math.max(best, p);
    worst = Math.min(worst, p);
    if (p > 0.5) {
      wins += 1;
      sumWin += p;
    } else if (p < -0.5) {
      losses += 1;
      sumLoss += p;
    } else flat += 1;
  }
  const n = rows.length;
  return {
    n,
    wins,
    losses,
    flat,
    winRate: Math.round((100 * wins) / n),
    totalPts: Number(sum.toFixed(1)),
    avgPts: Number((sum / n).toFixed(1)),
    avgWin: wins ? Number((sumWin / wins).toFixed(1)) : 0,
    avgLoss: losses ? Number((sumLoss / losses).toFixed(1)) : 0,
    best: Number(best.toFixed(1)),
    worst: Number(worst.toFixed(1)),
  };
}

function fmtSum(s) {
  if (!s) return 'no trades';
  return `n=${s.n}  WR=${s.winRate}%  total=${s.totalPts > 0 ? '+' : ''}${s.totalPts}pts  avg=${s.avgPts > 0 ? '+' : ''}${s.avgPts}  W/L=${s.wins}/${s.losses}  best=${s.best > 0 ? '+' : ''}${s.best} worst=${s.worst}`;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI missing');
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
      fetchOk: 1,
    })
    .lean();

  const bars = build5m(rows, 5);
  console.log(`dateKey=${dateKey}  5mBars=${bars.length}`);
  console.log('P&L = Spot points after signal (CALL=spot↑, PUT=spot↓). Not option premium.\n');

  const scoreboard = [];

  for (const pattern of PATTERNS) {
    const trades = evaluatePattern(bars, pattern, { cooldownBars: 1 });
    const s1 = summarize(trades, 'next1');
    const s3 = summarize(trades, 'next3');
    const s6 = summarize(trades, 'next6');
    console.log(`\n══ ${pattern.id}. ${pattern.side} BUY — ${pattern.name} ══`);
    console.log(`  next 1×5m (~5m):  ${fmtSum(s1)}`);
    console.log(`  next 3×5m (~15m): ${fmtSum(s3)}`);
    console.log(`  next 6×5m (~30m): ${fmtSum(s6)}`);
    if (trades.length) {
      console.log('  signals:');
      for (const t of trades) {
        const p1 = t.next1 ? `${t.next1.pts > 0 ? '+' : ''}${t.next1.pts}` : '—';
        const p3 = t.next3 ? `${t.next3.pts > 0 ? '+' : ''}${t.next3.pts}` : '—';
        console.log(
          `    ${t.time} ${t.side} @${t.entrySpot.toFixed(1)}  spotΔ=${Number(t.spotDelta).toFixed(1)}  ${t.strength}  →5m ${p1}  →15m ${p3}`,
        );
      }
    }
    scoreboard.push({
      id: pattern.id,
      side: pattern.side,
      name: pattern.name,
      n: s1?.n || 0,
      wr5: s1?.winRate ?? null,
      pts5: s1?.totalPts ?? 0,
      avg5: s1?.avgPts ?? 0,
      wr15: s3?.winRate ?? null,
      pts15: s3?.totalPts ?? 0,
      avg15: s3?.avgPts ?? 0,
      wr30: s6?.winRate ?? null,
      pts30: s6?.totalPts ?? 0,
    });
  }

  // Rank by 15m total points then win rate (need n>=3)
  const ranked = scoreboard
    .filter((r) => r.n >= 3)
    .sort((a, b) => b.pts15 - a.pts15 || b.wr15 - a.wr15);

  console.log('\n\n========== BEST PATTERNS TODAY (n≥3, ranked by ~15m total Spot pts) ==========');
  if (!ranked.length) {
    console.log('No pattern had ≥3 signals.');
  } else {
    for (const r of ranked) {
      console.log(
        `${r.id} ${r.side.padEnd(4)} ${r.name}` +
          `\n   signals=${r.n} | 5m: WR ${r.wr5}% total ${r.pts5 > 0 ? '+' : ''}${r.pts5} avg ${r.avg5 > 0 ? '+' : ''}${r.avg5}` +
          ` | 15m: WR ${r.wr15}% total ${r.pts15 > 0 ? '+' : ''}${r.pts15}` +
          ` | 30m: WR ${r.wr30}% total ${r.pts30 > 0 ? '+' : ''}${r.pts30}`,
      );
    }
  }

  const bestCall = ranked.find((r) => r.side === 'CALL');
  const bestPut = ranked.find((r) => r.side === 'PUT');
  console.log('\n----- Recommended today -----');
  console.log(
    bestCall
      ? `CALL BUY pattern: [${bestCall.id}] ${bestCall.name} — ${bestCall.n} signals, 15m total ${bestCall.pts15 > 0 ? '+' : ''}${bestCall.pts15} pts, WR ${bestCall.wr15}%`
      : 'CALL BUY: no pattern with n≥3',
  );
  console.log(
    bestPut
      ? `PUT BUY pattern:  [${bestPut.id}] ${bestPut.name} — ${bestPut.n} signals, 15m total ${bestPut.pts15 > 0 ? '+' : ''}${bestPut.pts15} pts, WR ${bestPut.wr15}%`
      : 'PUT BUY: no pattern with n≥3',
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

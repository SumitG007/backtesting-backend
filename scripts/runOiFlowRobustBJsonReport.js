/**
 * ROBUST B + 4-TF align from OI JSON tapes — walk-forward (current + past only).
 *
 * CALL BUY only if 15/5/3/1 all Bull.
 * PUT BUY only if 15/5/3/1 all Bear.
 *
 * Usage: node scripts/runOiFlowRobustBJsonReport.js
 */
const fs = require('fs');
const path = require('path');
const {
  decideRaw,
  normalizeRows,
  buildIndex,
} = require('../src/services/oiFlowSignalEngine');

const DATES = ['2026-08-12', '2026-08-13', '2026-08-14'];
const MIN_PUT_OI = 250000;
const MAX_PUT_OI = 3000000;
const HOLD_MIN = 15;
const COOLDOWN_MIN = 30;
const TARGET_PTS = 10;
const STOP_PTS = 8;
const PREMIUM_DELTA = 0.5;

function loadTape(dateKey) {
  const file = path.join(__dirname, '..', 'data', `oi-flow-${dateKey}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.rows || [];
  return { file: `data/oi-flow-${dateKey}.json`, rows: normalizeRows(list) };
}

function shortAct(act) {
  return String(act || '')
    .replace(/^Call /i, '')
    .replace(/^Put /i, '')
    .toLowerCase();
}

function oiQuality(callAct, putAct) {
  const c = shortAct(callAct) || '—';
  const p = shortAct(putAct) || '—';
  if (p === 'buying' && c === 'writing') {
    return { text: 'Call writing + Put buying = strong bearish confirmation', tone: 'bear' };
  }
  if (p === 'buying' && c === 'long unwind') {
    return { text: 'Call long unwind + Put buying = bearish confirmation', tone: 'bear' };
  }
  if (p === 'writing' && c === 'short cover') {
    return { text: 'Call short cover + Put writing = strong bullish confirmation', tone: 'bull' };
  }
  if (p === 'writing' && c === 'long build') {
    return { text: 'Call long build + Put writing = bullish / mixed', tone: 'bull' };
  }
  return { text: `Call ${c} + Put ${p}`, tone: 'flat' };
}

function fmtPts(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}`;
}

function fmtSpot(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function ctxUntil(allRows, tMinutes) {
  const sliced = allRows.filter((r) => r.minutes <= tMinutes);
  return { sliced, ctx: buildIndex(sliced) };
}

function simulateExit(rows, entryIdx, entrySpot, side) {
  const minutes = rows[entryIdx].minutes;
  for (let j = entryIdx + 1; j < rows.length; j += 1) {
    const later = rows[j];
    const held = later.minutes - minutes;
    const dSpot = Number(later.spot) - entrySpot;
    const pts = side === 'PE' ? -(dSpot * PREMIUM_DELTA) : dSpot * PREMIUM_DELTA;
    if (!Number.isFinite(pts)) continue;
    if (pts <= -STOP_PTS) {
      return {
        exitReason: 'SL',
        favorPts: -STOP_PTS,
        hold: held,
        exitTime: later.time,
        exitMinutes: later.minutes,
        grade: 'Bad',
      };
    }
    if (pts >= TARGET_PTS) {
      return {
        exitReason: 'TP',
        favorPts: TARGET_PTS,
        hold: held,
        exitTime: later.time,
        exitMinutes: later.minutes,
        grade: 'Excellent',
      };
    }
    if (held >= HOLD_MIN) {
      const favorPts = Number(pts.toFixed(1));
      return {
        exitReason: 'TIME',
        favorPts,
        hold: HOLD_MIN,
        exitTime: later.time,
        exitMinutes: later.minutes,
        grade: favorPts >= 0 ? 'Good' : 'Bad',
      };
    }
  }
  const last = rows[rows.length - 1];
  const held = last.minutes - minutes;
  const dSpot = Number(last.spot) - entrySpot;
  const pts = side === 'PE' ? -(dSpot * PREMIUM_DELTA) : dSpot * PREMIUM_DELTA;
  const favorPts = Number((Number.isFinite(pts) ? pts : 0).toFixed(1));
  return {
    exitReason: 'EOD',
    favorPts,
    hold: held,
    exitTime: last.time,
    exitMinutes: last.minutes,
    grade: favorPts >= 0 ? 'Good' : 'Bad',
  };
}

function runDay(dateKey) {
  const { file, rows } = loadTape(dateKey);
  const taken = [];
  let armed = true;
  let openUntil = null;
  let cooldownUntil = null;
  let lastEntryMin = null;

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const minutes = row.minutes;

    if (openUntil != null && minutes < openUntil) continue;
    if (openUntil != null && minutes >= openUntil) {
      cooldownUntil = openUntil + COOLDOWN_MIN;
      openUntil = null;
    }

    const { ctx } = ctxUntil(rows, minutes);
    const decision = decideRaw(ctx, minutes, {
      minPutOi: MIN_PUT_OI,
      maxPutOi: MAX_PUT_OI,
      requireSpotAlign: true,
      requireAllTfAlign: true,
      requireBbBand: false,
    });
    if (!decision) continue;

    if (decision.decision === 'WAIT') {
      armed = true;
      continue;
    }
    if (decision.decision !== 'PUT BUY' && decision.decision !== 'CALL BUY') continue;
    if (!armed) continue;
    if (cooldownUntil != null && minutes < cooldownUntil) continue;
    if (lastEntryMin != null && minutes <= lastEntryMin) continue;

    const spotNow = Number(row.spot);
    const strike = Number.isFinite(spotNow) ? Math.round(spotNow / 50) * 50 : null;
    const optionType = decision.decision === 'PUT BUY' ? 'PE' : 'CE';
    const quality = oiQuality(decision.callAct, decision.putAct);
    const tf15 = decision.tf15?.label || '—';
    const tf5 = decision.tf5?.label || '—';
    const tf3 = decision.tf3?.label || '—';
    const tf1 = decision.tf1?.label || '—';
    const allBear = decision.allBear === true;
    const control = decision.decision === 'PUT BUY' || allBear ? 'Sellers' : 'Buyers';
    const spotThen = lookbackFromCtx(ctx, minutes, 15);
    const spot15 =
      Number.isFinite(spotNow) && Number.isFinite(spotThen)
        ? Number((spotNow - spotThen).toFixed(1))
        : null;

    const exit = simulateExit(rows, i, spotNow, optionType);

    taken.push({
      time: decision.time,
      spot: spotNow,
      strikeLabel: strike ? `BUY NIFTY ${strike} ${optionType}` : null,
      tf15,
      tf5,
      tf3,
      tf1,
      callOiL: decision.callChgL,
      putOiL: decision.putChgL,
      quality: quality.text,
      control,
      candle: decision.candle || '—',
      bbZone: decision.bb?.zone || '—',
      bbLower: decision.bb?.lower,
      bbMid: decision.bb?.mid,
      bbUpper: decision.bb?.upper,
      bbPctB: decision.bb?.pctB,
      spot15,
      favorPts: exit.favorPts,
      hold: exit.hold,
      exitTime: exit.exitTime,
      exitReason: exit.exitReason,
      grade: exit.grade,
      decision: decision.decision,
      usedFutureForEntry: false,
    });

    lastEntryMin = minutes;
    openUntil = exit.exitMinutes;
    armed = false;
  }

  const excellent = taken.filter((s) => s.grade === 'Excellent').length;
  const good = taken.filter((s) => s.grade === 'Good').length;
  const bad = taken.filter((s) => s.grade === 'Bad').length;
  const favorSum = taken.reduce((a, s) => a + (Number(s.favorPts) || 0), 0);

  const fullCtx = buildIndex(rows);
  const funnel = { oiPe: 0, oiCe: 0, tfPe: 0, tfCe: 0, bbPe: 0, bbCe: 0 };
  for (const r of rows) {
    if (r.minutes < 570 || r.minutes > 870) continue;
    const d = decideRaw(fullCtx, r.minutes, {
      minPutOi: MIN_PUT_OI,
      maxPutOi: MAX_PUT_OI,
      requireSpotAlign: true,
      requireAllTfAlign: false,
      requireBbBand: false,
    });
    if (d?.decision === 'PUT BUY') funnel.oiPe += 1;
    if (d?.decision === 'CALL BUY') funnel.oiCe += 1;
    const dTf = decideRaw(fullCtx, r.minutes, {
      minPutOi: MIN_PUT_OI,
      maxPutOi: MAX_PUT_OI,
      requireSpotAlign: true,
      requireAllTfAlign: true,
      requireBbBand: false,
    });
    if (dTf?.decision === 'PUT BUY') funnel.tfPe += 1;
    if (dTf?.decision === 'CALL BUY') funnel.tfCe += 1;
    const dAll = decideRaw(fullCtx, r.minutes, {
      minPutOi: MIN_PUT_OI,
      maxPutOi: MAX_PUT_OI,
      requireSpotAlign: true,
      requireAllTfAlign: true,
      requireBbBand: true,
    });
    if (dAll?.decision === 'PUT BUY') funnel.bbPe += 1;
    if (dAll?.decision === 'CALL BUY') funnel.bbCe += 1;
  }

  return {
    dateKey,
    file,
    rowsUsed: rows.length,
    first: rows[0]?.time || null,
    last: rows[rows.length - 1]?.time || null,
    summary: {
      entries: taken.length,
      call: taken.filter((s) => s.decision === 'CALL BUY').length,
      put: taken.filter((s) => s.decision === 'PUT BUY').length,
      excellent,
      good,
      bad,
      hitRatePct:
        taken.length > 0
          ? Number((((excellent + good) / taken.length) * 100).toFixed(1))
          : null,
      sumFavorPts: Number(favorSum.toFixed(1)),
    },
    funnel,
    signals: taken,
  };
}

function lookbackFromCtx(ctx, minutes, ago) {
  const target = minutes - ago;
  if (ctx.byMin.has(target)) return Number(ctx.byMin.get(target).spot);
  for (let m = target; m >= target - 3; m -= 1) {
    if (m < minutes && ctx.byMin.has(m)) return Number(ctx.byMin.get(m).spot);
  }
  return null;
}

function printTable(report) {
  const lines = [];
  lines.push('');
  lines.push(`=== ${report.dateKey} · ${report.rowsUsed} bars ${report.first}–${report.last} ===`);
  lines.push(
    `Taken ${report.summary.entries} · CE ${report.summary.call} PE ${report.summary.put} · Ex ${report.summary.excellent} Good ${report.summary.good} Bad ${report.summary.bad} · hit ${report.summary.hitRatePct ?? '—'}% · Final pts ${report.summary.sumFavorPts}`,
  );
  if (report.funnel) {
    const f = report.funnel;
    lines.push(
      `Funnel bars: OI+candle PE/CE ${f.oiPe}/${f.oiCe} → +4TF ${f.tfPe}/${f.tfCe} → +BB ${f.bbPe}/${f.bbCe}`,
    );
  }
  lines.push(
    [
      'Time',
      'Spot',
      'Strike',
      '15M',
      '5M',
      '3M',
      '1M',
      'Call OI',
      'Put OI',
      'OI Quality',
      'Control',
      'Spot15',
      'Final pts',
      'Hold',
      'Exit time',
      'Exit',
      'Accuracy',
    ].join('\t'),
  );
  for (const s of report.signals) {
    lines.push(
      [
        s.time,
        fmtSpot(s.spot),
        s.strikeLabel,
        s.tf15,
        s.tf5,
        s.tf3,
        s.tf1,
        s.callOiL,
        s.putOiL,
        s.quality,
        s.control,
        fmtPts(s.spot15),
        fmtPts(s.favorPts),
        `${s.hold}m`,
        s.exitTime,
        s.exitReason,
        s.grade,
      ].join('\t'),
    );
  }
  return lines.join('\n');
}

function main() {
  const reports = DATES.map(runDay);
  const combined = {
    generatedAt: new Date().toISOString(),
    strategy: 'ROBUST B + 4 TF align (4 Bull=CE, 4 Bear=PE) + OI + candle',
    lookAhead: 'Entry uses current + past bars only. Exit TP/SL/TIME uses later spot as a 0.5x premium proxy (JSON has no option LTP).',
    days: reports,
    overall: reports.reduce(
      (acc, r) => {
        acc.entries += r.summary.entries;
        acc.call += r.summary.call;
        acc.put += r.summary.put;
        acc.excellent += r.summary.excellent;
        acc.good += r.summary.good;
        acc.bad += r.summary.bad;
        acc.sumFavorPts += r.summary.sumFavorPts;
        return acc;
      },
      { entries: 0, call: 0, put: 0, excellent: 0, good: 0, bad: 0, sumFavorPts: 0 },
    ),
  };
  combined.overall.sumFavorPts = Number(combined.overall.sumFavorPts.toFixed(1));
  combined.overall.hitRatePct =
    combined.overall.entries > 0
      ? Number(
          (
            ((combined.overall.excellent + combined.overall.good) / combined.overall.entries) *
            100
          ).toFixed(1),
        )
      : null;

  const out = path.join(__dirname, '..', 'data', 'oi-flow-robust-b-4tf-report-2026-08-12-14.json');
  fs.writeFileSync(out, `${JSON.stringify(combined, null, 2)}\n`);

  let text = 'OI Flow · 4 Bull CE / 4 Bear PE + OI · JSON 12–14 Aug 2026\n';
  text += 'Entry: current+past only. No future bar fires a signal.\n';
  text += `Overall: ${combined.overall.entries} · Ex ${combined.overall.excellent} Good ${combined.overall.good} Bad ${combined.overall.bad} · hit ${combined.overall.hitRatePct}% · Final pts ${combined.overall.sumFavorPts}\n`;
  for (const r of reports) text += printTable(r);
  text += `\nWrote ${out}\n`;
  console.log(text);
}

main();

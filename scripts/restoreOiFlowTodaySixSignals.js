/**
 * Restore today's full 6 ROBUST-B live signals (from full-day DB backfill).
 * Local JSON dump only had minutes to ~11:50, which cut the list to 3.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const OiFlowLiveSignal = require('../src/models/oiFlowLiveSignal');

const DATE = '2026-08-13';

function mins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function tf(label, tone) {
  return { label, tone };
}

/** Exact set from first full-day force backfill (376 live minute rows). */
const SIGNALS = [
  {
    time: '09:35',
    decision: 'CALL BUY',
    strike: 24300,
    spot: 24324.4,
    callChg: 448000,
    putChg: 371000,
    callAct: 'Call long build',
    putAct: 'Put writing',
    quality: { text: 'Call long build + Put writing = bullish / mixed', tone: 'bull' },
    control: 'Buyers',
    tf15: tf('Bear', 'bear'),
    tf5: tf('Bear', 'bear'),
    tf3: tf('Flat', 'flat'),
    tf1: tf('Bull', 'bull'),
    spot15: -19.5,
    favorPts: 10,
    hold: 9,
    exitTime: '09:44',
    exitReason: 'TP',
    grade: 'Excellent',
  },
  {
    time: '10:37',
    decision: 'CALL BUY',
    strike: 24350,
    spot: 24325.9,
    callChg: 153000,
    putChg: 339000,
    callAct: 'Call long build',
    putAct: 'Put writing',
    quality: { text: 'Call long build + Put writing = bullish / mixed', tone: 'bull' },
    control: 'Buyers',
    tf15: tf('Bear', 'bear'),
    tf5: tf('Bull', 'bull'),
    tf3: tf('Bull', 'bull'),
    tf1: tf('Bull', 'bull'),
    spot15: -12.0,
    favorPts: 6.3,
    hold: 15,
    exitTime: '10:52',
    exitReason: 'TIME',
    grade: 'Good',
  },
  {
    time: '11:24',
    decision: 'CALL BUY',
    strike: 24350,
    spot: 24328.25,
    callChg: 129000,
    putChg: 153000,
    callOiL: undefined,
    putOiL: undefined,
    callAct: 'Call long build',
    putAct: 'Put writing',
    quality: { text: 'Call long build + Put writing = bullish / mixed', tone: 'bull' },
    control: 'Buyers',
    tf15: tf('Bull', 'bull'),
    tf5: tf('Bull', 'bull'),
    tf3: tf('Bull', 'bull'),
    tf1: tf('Bull', 'bull'),
    spot15: 8.3,
    favorPts: 10,
    hold: 13,
    exitTime: '11:37',
    exitReason: 'TP',
    grade: 'Excellent',
  },
  {
    time: '12:07',
    decision: 'PUT BUY',
    strike: 24400,
    spot: 24410.4,
    callChg: -109000,
    putChg: 352000,
    callAct: 'Call long unwind',
    putAct: 'Put buying',
    quality: { text: 'Call long unwind + Put buying = bearish confirmation', tone: 'bear' },
    control: 'Sellers',
    tf15: tf('Bull', 'bull'),
    tf5: tf('Bull', 'bull'),
    tf3: tf('Bull', 'bull'),
    tf1: tf('Bear', 'bear'),
    spot15: 52.6,
    favorPts: 8.7,
    hold: 15,
    exitTime: '12:22',
    exitReason: 'TIME',
    grade: 'Good',
  },
  {
    time: '12:57',
    decision: 'PUT BUY',
    strike: 24350,
    spot: 24365.6,
    callChg: -758000,
    putChg: 487000,
    callAct: 'Call long unwind',
    putAct: 'Put buying',
    quality: { text: 'Call long unwind + Put buying = bearish confirmation', tone: 'bear' },
    control: 'Sellers',
    tf15: tf('Bear', 'bear'),
    tf5: tf('Flat', 'flat'),
    tf3: tf('Bear', 'bear'),
    tf1: tf('Bear', 'bear'),
    spot15: -29.6,
    favorPts: -0.4,
    hold: 15,
    exitTime: '13:12',
    exitReason: 'TIME',
    grade: 'Bad',
  },
  {
    time: '13:48',
    decision: 'CALL BUY',
    strike: 24400,
    spot: 24388.85,
    callChg: 142000,
    putChg: 319000,
    callAct: 'Call long build',
    putAct: 'Put writing',
    quality: { text: 'Call long build + Put writing = bullish / mixed', tone: 'bull' },
    control: 'Buyers',
    tf15: tf('Bull', 'bull'),
    tf5: tf('Bull', 'bull'),
    tf3: tf('Bull', 'bull'),
    tf1: tf('Bull', 'bull'),
    spot15: 31.4,
    favorPts: -8,
    hold: 8,
    exitTime: '13:56',
    exitReason: 'SL',
    grade: 'Bad',
  },
];

function fmtLakh(n) {
  if (!Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v / 100000).toFixed(2)}L`;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  await OiFlowLiveSignal.deleteMany({
    symbol: 'NIFTY',
    dateKey: DATE,
    $or: [{ tradeId: null }, { tradeId: { $exists: false } }],
  });

  const saved = [];
  for (const s of SIGNALS) {
    const minutes = mins(s.time);
    const exitMinutes = mins(s.exitTime);
    const optionType = s.decision === 'PUT BUY' ? 'PE' : 'CE';
    const tone = s.decision === 'PUT BUY' ? 'put' : 'call';
    const doc = {
      symbol: 'NIFTY',
      dateKey: DATE,
      minutes,
      time: s.time,
      decision: s.decision,
      tone,
      optionType,
      strike: s.strike,
      strikeLabel: `NIFTY ${s.strike} ${optionType}`,
      control: s.control,
      spot: s.spot,
      callChg: s.callChg,
      putChg: s.putChg,
      callOiL: s.callOiL || fmtLakh(s.callChg),
      putOiL: s.putOiL || fmtLakh(s.putChg),
      callAct: s.callAct,
      putAct: s.putAct,
      quality: s.quality,
      tf15: s.tf15,
      tf5: s.tf5,
      tf3: s.tf3,
      tf1: s.tf1,
      spot15: s.spot15,
      tradeId: null,
      status: 'CLOSED',
      favorPts: s.favorPts,
      hold: s.hold,
      exitMinutes,
      exitTime: s.exitTime,
      exitReason: s.exitReason,
      grade: s.grade,
      tpLeft: 0,
      slLeft: 0,
      targetPoints: 10,
      stopLossPoints: 8,
    };
    await OiFlowLiveSignal.findOneAndUpdate(
      { dateKey: DATE, minutes, decision: s.decision },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    saved.push({
      time: s.time,
      decision: s.decision,
      strike: doc.strikeLabel,
      exitTime: s.exitTime,
      grade: s.grade,
      favorPts: s.favorPts,
    });
  }

  console.log(JSON.stringify({ ok: true, dateKey: DATE, saved: saved.length, signals: saved }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

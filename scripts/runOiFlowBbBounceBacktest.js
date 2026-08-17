/**
 * Usage: node scripts/runOiFlowBbBounceBacktest.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { runBbBounceBacktest } = require('../src/services/oiFlowBbBounceEngine');

async function main() {
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  const report = await runBbBounceBacktest();
  const o = report.overall;
  console.log(
    `OI Flow BB Bounce · ${o.entries} trades · CE ${o.call} PE ${o.put} · hit ${o.hitRatePct}% · pts ${o.sumFavorPts} · raw ${o.rawSetups}`,
  );
  for (const d of report.days) {
    console.log(
      `  ${d.dateKey} ${d.source} ${d.rowsUsed} bars ${d.first}–${d.last} · taken ${d.summary.entries} · raw ${d.rawSetups} · pts ${d.summary.sumFavorPts}`,
    );
    for (const s of d.signals) {
      console.log(
        `    ${s.time} → ${s.exitTime || '—'} ${s.strikeLabel} ${s.bbZone} ${s.candle} ${s.pair} ${s.favorPts} ${s.exitReason} ${s.grade}`,
      );
    }
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
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

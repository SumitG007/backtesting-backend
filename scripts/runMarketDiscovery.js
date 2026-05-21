/**
 * Backend-only: scan NIFTY candles 2022–2026, find CALL/PUT patterns, write report.
 *
 *   node scripts/runMarketDiscovery.js
 *   node scripts/runMarketDiscovery.js NIFTY 5
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runMultiYearAnalysis, DEFAULT_YEARS } = require('../src/analysis/runMultiYearAnalysis');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const preferApi = process.argv.includes('--api') || process.env.DISCOVERY_API != null;
const symbol = String(args[0] || 'NIFTY').toUpperCase();
const interval = String(args[1] || '5');

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

function printReport(result) {
  const a = result.analysis;
  const o = result.optionSignals;
  const lines = [];

  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(` MARKET DISCOVERY — ${result.symbol} ${result.interval}m — ${result.years.join(', ')}`);
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(`Candles loaded: ${result.dataLoad.totalCandles}`);
  for (const [y, st] of Object.entries(result.dataLoad.byYear)) {
    lines.push(`  ${y}: ${st.candleCount} bars (${st.fromDate} → ${st.toDate})`);
  }
  lines.push('');
  lines.push('── DAY OVERVIEW ──');
  lines.push(
    `Trading days: ${a.overview.tradingDays} | Green: ${a.overview.greenRate}% | Red: ${a.overview.redRate}% | Avg range: ${a.overview.avgDayRange} pts`
  );
  lines.push(`Avg |gap| vs prev close: ${a.overview.avgAbsGapPct}%`);
  lines.push('');
  lines.push('── GAP vs CLOSE COLOUR (common open behaviour) ──');
  lines.push('Bucket          | Days | Green% | Red%');
  for (const g of a.gapSummary) {
    lines.push(
      `${pad(g.bucket, 16)}| ${pad(g.days, 4)} | ${pad(g.greenRate ?? '-', 6)} | ${pad(g.redRate ?? '-', 5)}`
    );
  }
  lines.push('');
  lines.push('── BY YEAR ──');
  for (const y of a.yearBreakdown) {
    lines.push(
      `${y.year}: ${y.tradingDays} days | green ${y.greenRate}% | red ${y.redRate}% | avg range ${y.avgDayRange}`
    );
  }
  lines.push('');
  lines.push('── TOP PATTERNS (day-close win rate, min 35 samples) ──');
  lines.push('ID                        | CE/PE | Win%  | N   | Trade? | Label');
  for (const p of a.patterns.filter((x) => !x.skipped).slice(0, 12)) {
    const opt = result.optionSignals?.callBuy?.find((c) => c.patternId === p.id)
      ? 'CE'
      : result.optionSignals?.putBuy?.find((c) => c.patternId === p.id)
        ? 'PE'
        : '—';
    lines.push(
      `${pad(p.id, 26)}| ${pad(opt, 5)} | ${pad(p.winRate, 5)} | ${pad(p.sampleSize, 3)} | ${p.tradeable ? 'yes' : 'no '} | ${p.label}`
    );
  }
  lines.push('');
  lines.push('── CALL BUY (CE) — best prototype index SL/TG per pattern ──');
  if (!o.callBuy.length) lines.push('  (none tradeable)');
  for (const c of o.callBuy) {
    const pr = c.prototype;
    lines.push(
      `  ${c.patternId}: day-win ${c.historicalDayWinRate}% (n=${c.sampleDays}) | proto net ${pr?.netPnl} | WR ${pr?.winRate}% | trades ${pr?.totalTrades} | SL${pr?.stopLossPoints}/TG${pr?.targetPoints}`
    );
    lines.push(`    → ${c.label}`);
  }
  lines.push('');
  lines.push('── PUT BUY (PE) — best prototype index SL/TG per pattern ──');
  if (!o.putBuy.length) lines.push('  (none tradeable)');
  for (const c of o.putBuy) {
    const pr = c.prototype;
    lines.push(
      `  ${c.patternId}: day-win ${c.historicalDayWinRate}% (n=${c.sampleDays}) | proto net ${pr?.netPnl} | WR ${pr?.winRate}% | trades ${pr?.totalTrades} | SL${pr?.stopLossPoints}/TG${pr?.targetPoints}`
    );
    lines.push(`    → ${c.label}`);
  }
  lines.push('');
  lines.push('── SUGGESTED RULES TO BACKTEST NEXT ──');
  if (result.suggestedStrategy.selected) {
    for (const r of result.suggestedStrategy.rules) {
      lines.push(`  [${r.optionType}] ${r.patternId} @ ${r.entryIst} IST — hist ${r.historicalWinRate}% (n=${r.sampleSize})`);
    }
    for (const bt of result.suggestedStrategy.prototypeBacktests) {
      lines.push(
        `    prototype ${bt.patternId}: net ${bt.summary.netPnl} | WR ${bt.summary.winRate}% | trades ${bt.summary.totalTrades}`
      );
    }
  } else {
    lines.push(`  ${result.suggestedStrategy.message}`);
  }
  if (o.recommendedCall) {
    lines.push('');
    lines.push(`★ Best CALL candidate: ${o.recommendedCall.patternId} (proto net ${o.recommendedCall.prototype?.netPnl})`);
  }
  if (o.recommendedPut) {
    lines.push(`★ Best PUT candidate:  ${o.recommendedPut.patternId} (proto net ${o.recommendedPut.prototype?.netPnl})`);
  }
  lines.push('');
  lines.push(result.meta.disclaimer);
  lines.push('');

  return lines.join('\n');
}

async function main() {
  console.log(`Discovering patterns on ${symbol} ${interval}m (${DEFAULT_YEARS.join(', ')})...`);
  const started = Date.now();
  const result = await runMultiYearAnalysis({
    symbol,
    interval,
    years: DEFAULT_YEARS,
    preferApi,
  });
  const text = printReport(result);
  console.log(text);

  const outDir = path.join(__dirname);
  const txtPath = path.join(outDir, 'market-discovery-report.txt');
  const jsonPath = path.join(outDir, 'market-discovery-report.json');
  fs.writeFileSync(txtPath, text, 'utf8');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), durationMs: Date.now() - started, ...result }, null, 2)
  );
  console.log(`Saved: ${txtPath}`);
  console.log(`Saved: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

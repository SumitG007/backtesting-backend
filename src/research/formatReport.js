/**
 * Format pattern research JSON as a readable text report.
 */

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

function formatPatternRow(p) {
  return [
    pad(p.sequence.replace(/>/g, '→'), 22),
    pad(p.context, 16),
    pad(p.bestSide || '—', 4),
    pad(p.bestWinRate != null ? `${p.bestWinRate}%` : '—', 6),
    pad(p.sampleSize, 5),
    pad(p.occurrencesPerMonth ?? '—', 6),
    p.tradeable ? 'yes' : 'no',
  ].join(' | ');
}

function formatPatternResearchReport(result) {
  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(` PATTERN RESEARCH — ${result.symbol} ${result.interval}m — ${result.years.join(', ')}`);
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(`Candles: ${result.dataLoad.totalCandles} | Source: ${result.dataLoad.source}`);
  lines.push(
    `Trading days: ${result.overview.tradingDays} | Patterns found: ${result.summary.patternsFound} | Tradeable: ${result.summary.tradeablePatterns}`,
  );
  lines.push('');
  lines.push('Outcome model (per occurrence):');
  lines.push(
    `  Entry = next bar open | Target +${result.researchConfig.outcome.targetPoints} pts | Stop -${result.researchConfig.outcome.stopPoints} pts | Horizon ${result.researchConfig.outcome.horizonBars} bars`,
  );
  lines.push(`  Encoding: ${result.researchConfig.encoding}`);
  lines.push('');

  if (result.summary.bestTradeable) {
    const b = result.summary.bestTradeable;
    lines.push('── BEST TRADEABLE PATTERN ──');
    lines.push(`  ${b.label}`);
    lines.push(
      `  Side: ${b.bestSide} | Win rate: ${b.bestWinRate}% | Samples: ${b.sampleSize} | ~${b.occurrencesPerMonth}/month`,
    );
    lines.push(`  Long WR: ${b.longWinRate}% | Short WR: ${b.shortWinRate}% | Avg next-bar pts: ${b.avgNext1Points}`);
    lines.push('');
  }

  lines.push('── TOP PATTERNS (all) ──');
  lines.push('Sequence              | Context          | Side | Win%   | N     | /mo    | Trade?');
  for (const p of result.topPatterns.slice(0, 20)) {
    lines.push(formatPatternRow(p));
  }
  lines.push('');

  lines.push('── SESSION OPEN (first N bars → next bar) ──');
  for (const p of result.byCategory.sessionPrefix.slice(0, 8)) {
    lines.push(
      `  ${p.sequence.replace(/>/g, '→')} → ${p.bestSide} ${p.bestWinRate}% (n=${p.sampleSize}, ~${p.occurrencesPerMonth}/mo)`,
    );
  }
  lines.push('');

  lines.push('── DIR-ONLY OPEN (U/D/F colours) ──');
  for (const p of result.byCategory.dirPrefix.slice(0, 8)) {
    lines.push(
      `  ${p.sequence.replace(/>/g, '→')} → ${p.bestSide} ${p.bestWinRate}% (n=${p.sampleSize})`,
    );
  }
  lines.push('');

  lines.push(result.meta.disclaimer);
  lines.push('');
  return lines.join('\n');
}

module.exports = { formatPatternResearchReport };

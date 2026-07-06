/**
 * Score and rank patterns: win rate × frequency × cross-year stability.
 */

function patternScore(p) {
  const wr = Number(p.bestWinRate) || 0;
  const n = Number(p.sampleSize) || 0;
  const stability = Number(p.yearStabilityPct) || 0;
  const freq = Number(p.occurrencesPerMonth) || 0;

  if (n < 35 || wr < 50) return 0;

  const wrFactor = Math.max(0, wr - 50) / 50;
  const freqFactor = Math.log10(n + 1);
  const stabilityFactor = stability / 100;

  return Number((wrFactor * freqFactor * (0.5 + stabilityFactor * 0.5) * 100).toFixed(2));
}

function rankPatterns(patterns, sortBy = 'score') {
  const scored = patterns.map((p) => ({
    ...p,
    score: patternScore(p),
  }));

  if (sortBy === 'trades') {
    scored.sort((a, b) => {
      const t = b.sampleSize - a.sampleSize;
      if (t !== 0) return t;
      return (b.bestWinRate || 0) - (a.bestWinRate || 0);
    });
  } else if (sortBy === 'winRate') {
    scored.sort((a, b) => {
      const w = (b.bestWinRate || 0) - (a.bestWinRate || 0);
      if (w !== 0) return w;
      return b.sampleSize - a.sampleSize;
    });
  } else {
    scored.sort((a, b) => {
      const s = b.score - a.score;
      if (s !== 0) return s;
      return b.sampleSize - a.sampleSize;
    });
  }

  return scored;
}

function filterHighVolume(patterns, minTrades = 150) {
  return patterns.filter((p) => p.sampleSize >= minTrades);
}

function filterStableAllYears(patterns, minYearWinRate = 48) {
  return patterns.filter((p) => {
    const years = Object.values(p.byYear || {});
    if (years.length < 4) return false;
    return years.every((y) => {
      const wr = p.bestSide === 'CE' ? y.longWinRate : y.shortWinRate;
      return wr == null || wr >= minYearWinRate;
    });
  });
}

function pickBestOverall(patterns) {
  const ranked = rankPatterns(patterns, 'score');
  return ranked[0] || null;
}

function pickBestHighFrequency(patterns, minWinRate = 52) {
  const eligible = patterns.filter((p) => (p.bestWinRate || 0) >= minWinRate);
  return rankPatterns(eligible, 'trades')[0] || null;
}

function pickBestWinRate(patterns, minTrades = 80) {
  const eligible = patterns.filter((p) => p.sampleSize >= minTrades);
  return rankPatterns(eligible, 'winRate')[0] || null;
}

function summarizeByCategory(patterns) {
  const cats = {};
  for (const p of patterns) {
    const c = p.category || p.context || 'other';
    if (!cats[c]) cats[c] = { count: 0, totalTrades: 0, avgWinRate: 0, patterns: [] };
    cats[c].count += 1;
    cats[c].totalTrades += p.sampleSize;
    cats[c].patterns.push(p);
  }
  for (const c of Object.values(cats)) {
    const wrs = c.patterns.map((p) => p.bestWinRate).filter(Number.isFinite);
    c.avgWinRate = wrs.length
      ? Number((wrs.reduce((a, b) => a + b, 0) / wrs.length).toFixed(1))
      : null;
    c.top = rankPatterns(c.patterns, 'score')[0] || null;
  }
  return cats;
}

module.exports = {
  patternScore,
  rankPatterns,
  filterHighVolume,
  filterStableAllYears,
  pickBestOverall,
  pickBestHighFrequency,
  pickBestWinRate,
  summarizeByCategory,
};

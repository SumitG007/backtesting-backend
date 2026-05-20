const { getIstClock } = require('../utils/dateTime');
const { buildStrategyRunSummary } = require('../strategies/shared/summary');

const PATTERN_RULES = {
  gap_up_hold_945_long: {
    direction: 'LONG',
    optionType: 'CE',
    matches: (d) =>
      d.gapPct != null &&
      d.gapPct > 0.03 &&
      d.gapPct <= 0.6 &&
      d.holdAboveOpenUntil945,
    entryMinutes: 585,
  },
  gap_down_hold_945_short: {
    direction: 'SHORT',
    optionType: 'PE',
    matches: (d) =>
      d.gapPct != null &&
      d.gapPct < -0.03 &&
      d.gapPct >= -0.6 &&
      d.holdBelowOpenUntil945,
    entryMinutes: 585,
  },
  orb30_break_high_long: {
    direction: 'LONG',
    optionType: 'CE',
    matches: (d, ctx) =>
      d.first30Range <= ctx.first30Median &&
      d.brokeFirst30HighBefore11 &&
      !d.brokeFirst30LowBefore11,
    entryMinutes: 660,
  },
  orb30_break_low_short: {
    direction: 'SHORT',
    optionType: 'PE',
    matches: (d, ctx) =>
      d.first30Range <= ctx.first30Median &&
      d.brokeFirst30LowBefore11 &&
      !d.brokeFirst30HighBefore11,
    entryMinutes: 660,
  },
  pdh_break_before_1030_long: {
    direction: 'LONG',
    optionType: 'CE',
    matches: (d) => d.brokePDHBefore1030,
    entryMinutes: 630,
  },
  pdl_break_before_1030_short: {
    direction: 'SHORT',
    optionType: 'PE',
    matches: (d) => d.brokePDLBefore1030,
    entryMinutes: 630,
  },
};

function pickTopPatterns(patterns, minWinRate = 52) {
  return patterns
    .filter((p) => p.tradeable !== false && PATTERN_RULES[p.id])
    .filter((p) => !p.skipped && p.winRate != null && p.winRate >= minWinRate && p.sampleSize >= 35)
    .slice(0, 2);
}

function findEntryBar(bars, entryMinutes) {
  for (const c of bars) {
    const clock = getIstClock(c[0]);
    if (clock.minutes >= entryMinutes) return c;
  }
  return bars[bars.length - 1] || null;
}

/**
 * Index-points prototype backtest (research only — not option premium model).
 */
function runPrototypeBacktest({ days, intraByDay, patternId, stopLossPoints, targetPoints }) {
  const rule = PATTERN_RULES[patternId];
  if (!rule) return { trades: [], summary: buildStrategyRunSummary([]) };

  const sl = Math.max(5, Number(stopLossPoints) || 25);
  const tg = Math.max(5, Number(targetPoints) || 40);
  const first30Median = (() => {
    const ranges = days.map((d) => d.first30Range).filter(Number.isFinite);
    ranges.sort((a, b) => a - b);
    const mid = Math.floor(ranges.length / 2);
    return ranges.length % 2 ? ranges[mid] : (ranges[mid - 1] + ranges[mid]) / 2;
  })();

  const trades = [];
  for (const d of days) {
    if (!rule.matches(d, { first30Median })) continue;
    const bars = intraByDay.get(d.dateKey);
    if (!bars?.length) continue;
    const entryBar = findEntryBar(bars, rule.entryMinutes);
    if (!entryBar) continue;

    const entryTime = entryBar[0];
    const entrySpot = Number(entryBar[4]);
    if (!Number.isFinite(entrySpot)) continue;

    const isLong = rule.direction === 'LONG';
    let exitTime = bars[bars.length - 1][0];
    let exitSpot = Number(bars[bars.length - 1][4]);
    let reason = 'DAY_CLOSE';
    let pnl = 0;

    const entryIdx = bars.findIndex((b) => b[0] === entryTime);
    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      const c = bars[i];
      const h = Number(c[2]);
      const l = Number(c[3]);
      const cl = Number(c[4]);
      if (isLong) {
        if (l <= entrySpot - sl) {
          exitTime = c[0];
          exitSpot = entrySpot - sl;
          reason = 'STOP_LOSS';
          pnl = -sl;
          break;
        }
        if (h >= entrySpot + tg) {
          exitTime = c[0];
          exitSpot = entrySpot + tg;
          reason = 'TARGET';
          pnl = tg;
          break;
        }
      } else {
        if (h >= entrySpot + sl) {
          exitTime = c[0];
          exitSpot = entrySpot + sl;
          reason = 'STOP_LOSS';
          pnl = -sl;
          break;
        }
        if (l <= entrySpot - tg) {
          exitTime = c[0];
          exitSpot = entrySpot - tg;
          reason = 'TARGET';
          pnl = tg;
          break;
        }
      }
      exitTime = c[0];
      exitSpot = cl;
    }

    if (reason === 'DAY_CLOSE') {
      pnl = isLong ? exitSpot - entrySpot : entrySpot - exitSpot;
    }

    trades.push({
      dateKey: d.dateKey,
      patternId,
      direction: rule.direction,
      optionType: rule.optionType,
      entryTime,
      exitTime,
      entrySpot,
      exitSpot,
      pnl: Number(pnl.toFixed(2)),
      reason,
    });
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

function buildSuggestedStrategy({ patterns, days, intraByDay }) {
  const top = pickTopPatterns(patterns);
  if (!top.length) {
    return {
      selected: false,
      message:
        'No pattern met the minimum win-rate and sample-size bar on this dataset. Try more years or lower thresholds in a future pass.',
      rules: [],
      prototypeBacktests: [],
    };
  }

  const rules = top.map((p) => {
    const def = PATTERN_RULES[p.id];
    return {
      patternId: p.id,
      label: p.label,
      historicalWinRate: p.winRate,
      sampleSize: p.sampleSize,
      direction: def?.direction,
      optionType: def?.optionType,
      entryIst: def
        ? `${String(Math.floor(def.entryMinutes / 60)).padStart(2, '0')}:${String(def.entryMinutes % 60).padStart(2, '0')}`
        : null,
      suggestedStopLossPoints: 25,
      suggestedTargetPoints: 40,
      note: 'Prototype uses index points; for live P&L you would add an option premium model like your other strategies.',
    };
  });

  const prototypeBacktests = top.map((p) => {
    const bt = runPrototypeBacktest({
      days,
      intraByDay,
      patternId: p.id,
      stopLossPoints: 25,
      targetPoints: 40,
    });
    return {
      patternId: p.id,
      label: p.label,
      summary: bt.summary,
      sampleTrades: bt.trades.slice(0, 5),
    };
  });

  return {
    selected: true,
    message: `Top ${top.length} tradeable pattern(s) by day-close win rate (min 52%, n≥35). Compare with prototype win rate below — SL/target exit early.`,
    rules,
    prototypeBacktests,
  };
}

module.exports = {
  buildSuggestedStrategy,
  runPrototypeBacktest,
  PATTERN_RULES,
};

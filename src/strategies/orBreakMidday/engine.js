/**
 * OR Break Midday Chase — best standalone from 16k+ scenario search.
 * OR 9:15–9:45 · entry window 11:00–13:30 · structural SL · 3× ATR trail.
 */
const { getIstClock } = require('../../utils/dateTime');

const DEFAULT = {
  orStart: 9 * 60 + 15,
  orEnd: 9 * 60 + 45,
  entryFrom: 11 * 60,
  entryTo: 13 * 60 + 30,
  eod: 15 * 60 + 15,
  minOrPts: 15,
  minSl: 10,
  maxSl: 30,
  slAtrMult: 1.5,
  trailAtrMult: 3.0,
  trailBars: 14,
  maxTradesDay: 1,
};

function parseRow(row) {
  const iso = Array.isArray(row) ? row[0] : row?.time;
  const open = Number(Array.isArray(row) ? row[1] : row?.open);
  const high = Number(Array.isArray(row) ? row[2] : row?.high);
  const low = Number(Array.isArray(row) ? row[3] : row?.low);
  const close = Number(Array.isArray(row) ? row[4] : row?.close);
  if (!iso || ![open, high, low, close].every(Number.isFinite)) return null;
  const clock = getIstClock(iso);
  return {
    iso,
    open,
    high,
    low,
    close,
    dateKey: clock.dateKey,
    minutes: clock.minutes,
    range: high - low,
  };
}

function parseAll(rows) {
  const out = [];
  for (const row of rows || []) {
    const c = parseRow(row);
    if (c) out.push(c);
  }
  out.sort((a, b) => new Date(a.iso) - new Date(b.iso));
  return out;
}

function byDay(candles) {
  const m = new Map();
  for (const c of candles) {
    if (!m.has(c.dateKey)) m.set(c.dateKey, []);
    m.get(c.dateKey).push(c);
  }
  return m;
}

function atrSeries(bars, p = 14) {
  const out = [];
  let prev = null;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const tr =
      prev == null
        ? b.high - b.low
        : Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
    if (i < p) {
      out.push(null);
      prev = b.close;
      continue;
    }
    if (i === p) {
      out.push(tr);
      prev = b.close;
      continue;
    }
    out.push((out[i - 1] * (p - 1) + tr) / p);
    prev = b.close;
  }
  return out;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function structuralSl(entry, direction, atr, bars, i, cfg) {
  const a = atr || 12;
  let slPts = a * cfg.slAtrMult;
  const swing =
    direction === 'long'
      ? entry - Math.min(...bars.slice(Math.max(0, i - 8), i + 1).map((x) => x.low))
      : Math.max(...bars.slice(Math.max(0, i - 8), i + 1).map((x) => x.high)) - entry;
  slPts = clamp(Math.max(slPts, swing), cfg.minSl, cfg.maxSl);
  const slPrice = direction === 'long' ? entry - slPts : entry + slPts;
  return { slPrice, slPts };
}

function simulateExit({ bars, startIdx, direction, entry, slPrice, slPts, atr, cfg }) {
  const a = atr || slPts;
  const trailActivate = a * cfg.trailAtrMult;
  let trailing = false;

  for (let j = startIdx; j < bars.length; j += 1) {
    const bar = bars[j];

    if (direction === 'long') {
      if (bar.low <= slPrice) {
        const pts = slPrice - entry;
        return {
          points: pts,
          result: 'SL',
          r: pts / slPts,
          exitPrice: slPrice,
          exitMinutes: bar.minutes,
        };
      }
      const mfe = bar.high - entry;
      if (!trailing && mfe >= trailActivate) trailing = true;
      if (trailing) {
        const t0 = Math.max(0, j - cfg.trailBars);
        const trail = Math.min(...bars.slice(t0, j + 1).map((x) => x.low));
        if (bar.low <= trail && trail > entry - slPts * 0.3) {
          const pts = trail - entry;
          return {
            points: pts,
            result: 'TRAIL',
            r: pts / slPts,
            exitPrice: trail,
            exitMinutes: bar.minutes,
          };
        }
      }
    } else {
      if (bar.high >= slPrice) {
        const pts = entry - slPrice;
        return {
          points: pts,
          result: 'SL',
          r: pts / slPts,
          exitPrice: slPrice,
          exitMinutes: bar.minutes,
        };
      }
      const mfe = entry - bar.low;
      if (!trailing && mfe >= trailActivate) trailing = true;
      if (trailing) {
        const t0 = Math.max(0, j - cfg.trailBars);
        const trail = Math.max(...bars.slice(t0, j + 1).map((x) => x.high));
        if (bar.high >= trail && trail < entry + slPts * 0.3) {
          const pts = entry - trail;
          return {
            points: pts,
            result: 'TRAIL',
            r: pts / slPts,
            exitPrice: trail,
            exitMinutes: bar.minutes,
          };
        }
      }
    }

    if (bar.minutes >= cfg.eod) {
      const pts = direction === 'long' ? bar.close - entry : entry - bar.close;
      return {
        points: pts,
        result: 'EOD',
        r: pts / slPts,
        exitPrice: bar.close,
        exitMinutes: bar.minutes,
      };
    }
  }

  const last = bars[bars.length - 1];
  const pts = direction === 'long' ? last.close - entry : entry - last.close;
  return {
    points: pts,
    result: 'EOD',
    r: pts / slPts,
    exitPrice: last.close,
    exitMinutes: last.minutes,
  };
}

function backtestDay(bars, cfg = DEFAULT) {
  if (bars.length < 25) return null;

  const orBars = bars.filter((b) => b.minutes >= cfg.orStart && b.minutes < cfg.orEnd);
  if (!orBars.length) return null;
  const orHigh = Math.max(...orBars.map((b) => b.high));
  const orLow = Math.min(...orBars.map((b) => b.low));
  const orRange = orHigh - orLow;
  if (orRange < cfg.minOrPts) return null;

  const atr = atrSeries(bars);

  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b.minutes < cfg.entryFrom || b.minutes > cfg.entryTo) continue;

    let direction = null;
    let reason = null;
    if (b.close > orHigh) {
      direction = 'long';
      reason = 'or_break_up';
    } else if (b.close < orLow) {
      direction = 'short';
      reason = 'or_break_dn';
    }
    if (!direction) continue;

    const a = atr[i];
    if (!a) continue;

    const entry = b.close;
    const { slPrice, slPts } = structuralSl(entry, direction, a, bars, i, cfg);
    const exit = simulateExit({
      bars,
      startIdx: i + 1,
      direction,
      entry,
      slPrice,
      slPts,
      atr: a,
      cfg,
    });

    return {
      dateKey: b.dateKey,
      direction,
      setup: 'or_break_midday',
      reason,
      orHigh,
      orLow,
      orRange: Number(orRange.toFixed(2)),
      entryMinutes: b.minutes,
      entryPrice: entry,
      slPts: Number(slPts.toFixed(2)),
      exitPrice: Number(exit.exitPrice.toFixed(2)),
      exitMinutes: exit.exitMinutes,
      result: exit.result,
      points: Number(exit.points.toFixed(2)),
      rMultiple: Number(exit.r.toFixed(2)),
    };
  }

  return null;
}

function summarize(trades) {
  const wins = trades.filter((t) => t.points > 0);
  const losses = trades.filter((t) => t.points <= 0);
  const net = trades.reduce((s, t) => s + t.points, 0);
  const bigR = trades.filter((t) => t.rMultiple >= 3);

  return {
    label: 'OR Break Midday Chase',
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    netPoints: Number(net.toFixed(2)),
    avgWin: wins.length ? Number((wins.reduce((s, t) => s + t.points, 0) / wins.length).toFixed(2)) : 0,
    avgLoss: losses.length ? Number((losses.reduce((s, t) => s + t.points, 0) / losses.length).toFixed(2)) : 0,
    bigWin3R: bigR.length,
    avgR: trades.length ? Number((trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length).toFixed(2)) : 0,
    allTrades: trades,
  };
}

function buildMonthlyBreakdown(trades) {
  const map = new Map();
  for (const t of trades) {
    const month = t.dateKey.slice(0, 7);
    if (!map.has(month)) {
      map.set(month, { month, trades: 0, wins: 0, netPoints: 0, days: new Set() });
    }
    const row = map.get(month);
    row.trades += 1;
    if (t.points > 0) row.wins += 1;
    row.netPoints += t.points;
    row.days.add(t.dateKey);
  }
  return [...map.values()]
    .map((m) => ({
      month: m.month,
      trades: m.trades,
      tradingDays: m.days.size,
      wins: m.wins,
      winRate: m.trades ? Number(((m.wins / m.trades) * 100).toFixed(1)) : 0,
      netPoints: Number(m.netPoints.toFixed(2)),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function toPublicSummary(result) {
  return {
    label: result.label,
    trades: result.trades,
    wins: result.wins,
    losses: result.losses,
    winRate: result.winRate,
    netPoints: result.netPoints,
    avgWin: result.avgWin,
    avgLoss: result.avgLoss,
    bigWin3R: result.bigWin3R,
    avgR: result.avgR,
  };
}

function runOrBreakBacktest(allRows, opts = {}) {
  const cfg = { ...DEFAULT, ...opts.settings };
  const candles = parseAll(allRows);
  const dayMap = byDay(candles);
  const sortedDays = [...dayMap.keys()].sort();
  const trades = [];

  for (const dateKey of sortedDays) {
    if (opts.fromDate && dateKey < opts.fromDate) continue;
    if (opts.toDate && dateKey > opts.toDate) continue;
    const dayBars = dayMap.get(dateKey) || [];
    const t = backtestDay(dayBars, cfg);
    if (t) trades.push(t);
  }

  return summarize(trades);
}

function runYearlyBreakdown(allRows, years) {
  const out = [];
  for (const year of years) {
    const r = runOrBreakBacktest(allRows, {
      fromDate: `${year}-01-01`,
      toDate: `${year}-12-31`,
    });
    out.push({
      year,
      ...toPublicSummary(r),
      monthly: buildMonthlyBreakdown(r.allTrades),
    });
  }
  return out;
}

function runOrBreakReport(allRows, opts = {}) {
  const result = runOrBreakBacktest(allRows, opts);
  return {
    summary: toPublicSummary(result),
    monthly: buildMonthlyBreakdown(result.allTrades),
    trades: result.allTrades,
  };
}

module.exports = {
  DEFAULT,
  runOrBreakBacktest,
  runOrBreakReport,
  runYearlyBreakdown,
  buildMonthlyBreakdown,
  backtestDay,
};

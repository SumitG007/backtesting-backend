/**
 * Liquidity strategies for backtest / scenario search.
 *
 * Modes:
 *  - sweep_reverse: wick through zone + close back inside → fade (default)
 *  - break_go: close through zone → trade continuation
 *  - sweep_rr: sweep_reverse with target = risk × rrMultiple
 *
 * Filters: session windows, prior-day zones only, EMA trend, min sweep depth, side bias.
 * PnL ₹ = points × lotSize (lotSize = 65 × lots).
 */

const { getIstClock } = require('../utils/dateTime');

const DEFAULTS = {
  mode: 'sweep_reverse', // sweep_reverse | break_go | sweep_rr
  length: 14,
  minVisits: 2,
  minZoneAgeBars: 14,
  bufferPts: 5,
  targetPts: 40,
  targetMode: 'hybrid', // fixed | chase | hybrid | rr
  rrMultiple: 1.5,
  sessionStartMin: 9 * 60 + 20,
  sessionEndMin: 14 * 60 + 45,
  flatMin: 15 * 60 + 15,
  maxTradesPerDay: 2,
  lotSize: 65,
  maxZoneLookbackDays: 5,
  maxRiskPts: 80,
  minSweepPts: 0, // min penetration beyond zone
  priorDayZonesOnly: false,
  emaPeriod: 0, // 0 = off; e.g. 50 on 5m
  sideBias: 'both', // both | long | short
  requireBullishClose: false, // reverse: close must be strong vs open
};

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRows(rows) {
  const out = [];
  for (const row of rows || []) {
    if (Array.isArray(row)) {
      const time = row[0];
      const open = toNum(row[1]);
      const high = toNum(row[2]);
      const low = toNum(row[3]);
      const close = toNum(row[4]);
      const volume = Math.max(0, toNum(row[5]) || 0);
      if (open == null || high == null || low == null || close == null) continue;
      const clock = getIstClock(time);
      out.push({ time, open, high, low, close, volume, dateKey: clock.dateKey, minutes: clock.minutes });
    } else if (row && typeof row === 'object') {
      const time = row.time || row.timestamp || row.t;
      const open = toNum(row.open);
      const high = toNum(row.high);
      const low = toNum(row.low);
      const close = toNum(row.close);
      const volume = Math.max(0, toNum(row.volume) || 0);
      if (open == null || high == null || low == null || close == null || time == null) continue;
      const clock = getIstClock(time);
      out.push({ time, open, high, low, close, volume, dateKey: clock.dateKey, minutes: clock.minutes });
    }
  }
  out.sort((a, b) => new Date(a.time) - new Date(b.time));
  return out;
}

function mergeSettings(raw = {}) {
  const mode = ['sweep_reverse', 'break_go', 'sweep_rr'].includes(raw.mode) ? raw.mode : DEFAULTS.mode;
  let targetMode = ['fixed', 'chase', 'hybrid', 'rr'].includes(raw.targetMode)
    ? raw.targetMode
    : DEFAULTS.targetMode;
  if (mode === 'sweep_rr') targetMode = 'rr';

  return {
    ...DEFAULTS,
    mode,
    length: Math.max(5, Math.min(30, Math.floor(numOr(raw.length, DEFAULTS.length)))),
    minVisits: Math.max(1, Math.min(10, Math.floor(numOr(raw.minVisits, DEFAULTS.minVisits)))),
    bufferPts: Math.max(0, numOr(raw.bufferPts, DEFAULTS.bufferPts)),
    targetPts: Math.max(5, numOr(raw.targetPts, DEFAULTS.targetPts)),
    targetMode,
    rrMultiple: Math.max(0.5, Math.min(5, numOr(raw.rrMultiple, DEFAULTS.rrMultiple))),
    maxTradesPerDay: Math.max(1, Math.min(6, Math.floor(numOr(raw.maxTradesPerDay, DEFAULTS.maxTradesPerDay)))),
    lotSize: Math.max(1, Math.floor(numOr(raw.lotSize, DEFAULTS.lotSize))),
    sessionStartMin: Math.floor(numOr(raw.sessionStartMin, DEFAULTS.sessionStartMin)),
    sessionEndMin: Math.floor(numOr(raw.sessionEndMin, DEFAULTS.sessionEndMin)),
    flatMin: Math.floor(numOr(raw.flatMin, DEFAULTS.flatMin)),
    maxZoneLookbackDays: Math.max(
      1,
      Math.min(15, Math.floor(numOr(raw.maxZoneLookbackDays, DEFAULTS.maxZoneLookbackDays))),
    ),
    minZoneAgeBars: Math.max(5, Math.floor(numOr(raw.minZoneAgeBars, DEFAULTS.minZoneAgeBars))),
    maxRiskPts: Math.max(10, Math.min(150, numOr(raw.maxRiskPts, DEFAULTS.maxRiskPts))),
    minSweepPts: Math.max(0, numOr(raw.minSweepPts, DEFAULTS.minSweepPts)),
    priorDayZonesOnly: Boolean(raw.priorDayZonesOnly),
    emaPeriod: Math.max(0, Math.floor(numOr(raw.emaPeriod, DEFAULTS.emaPeriod))),
    sideBias: ['both', 'long', 'short'].includes(raw.sideBias) ? raw.sideBias : DEFAULTS.sideBias,
    requireBullishClose: Boolean(raw.requireBullishClose),
  };
}

function isPivotHigh(bars, i, length) {
  const h = bars[i].high;
  for (let j = i - length; j <= i + length; j += 1) {
    if (j === i) continue;
    if (bars[j].high >= h) return false;
  }
  return true;
}

function isPivotLow(bars, i, length) {
  const l = bars[i].low;
  for (let j = i - length; j <= i + length; j += 1) {
    if (j === i) continue;
    if (bars[j].low <= l) return false;
  }
  return true;
}

function zoneOverlaps(bar, z) {
  return bar.high >= z.bottom && bar.low <= z.top;
}

function daysBetween(a, b) {
  // dateKeys are YYYY-MM-DD — compare as day ordinals without Date.parse
  if (!a || !b) return 999;
  if (a === b) return 0;
  const ay = +a.slice(0, 4);
  const am = +a.slice(5, 7);
  const ad = +a.slice(8, 10);
  const by = +b.slice(0, 4);
  const bm = +b.slice(5, 7);
  const bd = +b.slice(8, 10);
  // Approx day number from civil date (Howard Hinnant / UTC)
  const ord = (y, m, d) => {
    y -= m <= 2;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  };
  return Math.abs(ord(ay, am, ad) - ord(by, bm, bd));
}

function buildEma(bars, period) {
  if (!period || period < 2) return null;
  const out = new Array(bars.length).fill(null);
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < bars.length; i += 1) {
    const c = bars[i].close;
    if (ema == null) {
      if (i + 1 < period) continue;
      let sum = 0;
      for (let j = i - period + 1; j <= i; j += 1) sum += bars[j].close;
      ema = sum / period;
    } else {
      ema = c * k + ema * (1 - k);
    }
    out[i] = ema;
  }
  return out;
}

function pickTarget({ side, entry, risk, settings, zones, entryIndex }) {
  if (settings.targetMode === 'rr') {
    const dist = risk * settings.rrMultiple;
    return {
      price: side === 'LONG' ? entry + dist : entry - dist,
      kind: `RR${settings.rrMultiple}`,
    };
  }

  const fixed = side === 'LONG' ? entry + settings.targetPts : entry - settings.targetPts;
  if (settings.targetMode === 'fixed') return { price: fixed, kind: 'FIXED' };

  let chase = null;
  if (side === 'LONG') {
    for (const z of zones) {
      if (z.side !== 'high' || z.broken || z.index >= entryIndex) continue;
      if (z.bottom > entry) {
        if (chase == null || z.bottom < chase) chase = z.bottom;
      }
    }
  } else {
    for (const z of zones) {
      if (z.side !== 'low' || z.broken || z.index >= entryIndex) continue;
      if (z.top < entry) {
        if (chase == null || z.top > chase) chase = z.top;
      }
    }
  }

  if (settings.targetMode === 'chase') {
    return chase != null ? { price: chase, kind: 'CHASE' } : { price: fixed, kind: 'FIXED_FALLBACK' };
  }
  if (chase == null) return { price: fixed, kind: 'FIXED' };
  if (side === 'LONG') return chase < fixed ? { price: chase, kind: 'CHASE' } : { price: fixed, kind: 'FIXED' };
  return chase > fixed ? { price: chase, kind: 'CHASE' } : { price: fixed, kind: 'FIXED' };
}

function runLiquiditySweepBacktest(candleRows, rawSettings = {}, opts = {}) {
  const settings = mergeSettings(rawSettings);
  const bars = opts.normalized ? candleRows : normalizeRows(candleRows);
  const length = settings.length;
  const zones = []; // all (for chase targets / counts)
  const active = []; // unbroken only — hot path
  const trades = [];
  const ema = buildEma(bars, settings.emaPeriod);
  let open = null;
  let dayTrades = 0;
  let currentDay = null;
  let confirmedThrough = length - 1;
  const justBroken = [];

  const pushZone = (z) => {
    zones.push(z);
    active.push(z);
  };

  const pruneActive = () => {
    // Drop broken + zones older than lookback window from hot list
    let w = 0;
    for (let r = 0; r < active.length; r += 1) {
      const z = active[r];
      if (z.broken) continue;
      active[w] = z;
      w += 1;
    }
    active.length = w;
  };

  const closeTrade = (bar, exitPrice, reason) => {
    if (!open) return;
    const pnlPoints =
      open.side === 'LONG' ? exitPrice - open.entryPrice : open.entryPrice - exitPrice;
    const pnl = Number((pnlPoints * settings.lotSize).toFixed(2));
    trades.push({
      ...open,
      exitTime: bar.time,
      exitPrice: Number(exitPrice.toFixed(2)),
      exitDateKey: bar.dateKey,
      reason,
      pnlPoints: Number(pnlPoints.toFixed(2)),
      pnl,
      lotSize: settings.lotSize,
    });
    open = null;
  };

  const allowSide = (side) => {
    if (settings.sideBias === 'long') return side === 'LONG';
    if (settings.sideBias === 'short') return side === 'SHORT';
    return true;
  };

  const trendOk = (side, i) => {
    if (!ema || ema[i] == null) return true;
    if (side === 'LONG') return bars[i].close >= ema[i];
    return bars[i].close <= ema[i];
  };

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    justBroken.length = 0;

    if (bar.dateKey !== currentDay) {
      currentDay = bar.dateKey;
      dayTrades = 0;
      if (open && open.dateKey !== bar.dateKey) {
        const prev = bars[i - 1] || bar;
        closeTrade(prev, prev.close, 'DAY_CLOSE');
      }
      // Daily prune of ancient unbroken zones from hot list
      let w = 0;
      for (let r = 0; r < active.length; r += 1) {
        const z = active[r];
        if (z.broken) continue;
        if (daysBetween(z.dateKey, bar.dateKey) > settings.maxZoneLookbackDays + 2) continue;
        active[w] = z;
        w += 1;
      }
      active.length = w;
    }

    const pivotIdx = i - length;
    if (pivotIdx >= length) {
      const p = bars[pivotIdx];
      if (isPivotHigh(bars, pivotIdx, length)) {
        pushZone({
          side: 'high',
          index: pivotIdx,
          dateKey: p.dateKey,
          top: p.high,
          bottom: Math.max(p.open, p.close),
          volume: p.volume,
          visits: 1,
          broken: false,
        });
      }
      if (isPivotLow(bars, pivotIdx, length)) {
        pushZone({
          side: 'low',
          index: pivotIdx,
          dateKey: p.dateKey,
          top: Math.min(p.open, p.close),
          bottom: p.low,
          volume: p.volume,
          visits: 1,
          broken: false,
        });
      }
      confirmedThrough = pivotIdx;
    }

    let brokeAny = false;
    for (let zi = 0; zi < active.length; zi += 1) {
      const z = active[zi];
      if (z.broken || i <= z.index) continue;
      if (z.side === 'high') {
        if (bar.close > z.top) {
          z.broken = true;
          justBroken.push(z);
          brokeAny = true;
          continue;
        }
        if (zoneOverlaps(bar, z)) {
          z.volume += bar.volume;
          z.visits += 1;
        }
      } else {
        if (bar.close < z.bottom) {
          z.broken = true;
          justBroken.push(z);
          brokeAny = true;
          continue;
        }
        if (zoneOverlaps(bar, z)) {
          z.volume += bar.volume;
          z.visits += 1;
        }
      }
    }
    if (brokeAny && active.length > 80) pruneActive();

    if (open) {
      if (bar.minutes >= settings.flatMin) {
        closeTrade(bar, bar.close, 'DAY_CLOSE');
      } else if (open.side === 'LONG') {
        if (bar.low <= open.stopPrice) closeTrade(bar, open.stopPrice, 'STOP_LOSS');
        else if (bar.high >= open.targetPrice) closeTrade(bar, open.targetPrice, 'TARGET');
      } else if (open.side === 'SHORT') {
        if (bar.high >= open.stopPrice) closeTrade(bar, open.stopPrice, 'STOP_LOSS');
        else if (bar.low <= open.targetPrice) closeTrade(bar, open.targetPrice, 'TARGET');
      }
    }

    if (
      !open &&
      dayTrades < settings.maxTradesPerDay &&
      bar.minutes >= settings.sessionStartMin &&
      bar.minutes <= settings.sessionEndMin &&
      confirmedThrough >= length
    ) {
      let signal = null;

      if (settings.mode === 'break_go') {
        // Continuation: zone broken this bar
        for (const z of justBroken) {
          if (z.visits < settings.minVisits) continue;
          if (settings.priorDayZonesOnly && z.dateKey === bar.dateKey) continue;
          if (daysBetween(z.dateKey, bar.dateKey) > settings.maxZoneLookbackDays) continue;

          if (z.side === 'high') {
            // buy-side taken → bullish continuation
            if (!allowSide('LONG') || !trendOk('LONG', i)) continue;
            signal = {
              side: 'LONG',
              zone: z,
              sweepExtreme: z.bottom,
              entry: bar.close,
            };
            break;
          }
          if (z.side === 'low') {
            if (!allowSide('SHORT') || !trendOk('SHORT', i)) continue;
            signal = {
              side: 'SHORT',
              zone: z,
              sweepExtreme: z.top,
              entry: bar.close,
            };
            break;
          }
        }
      } else {
        // sweep_reverse / sweep_rr
        const eligible = active.filter((z) => {
          if (z.broken) return false;
          if (z.visits < settings.minVisits) return false;
          if (i - z.index < settings.minZoneAgeBars) return false;
          if (daysBetween(z.dateKey, bar.dateKey) > settings.maxZoneLookbackDays) return false;
          if (settings.priorDayZonesOnly && z.dateKey === bar.dateKey) return false;
          return true;
        });
        eligible.sort((a, b) => {
          if (b.visits !== a.visits) return b.visits - a.visits;
          return b.volume - a.volume;
        });

        for (const z of eligible) {
          if (z.side === 'low' && allowSide('LONG') && trendOk('LONG', i)) {
            const penet = z.bottom - bar.low;
            if (bar.low < z.bottom && bar.close > z.bottom && penet >= settings.minSweepPts) {
              if (settings.requireBullishClose && bar.close < bar.open) continue;
              signal = { side: 'LONG', zone: z, sweepExtreme: bar.low, entry: bar.close };
              break;
            }
          }
        }
        if (!signal) {
          for (const z of eligible) {
            if (z.side === 'high' && allowSide('SHORT') && trendOk('SHORT', i)) {
              const penet = bar.high - z.top;
              if (bar.high > z.top && bar.close < z.top && penet >= settings.minSweepPts) {
                if (settings.requireBullishClose && bar.close > bar.open) continue;
                signal = { side: 'SHORT', zone: z, sweepExtreme: bar.high, entry: bar.close };
                break;
              }
            }
          }
        }
      }

      if (signal) {
        const entryPrice = signal.entry;
        let stopPrice;
        if (settings.mode === 'break_go') {
          stopPrice =
            signal.side === 'LONG'
              ? signal.zone.bottom - settings.bufferPts
              : signal.zone.top + settings.bufferPts;
        } else {
          stopPrice =
            signal.side === 'LONG'
              ? signal.sweepExtreme - settings.bufferPts
              : signal.sweepExtreme + settings.bufferPts;
        }

        const risk =
          signal.side === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;
        if (!(risk > 0 && risk <= settings.maxRiskPts)) {
          // skip
        } else {
          const tgt = pickTarget({
            side: signal.side,
            entry: entryPrice,
            risk,
            settings,
            zones: active,
            entryIndex: i,
          });
          open = {
            side: signal.side,
            entryTime: bar.time,
            entryPrice: Number(entryPrice.toFixed(2)),
            dateKey: bar.dateKey,
            stopPrice: Number(stopPrice.toFixed(2)),
            targetPrice: Number(tgt.price.toFixed(2)),
            targetKind: tgt.kind,
            zoneSide: signal.zone.side,
            zoneTop: Number(signal.zone.top.toFixed(2)),
            zoneBottom: Number(signal.zone.bottom.toFixed(2)),
            zoneVolume: Math.round(signal.zone.volume),
            zoneDateKey: signal.zone.dateKey,
            sweepExtreme: Number(signal.sweepExtreme.toFixed(2)),
            riskPts: Number(risk.toFixed(2)),
            mode: settings.mode,
          };
          dayTrades += 1;
        }
      }
    }
  }

  if (open && bars.length) {
    const last = bars[bars.length - 1];
    closeTrade(last, last.close, 'DAY_CLOSE');
  }

  const byDayMap = new Map();
  for (const t of trades) {
    const key = t.dateKey;
    if (!byDayMap.has(key)) {
      byDayMap.set(key, { dateKey: key, trades: [], pnl: 0, wins: 0, losses: 0 });
    }
    const d = byDayMap.get(key);
    d.trades.push(t);
    d.pnl += t.pnl;
    if (t.pnl > 0) d.wins += 1;
    else if (t.pnl < 0) d.losses += 1;
  }
  const byDay = [...byDayMap.values()]
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
    .map((d) => ({
      ...d,
      pnl: Number(d.pnl.toFixed(2)),
      tradeCount: d.trades.length,
    }));

  const modeNames = {
    sweep_reverse: 'Liquidity Sweep Reverse',
    break_go: 'Liquidity Break & Go',
    sweep_rr: 'Liquidity Sweep R:R',
  };

  return {
    settings,
    trades,
    byDay,
    barCount: bars.length,
    zoneCount: zones.length,
    strategyName: modeNames[settings.mode] || 'Liquidity Strategy',
    strategyKey: `liquidity_${settings.mode}`,
    note: `${settings.mode} · lotSize ${settings.lotSize} · target ${settings.targetMode}`,
  };
}

module.exports = {
  runLiquiditySweepBacktest,
  normalizeRows,
  DEFAULTS,
  mergeSettings,
};

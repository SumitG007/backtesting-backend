/**
 * Lux-style Liquidity Swings (rebuild) — swing highs/lows + wick zones + volume.
 * Candles: [iso, open, high, low, close, volume]
 */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function atr14(rows) {
  if (!Array.isArray(rows) || rows.length < 16) return null;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, rows.length - 14); i < rows.length; i += 1) {
    const h = toNum(rows[i][2]);
    const l = toNum(rows[i][3]);
    const pc = toNum(rows[i - 1][4]);
    if (h == null || l == null || pc == null) continue;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    sum += tr;
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

/**
 * @param {Array} rows candle rows
 * @param {{ length?: number }} opts
 * @returns {{ highs: object[], lows: object[], atr: number|null, lastClose: number|null, lastHigh: number|null, lastLow: number|null }}
 */
function buildLiquiditySwings(rows, opts = {}) {
  const length = Math.max(3, Math.min(40, Math.floor(Number(opts.length) || 14)));
  const highs = [];
  const lows = [];
  if (!Array.isArray(rows) || rows.length < length * 2 + 1) {
    return {
      highs,
      lows,
      atr: atr14(rows),
      lastClose: toNum(rows?.[rows.length - 1]?.[4]),
      lastHigh: toNum(rows?.[rows.length - 1]?.[2]),
      lastLow: toNum(rows?.[rows.length - 1]?.[3]),
      length,
      barCount: Array.isArray(rows) ? rows.length : 0,
    };
  }

  // Confirmed pivots only (need `length` bars on each side) — skip forming bar.
  const end = rows.length - 1 - length;
  for (let i = length; i <= end; i += 1) {
    const o = toNum(rows[i][1]);
    const h = toNum(rows[i][2]);
    const l = toNum(rows[i][3]);
    const c = toNum(rows[i][4]);
    const vol = Math.max(0, toNum(rows[i][5]) || 0);
    if (o == null || h == null || l == null || c == null) continue;

    let isHigh = true;
    let isLow = true;
    for (let j = i - length; j <= i + length; j += 1) {
      if (j === i) continue;
      const hj = toNum(rows[j][2]);
      const lj = toNum(rows[j][3]);
      if (hj != null && hj >= h) isHigh = false;
      if (lj != null && lj <= l) isLow = false;
    }

    if (isHigh) {
      const bodyTop = Math.max(o, c);
      highs.push({
        kind: 'buy_side',
        index: i,
        time: rows[i][0],
        top: h,
        bottom: bodyTop,
        mid: (h + bodyTop) / 2,
        volume: vol,
        broken: false,
      });
    }
    if (isLow) {
      const bodyBot = Math.min(o, c);
      lows.push({
        kind: 'sell_side',
        index: i,
        time: rows[i][0],
        top: bodyBot,
        bottom: l,
        mid: (bodyBot + l) / 2,
        volume: vol,
        broken: false,
      });
    }
  }

  // Mark broken + accumulate volume on later revisits
  for (let i = 0; i < rows.length; i += 1) {
    const h = toNum(rows[i][2]);
    const l = toNum(rows[i][3]);
    const c = toNum(rows[i][4]);
    const vol = Math.max(0, toNum(rows[i][5]) || 0);
    if (c == null) continue;
    for (const z of highs) {
      if (i <= z.index) continue;
      if (c > z.top) z.broken = true;
      else if (h >= z.bottom && l <= z.top) z.volume += vol;
    }
    for (const z of lows) {
      if (i <= z.index) continue;
      if (c < z.bottom) z.broken = true;
      else if (h >= z.bottom && l <= z.top) z.volume += vol;
    }
  }

  // Keep most recent active pools (not ancient)
  const keep = 12;
  const recentHighs = highs.slice(-keep);
  const recentLows = lows.slice(-keep);

  return {
    highs: recentHighs,
    lows: recentLows,
    atr: atr14(rows),
    lastClose: toNum(rows[rows.length - 1][4]),
    lastHigh: toNum(rows[rows.length - 1][2]),
    lastLow: toNum(rows[rows.length - 1][3]),
    lastOpen: toNum(rows[rows.length - 1][1]),
    length,
    barCount: rows.length,
  };
}

/**
 * Detect sweep+break on the last closed 5m bar vs nearest unbroken pool.
 * CE chase: wick into buy-side zone, close above zone top.
 * PE chase: wick into sell-side zone, close below zone bottom.
 * Also surfaces WATCHING / NEAR when price is probing a pool (for live tape ticks).
 */
function detectSweepBreak(swings, opts = {}) {
  const buffer = Math.max(0, Number(opts.breakBufferPts) || 0);
  const close = swings?.lastClose;
  const high = swings?.lastHigh;
  const low = swings?.lastLow;
  const length = Math.max(3, Number(swings?.length) || 14);
  const barCount = Number(swings?.barCount) || 0;
  const needBars = length * 2 + 1;
  const swingsReady = barCount >= needBars && (
    (Array.isArray(swings?.highs) && swings.highs.length > 0)
    || (Array.isArray(swings?.lows) && swings.lows.length > 0)
  );

  if (close == null || high == null || low == null) {
    return {
      status: 'WAIT',
      detail: 'No candle close',
      swingsReady: false,
      barCount,
      needBars,
    };
  }

  if (!swingsReady) {
    return {
      status: 'WAIT',
      detail: `Building swings (${barCount}/${needBars} 5m bars)`,
      swingsReady: false,
      barCount,
      needBars,
    };
  }

  const highs = Array.isArray(swings.highs) ? swings.highs : [];
  const lows = Array.isArray(swings.lows) ? swings.lows : [];

  // Prefer nearest unbroken pools above/below price; also allow freshly broken on this bar
  let cePool = null;
  let ceProbe = null;
  for (let i = highs.length - 1; i >= 0; i -= 1) {
    const z = highs[i];
    const inZone = high >= z.bottom && low <= z.top + 8;
    const swept = high >= z.bottom - 8 && high <= z.top + 12;
    const broke = close > z.top + buffer;
    if (swept && broke) {
      cePool = z;
      break;
    }
    if (!ceProbe && inZone) {
      ceProbe = {
        pool: z,
        swept,
        broke,
        detail: swept
          ? `Buy-side wick · need close > ${z.top.toFixed(1)}`
          : `Probing buy-side pool @ ${z.top.toFixed(1)}`,
      };
    }
  }

  let pePool = null;
  let peProbe = null;
  for (let i = lows.length - 1; i >= 0; i -= 1) {
    const z = lows[i];
    const inZone = low <= z.top && high >= z.bottom - 8;
    const swept = low <= z.top + 8 && low >= z.bottom - 12;
    const broke = close < z.bottom - buffer;
    if (swept && broke) {
      pePool = z;
      break;
    }
    if (!peProbe && inZone) {
      peProbe = {
        pool: z,
        swept,
        broke,
        detail: swept
          ? `Sell-side wick · need close < ${z.bottom.toFixed(1)}`
          : `Probing sell-side pool @ ${z.bottom.toFixed(1)}`,
      };
    }
  }

  if (cePool && pePool) {
    return {
      status: 'CONFLICT',
      detail: 'Both sides swept',
      cePool,
      pePool,
      swingsReady: true,
      barCount,
      needBars,
    };
  }
  if (cePool) {
    const nextTarget = nextOppositePool(highs, lows, 'CE', close);
    return {
      status: 'SWEEP_BREAK',
      side: 'CE',
      pool: cePool,
      stopSpot: cePool.bottom - (Number(opts.slBufferPts) || 8),
      targetSpot: nextTarget?.mid ?? null,
      nextPool: nextTarget,
      detail: `Buy-side sweep+break @ ${cePool.top.toFixed(1)}`,
      swingsReady: true,
      barCount,
      needBars,
    };
  }
  if (pePool) {
    const nextTarget = nextOppositePool(highs, lows, 'PE', close);
    return {
      status: 'SWEEP_BREAK',
      side: 'PE',
      pool: pePool,
      stopSpot: pePool.top + (Number(opts.slBufferPts) || 8),
      targetSpot: nextTarget?.mid ?? null,
      nextPool: nextTarget,
      detail: `Sell-side sweep+break @ ${pePool.bottom.toFixed(1)}`,
      swingsReady: true,
      barCount,
      needBars,
    };
  }

  const probe = ceProbe || peProbe;
  if (probe) {
    return {
      status: probe.swept ? 'NEAR' : 'WATCHING',
      side: ceProbe ? 'CE' : 'PE',
      pool: probe.pool,
      detail: probe.detail,
      swingsReady: true,
      barCount,
      needBars,
      probe: true,
    };
  }

  return {
    status: 'WAIT',
    detail: 'No sweep+break on last bar',
    swingsReady: true,
    barCount,
    needBars,
    highCount: highs.length,
    lowCount: lows.length,
  };
}

function nextOppositePool(highs, lows, side, close) {
  if (side === 'CE') {
    // Next buy-side pool above close
    let best = null;
    for (const z of highs) {
      if (z.mid > close + 5 && (!best || z.mid < best.mid)) best = z;
    }
    return best;
  }
  let best = null;
  for (const z of lows) {
    if (z.mid < close - 5 && (!best || z.mid > best.mid)) best = z;
  }
  return best;
}

module.exports = {
  buildLiquiditySwings,
  detectSweepBreak,
  atr14,
};

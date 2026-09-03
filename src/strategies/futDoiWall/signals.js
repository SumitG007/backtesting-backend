/**
 * FUT ΔOI Wall V1 — signal rules (paper only).
 * Wall from ΔOI only · ADX + 20 DMA permission · FUT 2/3 cluster · Spot SUPPORTIVE/WEAK/FIGHTING.
 */

function roundToStrike(price, step) {
  const s = Math.max(1, Number(step) || 50);
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return Math.round(p / s) * s;
}

function findStrikeRow(strikes, strike) {
  if (!Number.isFinite(strike)) return null;
  const rows = Array.isArray(strikes) ? strikes : [];
  let exact = null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const row of rows) {
    const s = Number(row?.strike);
    if (!Number.isFinite(s)) continue;
    const d = Math.abs(s - strike);
    if (d === 0) {
      exact = row;
      break;
    }
    if (d < nearestDist) {
      nearestDist = d;
      nearest = row;
    }
  }
  return exact || nearest;
}

/**
 * V1 clear wall from ΔOI only.
 * CE/support: Put ΔOI > 0; if Call also > 0 need Put >= ratio × Call.
 * PE/resistance: Call ΔOI > 0; if Put also > 0 need Call >= ratio × Put.
 */
function biasFromRow(row, minOiRatio) {
  if (!row || !Number.isFinite(Number(row.strike))) return null;
  const putChg = Number(row.putChgOi);
  const callChg = Number(row.callChgOi);
  const putOi = Number(row.putOi);
  const callOi = Number(row.callOi);
  if (!Number.isFinite(putChg) || !Number.isFinite(callChg)) return null;

  const ratioNeed = Math.max(1.05, Number(minOiRatio) || 1.5);
  let optionType = null;
  let dominantSide = null;
  let ratio = null;
  let clear = false;

  if (putChg > 0 && callChg > 0) {
    if (putChg >= callChg * ratioNeed) {
      optionType = 'CE';
      dominantSide = 'PUT';
      ratio = putChg / callChg;
      clear = true;
    } else if (callChg >= putChg * ratioNeed) {
      optionType = 'PE';
      dominantSide = 'CALL';
      ratio = callChg / putChg;
      clear = true;
    } else {
      // Fighting — no clear wall
      const putDom = putChg >= callChg;
      optionType = putDom ? 'CE' : 'PE';
      dominantSide = putDom ? 'PUT' : 'CALL';
      ratio = putDom ? putChg / Math.max(callChg, 1) : callChg / Math.max(putChg, 1);
      clear = false;
    }
  } else if (putChg > 0 && callChg <= 0) {
    optionType = 'CE';
    dominantSide = 'PUT';
    ratio = null;
    clear = true;
  } else if (callChg > 0 && putChg <= 0) {
    optionType = 'PE';
    dominantSide = 'CALL';
    ratio = null;
    clear = true;
  } else {
    return null;
  }

  return {
    strike: Number(row.strike),
    dominantSide,
    optionType,
    putOi: Number.isFinite(putOi) ? putOi : null,
    callOi: Number.isFinite(callOi) ? callOi : null,
    putChgOi: putChg,
    callChgOi: callChg,
    ratio: ratio != null ? Number(ratio.toFixed(2)) : null,
    clear,
    oiMass: Math.max(0, putChg) + Math.max(0, callChg),
  };
}

function clusterAround(board, price, step, minOiRatio) {
  const center = roundToStrike(price, step);
  if (!Number.isFinite(center)) return { center: null, strikes: [], biases: [] };
  const strikes = [center - step, center, center + step];
  const biases = strikes.map((s) => biasFromRow(findStrikeRow(board.strikes, s), minOiRatio));
  return { center, strikes, biases };
}

/** Spot wall vs FUT side → SUPPORTIVE | WEAK | FIGHTING */
function classifySpotState(spotCenter, futSide) {
  if (!futSide) return 'WEAK';
  if (!spotCenter || !spotCenter.clear) return 'WEAK';
  if (spotCenter.optionType === futSide) return 'SUPPORTIVE';
  if (spotCenter.optionType && spotCenter.optionType !== futSide) return 'FIGHTING';
  return 'WEAK';
}

/** 1 strike ITM from ATM. */
function oneItmStrike(atm, optionType, step) {
  const a = Number(atm);
  const s = Math.max(1, Number(step) || 50);
  if (!Number.isFinite(a)) return null;
  if (optionType === 'PE') return a + s;
  return a - s;
}

/**
 * Build live signal from OI board + trend context (ADX / DMA).
 * trend: { adx, dma, futPrice, skipReason? }
 */
function buildSignalFromBoard(board, settings, trend = {}) {
  const minOiRatio = Math.max(1.05, Number(settings.minOiRatio) || 1.5);
  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || 20);
  const entryDistance = Math.max(3, Number(settings.entryDistancePoints) || 10);
  const adxEntry = Math.max(10, Number(settings.adxEntryThreshold) || 25);
  const adxWatch = Math.max(5, Number(settings.adxWatchThreshold) || 20);

  if (!board?.strikes?.length) {
    return {
      status: 'WAIT',
      optionType: null,
      buyLive: false,
      detail: 'No board',
      skipReason: 'NO_BOARD',
    };
  }

  const step = Math.max(1, Number(board.strikeStep) || 50);
  const fut = Number(trend.futPrice ?? board.fut ?? board.spot);
  const spotCash = Number(board.chainSpot);
  const spotPrice = Number.isFinite(spotCash) && spotCash > 0 ? spotCash : fut;
  const atm = Number(board.atm) || roundToStrike(fut, step);
  const adx = Number(trend.adx);
  const dma = Number(trend.dma);

  const futCluster = clusterAround(board, fut, step, minOiRatio);
  const spotCluster = clusterAround(board, spotPrice, step, minOiRatio);
  const futCenter = futCluster.biases[1] || null;
  const spotCenter = spotCluster.biases[1] || null;

  const base = {
    levelStrike: futCenter?.strike ?? futCluster.center,
    entryStrike: null,
    fut: Number.isFinite(fut) ? fut : null,
    spotCash: Number.isFinite(spotCash) ? spotCash : null,
    atm,
    adx: Number.isFinite(adx) ? Number(adx.toFixed(2)) : null,
    dma: Number.isFinite(dma) ? Number(dma.toFixed(2)) : null,
    ratio: futCenter?.ratio ?? null,
    putChgOi: futCenter?.putChgOi ?? null,
    callChgOi: futCenter?.callChgOi ?? null,
    futAgree: null,
    spotState: null,
    clusterDetail: null,
    distance: null,
  };

  // --- ADX permission ---
  if (!Number.isFinite(adx)) {
    return {
      ...base,
      status: 'WATCHING',
      optionType: null,
      buyLive: false,
      detail: 'ADX unavailable — waiting for FUT bars',
      skipReason: 'ADX_UNAVAILABLE',
    };
  }
  if (adx < adxWatch) {
    return {
      ...base,
      status: 'WATCHING',
      optionType: null,
      buyLive: false,
      detail: `ADX ${adx.toFixed(1)} < ${adxWatch} — range / no entry`,
      skipReason: 'ADX_LOW',
    };
  }
  if (adx < adxEntry) {
    return {
      ...base,
      status: 'WATCHING',
      optionType: null,
      buyLive: false,
      detail: `ADX ${adx.toFixed(1)} in ${adxWatch}–${adxEntry} band — watch only`,
      skipReason: 'ADX_LOW',
    };
  }

  // --- 20 DMA side ---
  if (!Number.isFinite(dma) || !Number.isFinite(fut)) {
    return {
      ...base,
      status: 'WATCHING',
      optionType: null,
      buyLive: false,
      detail: '20 DMA unavailable',
      skipReason: 'DMA_NO_SIDE',
    };
  }
  let dmaSide = null;
  if (fut > dma) dmaSide = 'CE';
  else if (fut < dma) dmaSide = 'PE';
  else {
    return {
      ...base,
      status: 'WATCHING',
      optionType: null,
      buyLive: false,
      detail: 'FUT = 20 DMA — no side',
      skipReason: 'DMA_NO_SIDE',
    };
  }

  if (!futCenter?.clear) {
    const fighting =
      futCenter
      && Number(futCenter.putChgOi) > 0
      && Number(futCenter.callChgOi) > 0
      && !futCenter.clear;
    return {
      ...base,
      status: fighting ? 'CONFLICT' : 'CAUTION',
      optionType: futCenter?.optionType || null,
      buyLive: false,
      detail: fighting
        ? `Wall fighting · need ≥${minOiRatio}× clear ΔOI`
        : 'FUT center wall weak / no positive own-side ΔOI',
      skipReason: fighting ? 'WALL_FIGHTING' : 'WALL_WEAK',
    };
  }

  if (futCenter.optionType !== dmaSide) {
    return {
      ...base,
      status: 'CONFLICT',
      optionType: null,
      buyLive: false,
      detail: `Wall ${futCenter.optionType} vs DMA side ${dmaSide}`,
      skipReason: 'WALL_DMA_CONFLICT',
      dmaSide,
    };
  }

  const side = futCenter.optionType;
  const futAgree = futCluster.biases.filter((b) => b && b.optionType === side && b.clear).length;
  const futSoftAgree = futCluster.biases.filter((b) => b && b.optionType === side).length;
  base.futAgree = futAgree;
  base.clusterDetail = `FUT ${futAgree}/3 clear ${side}`;

  if (futAgree < 2 || futSoftAgree < 2) {
    return {
      ...base,
      status: 'CAUTION',
      optionType: side,
      buyLive: false,
      dominantSide: futCenter.dominantSide,
      detail: `FUT cluster ${futAgree}/3 — need ≥2/3 ${side}`,
      skipReason: 'CLUSTER_FAIL',
    };
  }

  const spotState = classifySpotState(spotCenter, side);
  base.spotState = spotState;
  if (spotState === 'FIGHTING') {
    return {
      ...base,
      status: 'CONFLICT',
      optionType: side,
      buyLive: false,
      dominantSide: futCenter.dominantSide,
      detail: `Spot FIGHTING (${spotCenter.optionType} vs FUT ${side})`,
      skipReason: 'SPOT_FIGHTING',
    };
  }

  const distance = Number.isFinite(fut) && Number.isFinite(futCenter.strike)
    ? Math.round(Math.abs(fut - futCenter.strike))
    : null;
  base.distance = distance;
  base.spotDist = distance;
  base.entryStrike = oneItmStrike(atm, side, step);

  if (distance == null || distance > proximityPoints) {
    return {
      ...base,
      status: 'WATCHING',
      optionType: side,
      buyLive: false,
      dominantSide: futCenter.dominantSide,
      detail: `Setup ready · FUT ${distance ?? '—'} pts from wall (NEAR ≤${proximityPoints})`,
      skipReason: 'TOO_FAR',
      dmaSide,
    };
  }

  if (distance > entryDistance) {
    return {
      ...base,
      status: 'NEAR',
      optionType: side,
      buyLive: false,
      dominantSide: futCenter.dominantSide,
      detail: `NEAR wall · Spot ${spotState} · cluster ${futAgree}/3 · wait ≤${entryDistance} pts`,
      skipReason: null,
      dmaSide,
    };
  }

  return {
    ...base,
    status: 'TAKE_ENTRY',
    optionType: side,
    buyLive: true,
    dominantSide: futCenter.dominantSide,
    putOi: futCenter.putOi,
    callOi: futCenter.callOi,
    detail: `TAKE ENTRY ${side} 1ITM ${base.entryStrike} · Spot ${spotState} · ${futAgree}/3 · ADX ${adx.toFixed(1)}`,
    skipReason: null,
    dmaSide,
  };
}

module.exports = {
  biasFromRow,
  clusterAround,
  classifySpotState,
  oneItmStrike,
  buildSignalFromBoard,
  roundToStrike,
  findStrikeRow,
};

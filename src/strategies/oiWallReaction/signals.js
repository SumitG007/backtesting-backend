/**
 * OI Wall Reaction — OI wall map + price reaction at touch + sentiment confirm.
 *
 * Note: Call/Put "Match" on the same bar is structurally rare/impossible
 * (same price move → opposite act tones). Confirmation uses:
 *   supportive act for direction + sentiment streak + price hold/reject.
 */
const { findOiWalls } = require('../../utils/oiFlowStrikeAnalytics');
const { computeBuildupOverall, enrichMinuteBars } = require('../../utils/oiFlowActs');

/** Acts that support a CE bounce (spot holding PE wall). */
function supportsCeBounce(bar) {
  const call = bar?.callAct?.label;
  const put = bar?.putAct?.label;
  return call === 'Long build' || call === 'Short cover' || put === 'Writing';
}

/** Acts that support a PE rejection (spot rejecting CE wall). */
function supportsPeReject(bar) {
  const call = bar?.callAct?.label;
  const put = bar?.putAct?.label;
  return call === 'Writing' || put === 'Buying' || put === 'Short cover';
}

function buildSignalFromOiFlow(tape, settings = {}, opts = {}) {
  const tradedToday = Boolean(opts.tradedToday);
  const proximity = Math.max(5, Number(settings.proximityPoints) || 20);
  const minWallRatio = Math.max(1.5, Number(settings.minWallRatio) || 2);
  const confirmBars = Math.max(1, Math.floor(Number(settings.matchBarsRequired) || 2));
  const minStreak = Math.max(1, Math.floor(Number(settings.minStreak) || 3));
  const skipWritingPin = settings.skipWritingPin !== false;

  const displayRow = tape?.displayRow || tape?.lastRow || null;
  const rows = Array.isArray(tape?.rows) ? tape.rows : [];
  const spot = Number(displayRow?.spotPrice);
  const atm = Number(displayRow?.atm);
  const strikes = displayRow?.strikes || [];

  const base = {
    spot: Number.isFinite(spot) ? spot : null,
    atm: Number.isFinite(atm) ? atm : null,
    optionType: null,
    buyLive: false,
    levelStrike: null,
    entryStrike: Number.isFinite(atm) ? atm : null,
    wallDist: null,
    sessionBias: null,
    dominantAct: null,
    confirmBars: 0,
    matchBars: 0,
    streak: 0,
    peWall: null,
    ceWall: null,
  };

  if (tradedToday) {
    return {
      ...base,
      status: 'DONE',
      detail: '1 trade finished today — no re-entry until next session',
    };
  }

  if (!displayRow?.fetchOk || !Number.isFinite(spot) || !strikes.length) {
    return {
      ...base,
      status: 'WAIT',
      detail: 'Waiting for OI Flow minute data…',
    };
  }

  const buildup = computeBuildupOverall(rows, displayRow);
  const walls = findOiWalls(strikes, spot, { minOiRatio: minWallRatio });
  const enriched = enrichMinuteBars(rows, displayRow);
  const latest = enriched[0] || null;

  base.sessionBias = buildup.overall.text;
  base.dominantAct = buildup.dominantAct;
  base.peWall = walls.peWall
    ? { strike: walls.peWall.strike, ratio: walls.peWall.ratio, dist: walls.peWall.dist }
    : null;
  base.ceWall = walls.ceWall
    ? { strike: walls.ceWall.strike, ratio: walls.ceWall.ratio, dist: walls.ceWall.dist }
    : null;
  base.callAct = latest?.callAct?.label;
  base.putAct = latest?.putAct?.label;
  base.streak = latest?.streak || 0;

  if (walls.peWall && walls.ceWall) {
    const distPe = spot - walls.peWall.strike;
    const distCe = walls.ceWall.strike - spot;
    if (distPe > proximity && distCe > proximity) {
      return {
        ...base,
        status: 'WATCHING',
        detail: `Mid-range (${Math.round(distPe)} / ${Math.round(distCe)} pts from walls) — wait for touch`,
      };
    }
  }

  let setup = null;

  if (walls.peWall?.clear && buildup.overall.text === 'Bull') {
    const dist = spot - walls.peWall.strike;
    if (dist >= 0 && dist <= proximity) {
      setup = {
        optionType: 'CE',
        wall: walls.peWall,
        side: 'PE bounce',
        needTone: 'bull',
        wallDist: dist,
        supports: supportsCeBounce,
      };
    }
  }

  if (!setup && walls.ceWall?.clear && buildup.overall.text === 'Bear') {
    const dist = walls.ceWall.strike - spot;
    if (dist >= 0 && dist <= proximity) {
      setup = {
        optionType: 'PE',
        wall: walls.ceWall,
        side: 'CE reject',
        needTone: 'bear',
        wallDist: dist,
        supports: supportsPeReject,
      };
    }
  }

  if (!setup) {
    const hints = [];
    if (walls.peWall?.clear && buildup.overall.text === 'Bull') {
      hints.push(`PE wall ${walls.peWall.strike} (${Math.round(Math.abs(walls.peWall.dist || 0))} pts)`);
    }
    if (walls.ceWall?.clear && buildup.overall.text === 'Bear') {
      hints.push(`CE wall ${walls.ceWall.strike} (${Math.round(Math.abs(walls.ceWall.dist || 0))} pts)`);
    }
    return {
      ...base,
      status: 'WATCHING',
      detail: hints.length
        ? `Bias ${buildup.overall.text} — near wall needed: ${hints.join(' · ')}`
        : `Session ${buildup.overall.text} — no aligned wall touch yet`,
    };
  }

  if (skipWritingPin && setup.optionType === 'CE' && buildup.dominantAct === 'Writing') {
    return {
      ...base,
      status: 'CONFLICT',
      detail: 'Writing-dominant day — skip CE bounce (pin risk)',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
    };
  }

  const spotDelta = Number(latest?.spotDelta);
  if (setup.optionType === 'CE' && Number.isFinite(spotDelta) && spotDelta < 0) {
    return {
      ...base,
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      detail: `At PE wall ${setup.wall.strike} — need price hold/bounce (Δ ${spotDelta.toFixed(1)})`,
    };
  }
  if (setup.optionType === 'PE' && Number.isFinite(spotDelta) && spotDelta > 0) {
    return {
      ...base,
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      detail: `At CE wall ${setup.wall.strike} — need rejection (Δ +${spotDelta.toFixed(1)})`,
    };
  }

  const recent = enriched.slice(0, confirmBars);
  const confirmOk =
    recent.length >= confirmBars
    && recent.every(
      (b) => b.sentiment.tone === setup.needTone && setup.supports(b),
    );
  base.confirmBars = recent.filter(
    (b) => b.sentiment.tone === setup.needTone && setup.supports(b),
  ).length;
  base.matchBars = base.confirmBars;

  if (!confirmOk) {
    return {
      ...base,
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      detail: `Wall touch OK · need ${confirmBars}× ${setup.needTone} supportive bars (${base.confirmBars}/${confirmBars})`,
    };
  }

  if ((latest?.streak || 0) < minStreak) {
    return {
      ...base,
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      detail: `Confirm OK · streak ${latest?.streakLabel || 0} (need ${minStreak})`,
    };
  }

  return {
    ...base,
    status: 'TAKE_ENTRY',
    optionType: setup.optionType,
    buyLive: true,
    levelStrike: setup.wall.strike,
    wallDist: Number(setup.wallDist.toFixed(1)),
    ratio: setup.wall.ratio,
    dominantSide: setup.wall.dominantSide,
    detail: `${setup.side} · wall ${setup.wall.strike} (${setup.wall.ratio}×) · confirm×${confirmBars} · ${latest?.streakLabel}`,
    priceReaction: Number.isFinite(spotDelta) ? spotDelta : null,
  };
}

module.exports = {
  buildSignalFromOiFlow,
  supportsCeBounce,
  supportsPeReject,
};

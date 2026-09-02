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

function check(id, name, short, ok, value, need, note) {
  return { id, name, short, ok: Boolean(ok), value, need, note };
}

function buildChecks({
  peWall,
  ceWall,
  sessionBias,
  dominantAct,
  setup,
  wallDist,
  ratio,
  proximity,
  minWallRatio,
  confirmCount,
  confirmBars,
  confirmOk,
  streak,
  minStreak,
  priceOk,
  priceNote,
  pinOk,
  pinNote,
}) {
  const wall = setup?.wall || null;
  const wallSide = setup?.optionType === 'CE' ? 'PE' : setup?.optionType === 'PE' ? 'CE' : null;
  const wallOk = Boolean(wall?.clear && Number(wall.ratio) >= minWallRatio);
  const sessionOk = Boolean(
    (setup?.optionType === 'CE' && sessionBias === 'Bull')
    || (setup?.optionType === 'PE' && sessionBias === 'Bear')
    || (!setup && (sessionBias === 'Bull' || sessionBias === 'Bear')),
  );
  const proxOk = Number.isFinite(wallDist) && wallDist >= 0 && wallDist <= proximity;
  const peRatio = peWall?.ratio != null ? `${peWall.ratio}×` : '—';
  const ceRatio = ceWall?.ratio != null ? `${ceWall.ratio}×` : '—';

  return [
    check(
      'wall',
      'OI wall',
      'Wall',
      wallOk || Boolean(peWall?.clear || ceWall?.clear),
      wall
        ? `${wall.strike} · ${Number(wall.ratio).toFixed(2)}×`
        : `PE ${peRatio} · CE ${ceRatio}`,
      `≥ ${minWallRatio}× clear`,
      wall
        ? `${wallSide} wall for ${setup.optionType}`
        : peWall?.clear || ceWall?.clear
          ? 'Walls present — need bias + touch'
          : 'No clear OI wall yet',
    ),
    check(
      'session',
      'Session bias',
      'Bias',
      setup ? sessionOk : sessionBias === 'Bull' || sessionBias === 'Bear',
      sessionBias || '—',
      'Bull→CE / Bear→PE',
      dominantAct && dominantAct !== '—'
        ? `Dominant ${dominantAct}`
        : 'Need Bull for PE bounce or Bear for CE reject',
    ),
    check(
      'prox',
      'Spot distance to wall',
      'Dist',
      proxOk,
      Number.isFinite(wallDist) ? `${Math.round(wallDist)} pts` : '—',
      `≤ ${proximity} pts`,
      Number.isFinite(wallDist)
        ? proxOk
          ? 'At wall — ready for reaction'
          : 'Too far — wait for touch'
        : 'Waiting for wall touch',
    ),
    check(
      'price',
      'Price hold / reject',
      'Price',
      priceOk,
      priceNote?.value || '—',
      setup?.optionType === 'CE' ? 'Hold / bounce (Δ ≥ 0)' : setup?.optionType === 'PE' ? 'Reject (Δ ≤ 0)' : 'Reaction at wall',
      priceNote?.note || 'Need price reaction at wall',
    ),
    check(
      'confirm',
      'Supportive bars',
      'Confirm',
      confirmOk,
      `${confirmCount}/${confirmBars}`,
      `${confirmBars}× supportive`,
      confirmOk ? 'Acts + tone aligned' : 'Need supportive act + matching tone',
    ),
    check(
      'streak',
      'Sentiment streak',
      'Streak',
      Number(streak) >= minStreak,
      String(streak || 0),
      `≥ ${minStreak}`,
      Number(streak) >= minStreak ? 'Streak strong enough' : 'Streak still building',
    ),
    check(
      'pin',
      'Writing pin risk',
      'Pin',
      pinOk,
      dominantAct || '—',
      'Skip Writing → CE',
      pinNote || 'OK',
    ),
  ];
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

  const emptyChecks = () =>
    buildChecks({
      peWall: null,
      ceWall: null,
      sessionBias: null,
      dominantAct: null,
      setup: null,
      wallDist: null,
      ratio: null,
      proximity,
      minWallRatio,
      confirmCount: 0,
      confirmBars,
      confirmOk: false,
      streak: 0,
      minStreak,
      priceOk: false,
      priceNote: { value: '—', note: 'Waiting for data' },
      pinOk: true,
      pinNote: '—',
    });

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
    checks: emptyChecks(),
    headline: null,
    why: null,
  };

  if (tradedToday) {
    return {
      ...base,
      status: 'DONE',
      detail: '1 trade finished today — no re-entry until next session',
      headline: 'Done for today',
      why: '1 trade finished — no re-entry until next session',
    };
  }

  if (!displayRow?.fetchOk || !Number.isFinite(spot) || !strikes.length) {
    return {
      ...base,
      status: 'WAIT',
      detail: 'Waiting for OI Flow minute data…',
      headline: 'Waiting for tape',
      why: 'OI Flow minute data not ready yet',
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

  const pack = (extra) => {
    const setup = extra.setup || null;
    const wallDist = extra.wallDist != null ? extra.wallDist : setup?.wallDist ?? null;
    const confirmCount = extra.confirmCount ?? 0;
    const confirmOk = Boolean(extra.confirmOk);
    const priceOk = Boolean(extra.priceOk);
    const pinOk = extra.pinOk !== false;
    const checks = buildChecks({
      peWall: walls.peWall,
      ceWall: walls.ceWall,
      sessionBias: buildup.overall.text,
      dominantAct: buildup.dominantAct,
      setup,
      wallDist,
      ratio: setup?.wall?.ratio ?? extra.ratio,
      proximity,
      minWallRatio,
      confirmCount,
      confirmBars,
      confirmOk,
      streak: latest?.streak || 0,
      minStreak,
      priceOk,
      priceNote: extra.priceNote || { value: '—', note: 'Need price reaction at wall' },
      pinOk,
      pinNote: extra.pinNote,
    });
    const { setup: _s, confirmCount: _c, confirmOk: _co, priceOk: _p, priceNote: _pn, pinOk: _po, pinNote: _pin, ...rest } = extra;
    return {
      ...base,
      ...rest,
      wallDist: Number.isFinite(wallDist) ? Number(Number(wallDist).toFixed(1)) : wallDist,
      checks,
    };
  };

  if (walls.peWall && walls.ceWall) {
    const distPe = spot - walls.peWall.strike;
    const distCe = walls.ceWall.strike - spot;
    if (distPe > proximity && distCe > proximity) {
      return pack({
        status: 'WATCHING',
        detail: `Mid-range (${Math.round(distPe)} / ${Math.round(distCe)} pts from walls) — wait for touch`,
        headline: 'Mid-range',
        why: `PE wall ${Math.round(distPe)} pts · CE wall ${Math.round(distCe)} pts — wait for touch`,
        priceOk: false,
        priceNote: { value: 'Far', note: 'Spot between walls' },
      });
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
    return pack({
      status: 'WATCHING',
      detail: hints.length
        ? `Bias ${buildup.overall.text} — near wall needed: ${hints.join(' · ')}`
        : `Session ${buildup.overall.text} — no aligned wall touch yet`,
      headline: 'Watching',
      why: hints.length
        ? `Bias ${buildup.overall.text} — near wall needed: ${hints.join(' · ')}`
        : `Session ${buildup.overall.text} — no aligned wall touch yet`,
      priceOk: false,
      priceNote: { value: '—', note: 'No aligned wall touch yet' },
    });
  }

  if (skipWritingPin && setup.optionType === 'CE' && buildup.dominantAct === 'Writing') {
    return pack({
      status: 'CONFLICT',
      detail: 'Writing-dominant day — skip CE bounce (pin risk)',
      headline: `Skip CE · ${setup.wall.strike}`,
      why: 'Writing-dominant day — pin risk on CE bounce',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      setup,
      pinOk: false,
      pinNote: 'Writing-dominant — skip CE',
      priceOk: false,
      priceNote: { value: '—', note: 'Blocked by pin filter' },
    });
  }

  const spotDelta = Number(latest?.spotDelta);
  const deltaLabel = Number.isFinite(spotDelta)
    ? `${spotDelta >= 0 ? '+' : ''}${spotDelta.toFixed(1)}`
    : '—';

  if (setup.optionType === 'CE' && Number.isFinite(spotDelta) && spotDelta < 0) {
    return pack({
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      setup,
      headline: `Armed CE · ${setup.wall.strike}`,
      why: `At PE wall — need price hold/bounce (Δ ${deltaLabel})`,
      detail: `At PE wall ${setup.wall.strike} — need price hold/bounce (Δ ${spotDelta.toFixed(1)})`,
      priceOk: false,
      priceNote: { value: deltaLabel, note: 'Still selling into PE wall' },
      pinOk: true,
    });
  }
  if (setup.optionType === 'PE' && Number.isFinite(spotDelta) && spotDelta > 0) {
    return pack({
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      setup,
      headline: `Armed PE · ${setup.wall.strike}`,
      why: `At CE wall — need rejection (Δ ${deltaLabel})`,
      detail: `At CE wall ${setup.wall.strike} — need rejection (Δ +${spotDelta.toFixed(1)})`,
      priceOk: false,
      priceNote: { value: deltaLabel, note: 'Still buying into CE wall' },
      pinOk: true,
    });
  }

  const recent = enriched.slice(0, confirmBars);
  const confirmOk =
    recent.length >= confirmBars
    && recent.every(
      (b) => b.sentiment.tone === setup.needTone && setup.supports(b),
    );
  const confirmCount = recent.filter(
    (b) => b.sentiment.tone === setup.needTone && setup.supports(b),
  ).length;
  base.confirmBars = confirmCount;
  base.matchBars = confirmCount;

  const priceOk = !Number.isFinite(spotDelta)
    || (setup.optionType === 'CE' && spotDelta >= 0)
    || (setup.optionType === 'PE' && spotDelta <= 0);

  if (!confirmOk) {
    return pack({
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      setup,
      confirmCount,
      confirmOk: false,
      headline: `Armed ${setup.optionType} · ${setup.wall.strike}`,
      why: `Wall touch OK · need ${confirmBars}× ${setup.needTone} supportive bars (${confirmCount}/${confirmBars})`,
      detail: `Wall touch OK · need ${confirmBars}× ${setup.needTone} supportive bars (${confirmCount}/${confirmBars})`,
      priceOk,
      priceNote: {
        value: deltaLabel,
        note: priceOk ? 'Price reaction OK' : 'Waiting for hold/reject',
      },
      pinOk: true,
    });
  }

  if ((latest?.streak || 0) < minStreak) {
    return pack({
      status: 'ARMED',
      optionType: setup.optionType,
      levelStrike: setup.wall.strike,
      wallDist: setup.wallDist,
      ratio: setup.wall.ratio,
      setup,
      confirmCount,
      confirmOk: true,
      headline: `Armed ${setup.optionType} · ${setup.wall.strike}`,
      why: `Confirm OK · streak ${latest?.streakLabel || 0} (need ${minStreak})`,
      detail: `Confirm OK · streak ${latest?.streakLabel || 0} (need ${minStreak})`,
      priceOk,
      priceNote: { value: deltaLabel, note: 'Price reaction OK' },
      pinOk: true,
    });
  }

  return pack({
    status: 'TAKE_ENTRY',
    optionType: setup.optionType,
    buyLive: true,
    levelStrike: setup.wall.strike,
    wallDist: setup.wallDist,
    ratio: setup.wall.ratio,
    dominantSide: setup.wall.dominantSide,
    setup,
    confirmCount,
    confirmOk: true,
    headline: `Buy ${setup.optionType} · ${setup.wall.strike}`,
    why: `${setup.side} · wall ${setup.wall.strike} (${setup.wall.ratio}×) · confirm×${confirmBars} · ${latest?.streakLabel}`,
    detail: `${setup.side} · wall ${setup.wall.strike} (${setup.wall.ratio}×) · confirm×${confirmBars} · ${latest?.streakLabel}`,
    priceReaction: Number.isFinite(spotDelta) ? spotDelta : null,
    priceOk: true,
    priceNote: { value: deltaLabel, note: 'Hold/reject confirmed' },
    pinOk: true,
  });
}

module.exports = {
  buildSignalFromOiFlow,
  supportsCeBounce,
  supportsPeReject,
};

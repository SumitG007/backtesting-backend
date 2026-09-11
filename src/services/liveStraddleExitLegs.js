/**
 * Persist per-leg exit premiums on short-straddle paper closes (CE/PE buyback).
 */

function legEntry(trade, optionType) {
  const leg = trade?.legs?.find((l) => l.optionType === optionType);
  return Number(leg?.entryPremium);
}

function resolveCePeExit(mark, safeExitCombined, trade) {
  let ceExit = Number(mark?.ce);
  let peExit = Number(mark?.pe);
  const ceEntry = legEntry(trade, 'CE');
  const peEntry = legEntry(trade, 'PE');
  const entrySum =
    Number.isFinite(ceEntry) && ceEntry > 0 && Number.isFinite(peEntry) && peEntry > 0
      ? ceEntry + peEntry
      : 0;

  if (Number.isFinite(ceExit) && ceExit > 0 && Number.isFinite(peExit) && peExit > 0) {
    return { ceExit: Number(ceExit.toFixed(2)), peExit: Number(peExit.toFixed(2)) };
  }

  if (entrySum > 0) {
    if (!Number.isFinite(ceExit) || ceExit <= 0) {
      ceExit = safeExitCombined * (ceEntry / entrySum);
    }
    if (!Number.isFinite(peExit) || peExit <= 0) {
      peExit = safeExitCombined * (peEntry / entrySum);
    }
    return { ceExit: Number(ceExit.toFixed(2)), peExit: Number(peExit.toFixed(2)) };
  }

  if (Number.isFinite(ceExit) && ceExit > 0) {
    peExit = Math.max(0.05, safeExitCombined - ceExit);
    return { ceExit: Number(ceExit.toFixed(2)), peExit: Number(peExit.toFixed(2)) };
  }
  if (Number.isFinite(peExit) && peExit > 0) {
    ceExit = Math.max(0.05, safeExitCombined - peExit);
    return { ceExit: Number(ceExit.toFixed(2)), peExit: Number(peExit.toFixed(2)) };
  }

  const half = Number((safeExitCombined / 2).toFixed(2));
  return { ceExit: half, peExit: Number((safeExitCombined - half).toFixed(2)) };
}

function upsertNoteKey(notes, key, value) {
  const base = String(notes || '').trim();
  const piece = `${key}=${value}`;
  const re = new RegExp(`${key}=[^;]+`);
  if (re.test(base)) return base.replace(re, piece);
  return base ? `${base}; ${piece}` : piece;
}

function applyExitLegPremiums(trade, mark, safeExitCombined) {
  const { ceExit, peExit } = resolveCePeExit(mark, safeExitCombined, trade);

  if (Array.isArray(trade.legs) && trade.legs.length) {
    trade.legs = trade.legs.map((leg) => {
      if (leg.optionType === 'CE') return { ...leg, exitPremium: ceExit };
      if (leg.optionType === 'PE') return { ...leg, exitPremium: peExit };
      return leg;
    });
    trade.markModified('legs');
  }

  trade.notes = upsertNoteKey(trade.notes, 'ceExit', ceExit.toFixed(2));
  trade.notes = upsertNoteKey(trade.notes, 'peExit', peExit.toFixed(2));
  return { ceExit, peExit };
}

module.exports = { applyExitLegPremiums, resolveCePeExit };

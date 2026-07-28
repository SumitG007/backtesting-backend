/**
 * Cross-check PRESET_SYMBOLS for OPTSTK/OPTIDX + FUT + option expiry + OI.
 * Writes progress to tmp/universe-chain-check.json (resumable).
 * Usage: node src/scripts/checkUniverseOptionChains.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { PRESET_SYMBOLS } = require('../config/constants');
const { hydrateDhanTokenFromMongo } = require('../services/dhanTokenPersistence');
const {
  buildStockUnderlyingMeta,
  getNearestWeeklyExpiry,
  getOptionChainOiSnapshot,
  listFutureExpiries,
  getFutureLtp,
} = require('../services/dhanLiveService');
const { getDhanClientId } = require('../services/dhanTokenStore');
const { readLatestAccessToken } = require('../services/tokenService');

const SYMBOLS = Object.keys(PRESET_SYMBOLS);
const OUT = path.resolve(__dirname, '..', '..', 'tmp', 'universe-chain-check.json');
const GAP_MS = 4500;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadProgress() {
  try {
    if (!fs.existsSync(OUT)) return {};
    return JSON.parse(fs.readFileSync(OUT, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveProgress(map) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('No Mongo URI');
  await mongoose.connect(uri);
  await hydrateDhanTokenFromMongo();
  console.log('Dhan creds:', Boolean(readLatestAccessToken()), Boolean(getDhanClientId()));

  const optMeta = await buildStockUnderlyingMeta('OPTSTK');
  const bySym = new Map(optMeta.map((r) => [r.symbol, r]));
  console.log('OPTSTK master underlyings:', optMeta.length);

  const progress = loadProgress();
  const done = Object.keys(progress).filter((s) => progress[s] && progress[s].done).length;
  console.log(`Resuming: ${done}/${SYMBOLS.length} already checked`);

  for (const sym of SYMBOLS) {
    if (progress[sym]?.done) {
      console.log(`SKIP ${sym} (cached ${progress[sym].ok ? 'OK' : 'FAIL'})`);
      continue;
    }

    const preset = PRESET_SYMBOLS[sym];
    const row = {
      symbol: sym,
      kind: preset.instrument,
      securityId: preset.securityId,
      done: false,
      ok: false,
    };

    try {
      if (preset.instrument === 'EQUITY') {
        const m = bySym.get(sym);
        if (!m) throw new Error('not in OPTSTK master');
        row.masterSid = m.underlyingSecurityId;
        row.lotSize = m.lotSize;
        row.masterExpiry = m.nearestExpiry;
        if (String(m.underlyingSecurityId || '') !== String(preset.securityId)) {
          throw new Error(`securityId mismatch master=${m.underlyingSecurityId}`);
        }
      }

      const futs = await listFutureExpiries(sym);
      row.futCount = futs.length;
      row.futExpiry = futs[0]?.expiry || null;
      if (!futs.length) throw new Error('no FUT contracts');

      try {
        const { ltp } = await getFutureLtp({ symbol: sym, expiry: futs[0].expiry });
        row.futLtp = ltp;
      } catch (e) {
        row.futLtpError = String(e.message || e).slice(0, 120);
      }

      await sleep(GAP_MS);
      const expiry = await getNearestWeeklyExpiry(sym);
      row.optExpiry = expiry;
      if (!expiry) throw new Error('no option expiry from Dhan');

      await sleep(GAP_MS);
      const snap = await getOptionChainOiSnapshot({
        symbol: sym,
        expiry,
        spotOverride: Number.isFinite(row.futLtp) ? row.futLtp : undefined,
        lookaroundStrikes: 8,
      });
      const strikes = Array.isArray(snap?.strikes) ? snap.strikes : [];
      row.strikeCount = strikes.length;
      const oiSum = strikes.reduce(
        (a, s) => a + (Number(s.callOi) || 0) + (Number(s.putOi) || 0),
        0,
      );
      row.oiSum = oiSum;
      row.callOi = snap?.totals?.callOi ?? null;
      row.putOi = snap?.totals?.putOi ?? null;
      if (!(strikes.length > 0 && oiSum > 0)) {
        throw new Error(`chain empty / zero OI (strikes=${strikes.length})`);
      }
      row.ok = true;
    } catch (e) {
      row.ok = false;
      row.error = e.message || String(e);
    }

    row.done = true;
    row.at = new Date().toISOString();
    progress[sym] = row;
    saveProgress(progress);

    console.log(
      [
        row.ok ? 'OK' : 'FAIL',
        sym,
        `exp=${row.optExpiry || '-'}`,
        `strikes=${row.strikeCount || 0}`,
        `oi=${row.oiSum != null ? row.oiSum : '-'}`,
        row.error || '',
      ].join(' | '),
    );
  }

  const rows = SYMBOLS.map((s) => progress[s]).filter(Boolean);
  const ok = rows.filter((r) => r.ok);
  const fail = rows.filter((r) => !r.ok);
  console.log('\n==== SUMMARY ====');
  console.log(`OK ${ok.length} / ${rows.length}`);
  if (fail.length) {
    console.log('FAIL:');
    for (const f of fail) console.log(` - ${f.symbol}: ${f.error}`);
  }
  console.log('Saved:', OUT);
  await mongoose.disconnect();
  process.exit(fail.length ? 2 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

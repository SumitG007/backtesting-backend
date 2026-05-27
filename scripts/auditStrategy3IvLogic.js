/**
 * Audit Strategy 3 (IV mean reversion) — re-derive entry/exit on sample days vs backtest output.
 * Run: node scripts/auditStrategy3IvLogic.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getIstClock } = require('../src/utils/dateTime');
const {
  runIvMeanReversionBacktest,
} = require('../src/strategies/strategy5/ivMeanReversionBacktest');
const { fetchWithRateLimitRetry } = require('../src/services/dhanDataService');

const M915 = 555;
const M945 = 585;
const M1000 = 600;
const M1100 = 660;

function orIvProxy(bars) {
  let hi = -Infinity;
  let lo = Infinity;
  let n = 0;
  for (const c of bars) {
    const m = getIstClock(c[0]).minutes;
    if (m < M915 || m > M945) continue;
    const h = Number(c[2]);
    const l = Number(c[3]);
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    hi = Math.max(hi, h);
    lo = Math.min(lo, l);
    n += 1;
  }
  if (n < 2 || !Number.isFinite(hi)) return null;
  return hi - lo;
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function buildIntradayByDay(rows) {
  const m = new Map();
  for (const c of rows) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < M915 || clock.minutes > 930) continue;
    if (!m.has(clock.dateKey)) m.set(clock.dateKey, []);
    m.get(clock.dateKey).push(c);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  }
  return m;
}

function auditOneTrade(trade, intraByDay, sortedKeys, settings) {
  const dayKey = getIstClock(trade.entryTime).dateKey;
  const dayBars = intraByDay.get(dayKey) || [];
  const i = sortedKeys.indexOf(dayKey);
  const orIvByDay = new Map();
  for (const dk of sortedKeys) {
    const v = orIvProxy(intraByDay.get(dk) || []);
    if (v != null && v > 0) orIvByDay.set(dk, v);
  }
  const histOr = [];
  const lookback = Math.max(5, Math.min(60, Number(settings.ivLookbackDays) || 20));
  for (let j = Math.max(0, i - lookback); j < i; j += 1) {
    const v = orIvByDay.get(sortedKeys[j]);
    if (v != null) histOr.push(v);
  }
  const medianOrIv = median(histOr);
  const todayOr = orIvProxy(dayBars);
  const spike = Number(settings.ivSpikeMultiplier) || 1.25;
  const maxSpike = Number(settings.maxSpikeMultiplier) || 2;

  const entryIdx = dayBars.findIndex((b) => b[0] === trade.entryTime);
  const entryMin = entryIdx >= 0 ? getIstClock(dayBars[entryIdx][0]).minutes : null;

  const checks = {
    dayKey,
    todayOr,
    medianOrIv,
    spikeOk: todayOr >= medianOrIv * spike,
    notExtreme: todayOr <= medianOrIv * maxSpike,
    entryMin,
    entryWindowOk: entryMin != null && entryMin >= M1000 && entryMin <= M1100,
    entryIvProxyStored: trade.entryIvProxy,
    medianIvProxyStored: trade.medianIvProxy,
    ivProxyMatch: Math.abs((trade.entryIvProxy || 0) - (todayOr || 0)) < 0.02,
    medianMatch: Math.abs((trade.medianIvProxy || 0) - medianOrIv) < 0.02,
    reason: trade.reason,
    pnl: trade.pnl,
  };
  const failed = [];
  if (!checks.spikeOk) failed.push('spike filter');
  if (!checks.notExtreme) failed.push('max spike');
  if (!checks.entryWindowOk) failed.push('entry time window');
  if (!checks.ivProxyMatch) failed.push('entryIvProxy mismatch');
  if (!checks.medianMatch) failed.push('medianIvProxy mismatch');
  return { checks, failed, ok: failed.length === 0 };
}

async function main() {
  const settings = {
    symbol: 'NIFTY',
    interval: '5',
    basePremiumPct: 0.5,
    premiumLeverage: 8,
    lotCount: 1,
    perTradeCost: 100,
    ivLookbackDays: 20,
    ivSpikeMultiplier: 1.25,
    maxSpikeMultiplier: 2,
    targetVolCrushPct: null,
    stopVolExpandPct: null,
    ivExpandStopMult: 1.5,
  };

  console.log('=== Strategy 3 IV logic audit ===\n');
  console.log('Settings:', JSON.stringify(settings, null, 2));

  let rows = [];
  try {
    const payload = await fetchWithRateLimitRetry({ symbol: 'NIFTY', interval: '5', year: 2024 });
    rows = payload.rows || [];
    console.log(`\nDhan candles loaded: ${rows.length} rows (2024)`);
  } catch (e) {
    console.log('\n[Dhan fetch skipped]', e.message);
    console.log('Cannot verify live data path without API token.\n');
    process.exit(0);
  }

  const result = runIvMeanReversionBacktest({ candles: rows, settings });
  const trades = result.trades || [];
  console.log(`Trades 2024: ${trades.length}`);
  console.log('Summary netPnl:', result.summary?.netPnl);

  const intraByDay = buildIntradayByDay(rows);
  const sortedKeys = Array.from(intraByDay.keys()).sort();

  let pass = 0;
  let fail = 0;
  for (const t of trades) {
    const { ok, failed, checks } = auditOneTrade(t, intraByDay, sortedKeys, settings);
    if (ok) pass += 1;
    else {
      fail += 1;
      console.log('\nFAIL', checks.dayKey, failed, checks);
    }
  }
  console.log(`\nEntry-condition audit: ${pass} pass, ${fail} fail (of ${trades.length} trades)`);

  const byReason = {};
  for (const t of trades) {
    const r = t.reason || 'UNKNOWN';
    byReason[r] = (byReason[r] || 0) + 1;
  }
  console.log('Exit reasons 2024:', byReason);

  const years = [2022, 2023, 2024, 2025];
  console.log('\n--- Multi-year quick replay (same settings, no DB) ---');
  for (const year of years) {
    try {
      const p = await fetchWithRateLimitRetry({ symbol: 'NIFTY', interval: '5', year });
      const r = runIvMeanReversionBacktest({ candles: p.rows, settings });
      console.log(
        year,
        '| trades:',
        r.trades.length,
        '| netPnl:',
        r.summary?.netPnl,
        '| winRate:',
        r.summary?.winRate + '%',
      );
    } catch (err) {
      console.log(year, '| error:', err.message);
    }
  }

  console.log('\n--- Live vs backtest ---');
  console.log('Paper live: liveIvMeanReversionEngine (strategy3_iv_mean_reversion_live) — real Dhan LTP + lot size.');
  console.log('Backtest: modeled premium from basePremiumPct — same entry/exit rules, not same rupee P/L.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

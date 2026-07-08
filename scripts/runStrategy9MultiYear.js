/**
 * Strategy 5 — VWAP + EMA trend (T01) multi-year validation.
 *
 *   npm run scenarios:s9
 *   npm run scenarios:s9 -- --api
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runVwapEmaTrendBacktest } = require('../src/strategies/strategy9/vwapEmaTrendBacktest');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades } = require('./lib/multiYearMonthlyStats');
const { getIstClock } = require('../src/utils/dateTime');
const { getLotSize, getStrikeStep } = require('../src/utils/market');

const YEARS = DEFAULT_YEARS;
const SYMBOL = 'NIFTY';
const INTERVAL = '5';

const T01_SETTINGS = {
  symbol: SYMBOL,
  interval: INTERVAL,
  maxTradesPerDay: 1,
  minBarsBetweenTrades: 1,
  // One-shot entry: first configured candle (09:30 IST).
  entryFromTime: '09:30',
  entryToTime: '12:30',
  strikeMode: 'ATM',
  // SL is index-based (stopIndex) — keep premium SL disabled.
  stopLossPoints: 0,
  targetProfitPoints: 2,
  basePremiumPct: 0.5,
  premiumLeverage: 8,
  lotCount: 10,
  perTradeCost: 100,
  usePatternExits: true,
  bigCandleMinBodyPct: 0.002,
  bigCandleMinRangePct: 0.003,
  slBufferPoints: 8,
};

function yearFromTrade(t) {
  return getIstClock(t.entryTime).dateKey.slice(0, 4);
}

function countExitsVwapEma(trades) {
  const exits = { TARGET: 0, STOP_LOSS: 0, PATTERN_SL: 0, DAY_CLOSE: 0, OTHER: 0 };
  for (const t of trades) {
    const r = String(t.reason || 'OTHER');
    if (exits[r] != null) exits[r] += 1;
    else if (r.startsWith('PATTERN_')) exits.OTHER += 1;
    else exits.OTHER += 1;
  }
  return exits;
}

function formatExit(exits) {
  const tg = exits.TARGET || 0;
  const sl = exits.STOP_LOSS || 0;
  const psl = exits.PATTERN_SL || 0;
  const eod = exits.DAY_CLOSE || 0;
  return `T${tg}/S${sl}/PS${psl}/E${eod}`;
}

function runT01(allRows) {
  const settings = {
    ...T01_SETTINGS,
    lotSize: getLotSize(SYMBOL),
    strikeStep: getStrikeStep(SYMBOL),
  };
  const out = runVwapEmaTrendBacktest({ candles: allRows, settings });
  const trades = out.trades || [];
  const summary = out.summary || {};
  const totalNet = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const wins = trades.filter((t) => Number(t.pnl) > 0).length;
  const monthly = analyzeTrades(trades, SYMBOL);
  const exits = countExitsVwapEma(trades);

  const byYear = {};
  let peTrades = 0;
  let ceTrades = 0;
  for (const t of trades) {
    const y = yearFromTrade(t);
    if (!byYear[y]) byYear[y] = { net: 0, trades: 0, wins: 0, pe: 0, ce: 0 };
    byYear[y].net += Number(t.pnl) || 0;
    byYear[y].trades += 1;
    if (Number(t.pnl) > 0) byYear[y].wins += 1;
    const type = String(t.type || '').toUpperCase();
    if (type === 'PE') {
      byYear[y].pe += 1;
      peTrades += 1;
    } else if (type === 'CE') {
      byYear[y].ce += 1;
      ceTrades += 1;
    }
  }

  return {
    id: 'T01',
    name: 'VWAP + EMA trend — SL(index) TG2',
    settings,
    totalTrades: trades.length,
    skippedDays: summary.skippedDays ?? 0,
    peTrades,
    ceTrades,
    winRate: trades.length ? Number(((wins / trades.length) * 100).toFixed(2)) : 0,
    totalNet: Number(totalNet.toFixed(2)),
    monthly,
    byYear,
    exits,
    exitLabel: formatExit(exits),
  };
}

function printReport(result) {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log(' STRATEGY 5 — VWAP + EMA TREND (T01) — MULTI-YEAR VALIDATION');
  console.log(` Years: ${YEARS.join(', ')} | NIFTY 5m | entry window 09:30–12:30 | SL(index buffer) TG2 | 10 lots`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  console.log(`Total net: Rs ${result.totalNet}`);
  console.log(`Trades: ${result.totalTrades} | WR: ${result.winRate}% | PE: ${result.peTrades} | CE: ${result.ceTrades}`);
  console.log(`Exits (${result.exitLabel})`);

  console.log('\n── PER-YEAR NET ──');
  for (const y of YEARS) {
    const yr = result.byYear[String(y)] || { net: 0, trades: 0, wins: 0 };
    const wr = yr.trades ? ((yr.wins / yr.trades) * 100).toFixed(1) : '0.0';
    console.log(`  ${y}: net=${Number(yr.net).toFixed(0)} trades=${yr.trades} wr=${wr}%`);
  }

  console.log('\n── MONTHLY STATS ──');
  console.log(`  Months > Rs 5k: ${result.monthly.months5k}`);
  console.log(`  Months > Rs 10k: ${result.monthly.months10k}`);
  console.log(`  Best month: Rs ${result.monthly.bestMonthNet}`);
  console.log(`  Worst month: Rs ${result.monthly.worstMonthNet}`);
}

async function main() {
  const preferApi = process.argv.includes('--api');
  console.log(`Loading ${SYMBOL} ${INTERVAL}m ${YEARS.join(', ')}...`);
  const { allRows, source } = await loadCandlesMultiYear({
    symbol: SYMBOL,
    interval: INTERVAL,
    years: YEARS,
    preferApi,
  });
  console.log(`Loaded ${allRows.length} bars (${source})\n`);

  process.stdout.write('  T01...');
  const result = runT01(allRows);
  console.log(` net=${result.totalNet}`);

  printReport(result);

  const jsonPath = path.join(__dirname, 'strategy9-multiyear-report.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        years: YEARS,
        symbol: SYMBOL,
        scenario: result,
      },
      null,
      2
    )
  );
  console.log(`\nJSON: ${jsonPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

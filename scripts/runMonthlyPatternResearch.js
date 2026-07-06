/**
 * Monthly-profit pattern research — individual rules + stack profiles × SL/TG (2022–2026).
 *
 *   npm run research:monthly
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { runPatternStackBacktest, PATTERN_RULES } = require('../src/strategies/strategy10/patternStackEngine');
const { buildIntradayByDay } = require('../src/strategies/shared/intradayOptions');
const { loadCandlesMultiYear, DEFAULT_YEARS } = require('../src/analysis/loadCandlesMultiYear');
const { analyzeTrades, countExits } = require('./lib/multiYearMonthlyStats');
const { getLotSize, getStrikeStep } = require('../src/utils/market');

const SYMBOL = 'NIFTY';
const INTERVAL = '5';

const STRICT_FILTERS = { skipBothOrb: true, minMorningRange: 40 };
const LOOSE_FILTERS = { skipBothOrb: false, minMorningRange: 0 };
const TIGHT_FILTERS = { skipBothOrb: true, minMorningRange: 50 };

const STACK_PROFILES = [
  {
    id: 'current_strict',
    name: 'Current S6 strict stack',
    ruleIds: ['orb_high', 'orb_low', 'pdl', 'fh_green', 'fh_red'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'orb_pdl_only',
    name: 'ORB + PDL only (no first hour)',
    ruleIds: ['orb_high', 'orb_low', 'pdl'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'orb_only',
    name: 'ORB narrow break only',
    ruleIds: ['orb_high', 'orb_low'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'morning_core',
    name: 'ORB + PDL + PDH',
    ruleIds: ['orb_high', 'orb_low', 'pdl', 'pdh'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'gap_morning',
    name: 'Gap + ORB + PDL',
    ruleIds: ['gap_up', 'gap_down', 'orb_high', 'orb_low', 'pdl'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'extended',
    name: 'Extended: gap, ORB, PDL, PDH, first hour',
    ruleIds: ['gap_up', 'gap_down', 'orb_high', 'orb_low', 'pdl', 'pdh', 'fh_green', 'fh_red'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'ce_bias',
    name: 'CE bias: gap up, ORB high, PDH, FH green',
    ruleIds: ['gap_up', 'orb_high', 'pdh', 'fh_green'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'pe_bias',
    name: 'PE bias: gap down, ORB low, PDL, FH red',
    ruleIds: ['gap_down', 'orb_low', 'pdl', 'fh_red'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'no_fh_red',
    name: 'Strict stack without first-hour red PE',
    ruleIds: ['orb_high', 'orb_low', 'pdl', 'fh_green'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'continuation',
    name: 'Prev-day continuation + ORB + PDL',
    ruleIds: ['orb_high', 'orb_low', 'pdl', 'prev_green', 'prev_red'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'inside_break',
    name: 'Inside day breaks + ORB',
    ruleIds: ['orb_high', 'orb_low', 'inside_break_high', 'inside_break_low'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'wide_prev',
    name: 'Wide prev day + first hour color',
    ruleIds: ['wide_prev_green', 'wide_prev_red', 'orb_high', 'orb_low'],
    filters: STRICT_FILTERS,
  },
  {
    id: 'tight_chop',
    name: 'Tight chop filter (50pt min range)',
    ruleIds: ['orb_high', 'orb_low', 'pdl', 'fh_green', 'fh_red'],
    filters: TIGHT_FILTERS,
  },
  {
    id: 'full_no_chop',
    name: 'Full stack no chop skip',
    ruleIds: ['orb_high', 'orb_low', 'pdl', 'fh_green', 'fh_red'],
    filters: LOOSE_FILTERS,
  },
  {
    id: 'pdl_fh_only',
    name: 'PDL + first hour only',
    ruleIds: ['pdl', 'fh_green', 'fh_red'],
    filters: STRICT_FILTERS,
  },
];

const SL_TG_COMBOS = [
  { sl: 15, tg: 55 },
  { sl: 15, tg: 45 },
  { sl: 15, tg: 70 },
  { sl: 12, tg: 40 },
  { sl: 18, tg: 60 },
  { sl: 20, tg: 55 },
  { sl: 15, tg: 35 },
  { sl: 10, tg: 30 },
];

function baseSettings(sl, tg, ruleIds, filters) {
  return {
    symbol: SYMBOL,
    interval: INTERVAL,
    lotSize: getLotSize(SYMBOL),
    strikeStep: getStrikeStep(SYMBOL),
    lotCount: 10,
    basePremiumPct: 0.5,
    premiumLeverage: 8,
    perTradeCost: 100,
    stopLossPoints: sl,
    targetProfitPoints: tg,
    ruleIds,
    filters,
  };
}

function summarize(trades, summary, meta) {
  const monthly = analyzeTrades(trades, SYMBOL);
  const exits = countExits(trades);
  const net = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const losingMonths = monthly.months.filter((m) => m.net <= 0);

  return {
    ...meta,
    totalTrades: trades.length,
    skippedDays: summary.skippedDays,
    winRate: summary.winRate,
    netPnl: Number(net.toFixed(2)),
    positiveMonths: monthly.positiveMonths,
    totalMonths: monthly.totalMonths,
    pctPositive: monthly.pctPositive,
    avgMonthlyNet: monthly.avgMonthlyNet,
    worstMonth: monthly.worstMonth,
    bestMonth: monthly.bestMonth,
    losingMonthList: losingMonths.map((m) => `${m.month}:${m.net}`),
    exits: `T${exits.TARGET || 0}/S${exits.STOP_LOSS || 0}/E${exits.DAY_CLOSE || 0}`,
    signalCounts: summary.signalCounts,
    monthlyScore:
      monthly.pctPositive * 0.7 +
      Math.min(30, (summary.winRate || 0) * 0.15) +
      Math.min(15, net > 0 ? 15 : 0),
  };
}

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

async function main() {
  console.log(`Monthly pattern research — ${SYMBOL} ${INTERVAL}m ${DEFAULT_YEARS.join(', ')}`);
  const { allRows } = await loadCandlesMultiYear({
    symbol: SYMBOL,
    interval: INTERVAL,
    years: DEFAULT_YEARS,
  });

  const intraByDay = buildIntradayByDay(allRows);
  const sortedKeys = Array.from(intraByDay.keys()).sort();
  const { buildStackContext } = require('../src/strategies/strategy10/patternStackEngine');
  const stackCtx = buildStackContext(sortedKeys, intraByDay);

  // Phase 1: each pattern alone (SL15/TG55)
  console.log('\n── Phase 1: single patterns (SL15/TG55) ──');
  const singles = [];
  for (const ruleId of Object.keys(PATTERN_RULES)) {
    const settings = baseSettings(15, 55, [ruleId], STRICT_FILTERS);
    const { trades, summary } = runPatternStackBacktest({
      candles: allRows,
      settings,
      stackCtx,
      intraByDay,
    });
    singles.push(
      summarize(trades, summary, {
        id: `solo_${ruleId}`,
        name: `Solo: ${PATTERN_RULES[ruleId].label}`,
        profile: 'single',
        ruleIds: [ruleId],
        sl: 15,
        tg: 55,
      }),
    );
  }
  singles.sort((a, b) => b.pctPositive - a.pctPositive || b.netPnl - a.netPnl);

  for (const r of singles) {
    console.log(
      `  ${pad(r.id, 22)} | ${pad(r.totalTrades, 5)} tr | ${pad(`${r.pctPositive}%`, 6)} +mo | net ${pad(r.netPnl, 10)} | ${r.losingMonthList.length} red months`,
    );
  }

  // Phase 2: stack profiles × SL/TG
  console.log('\n── Phase 2: stack profiles × SL/TG ──');
  const stacks = [];
  let n = 0;
  for (const profile of STACK_PROFILES) {
    for (const { sl, tg } of SL_TG_COMBOS) {
      n += 1;
      const settings = baseSettings(sl, tg, profile.ruleIds, profile.filters);
      process.stdout.write(`  [${n}/${STACK_PROFILES.length * SL_TG_COMBOS.length}] ${profile.id} SL${sl}/TG${tg}...`);
      const t0 = Date.now();
      const { trades, summary } = runPatternStackBacktest({
        candles: allRows,
        settings,
        stackCtx,
        intraByDay,
      });
      stacks.push(
        summarize(trades, summary, {
          id: `${profile.id}_SL${sl}_TG${tg}`,
          name: `${profile.name} SL${sl}/TG${tg}`,
          profile: profile.id,
          ruleIds: profile.ruleIds,
          sl,
          tg,
        }),
      );
      console.log(` ${Date.now() - t0}ms`);
    }
  }
  stacks.sort((a, b) => b.pctPositive - a.pctPositive || b.netPnl - a.netPnl);

  const lines = [];
  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(' MONTHLY PROFIT PATTERN RESEARCH (ranked by % positive months)');
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push(`Candles: ${allRows.length} | Singles: ${singles.length} | Stacks: ${stacks.length}`);
  lines.push('');
  lines.push('TOP SINGLE PATTERNS (SL15/TG55):');
  lines.push('Pattern               | Trades | +Months      | Net PnL      | Red months');
  for (const r of singles.slice(0, 8)) {
    lines.push(
      `${pad(r.id, 22)}| ${pad(r.totalTrades, 6)} | ${pad(`${r.positiveMonths}/${r.totalMonths} (${r.pctPositive}%)`, 12)} | ${pad(r.netPnl, 12)} | ${r.losingMonthList.length}`,
    );
  }
  lines.push('');
  lines.push('TOP STACK CONFIGS:');
  lines.push('Profile / SL/TG        | Trades | +Months      | Net PnL      | Worst month');
  for (const r of stacks.slice(0, 15)) {
    lines.push(
      `${pad(r.profile, 22)}| ${pad(r.totalTrades, 6)} | ${pad(`${r.positiveMonths}/${r.totalMonths} (${r.pctPositive}%)`, 12)} | ${pad(r.netPnl, 12)} | ${r.worstMonth?.month || '-'} ${r.worstMonth?.net ?? ''}`,
    );
  }

  const best = stacks[0];
  const bestNet = [...stacks].sort((a, b) => b.netPnl - a.netPnl)[0];
  const bestSingle = singles[0];

  lines.push('');
  lines.push('★ BEST FOR MONTHLY PROFIT:');
  lines.push(`  ${best.name}`);
  lines.push(`  ${best.pctPositive}% positive months (${best.positiveMonths}/${best.totalMonths}), ${best.totalTrades} trades, net ${best.netPnl}`);
  lines.push(`  Red months: ${best.losingMonthList.join(', ') || 'none'}`);
  lines.push('');
  lines.push('★ BEST SINGLE PATTERN:');
  lines.push(`  ${bestSingle.name} — ${bestSingle.pctPositive}% +months, net ${bestSingle.netPnl}`);
  lines.push('');
  lines.push('★ BEST NET PnL STACK:');
  lines.push(`  ${bestNet.name} — net ${bestNet.netPnl}, ${bestNet.pctPositive}% +months`);

  const outPath = path.join(__dirname, 'monthly-pattern-research.json');
  const txtPath = path.join(__dirname, 'monthly-pattern-research.txt');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ singles, stacks, best, bestSingle, bestNet, generatedAt: new Date().toISOString() }, null, 2),
  );
  fs.writeFileSync(txtPath, lines.join('\n'));

  console.log(lines.join('\n'));
  console.log(`\nJSON → ${outPath}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

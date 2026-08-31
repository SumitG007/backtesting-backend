const paperEngine = require('../services/liveLiquidityOiChaseEngine');
const chartHistory = require('../services/liquidityChartHistoryService');
const { runLiquiditySweepBacktest } = require('../services/liquiditySweepBacktest');
const { loadYearCandles, listCachedYears } = require('../services/liquidityBacktestData');
const { buildValidationReport } = require('./backtest/buildValidationReport');
const { getIstClock } = require('../utils/dateTime');

function fmtIstParts(iso) {
  if (!iso) return { dateKey: '', time: '', label: '' };
  const clock = getIstClock(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const pick = (t) => parts.find((p) => p.type === t)?.value || '';
  const hh = pick('hour');
  const mm = pick('minute');
  const time = `${hh}:${mm}`;
  return {
    dateKey: clock.dateKey,
    time,
    label: `${clock.dateKey} ${time}`,
  };
}

function enrichTradeTimes(trades) {
  return (trades || []).map((t) => {
    const entry = fmtIstParts(t.entryTime);
    const exit = fmtIstParts(t.exitTime);
    return {
      ...t,
      entryDateKey: entry.dateKey || t.dateKey,
      entryTimeIst: entry.time,
      entryAt: entry.label,
      exitDateKey: exit.dateKey || t.exitDateKey,
      exitTimeIst: exit.time,
      exitAt: exit.label,
    };
  });
}

async function getLiquidityOiChaseStatus(_req, res) {
  try {
    const chart = chartHistory.getStatus();
    return res.json({
      ok: true,
      strategyPaused: true,
      chart,
      note: 'Liquidity strategy paused — chart history only.',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseChart(_req, res) {
  try {
    const data = await chartHistory.getWeekChartPayload();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseBook(_req, res) {
  try {
    const chart = await chartHistory.getWeekChartPayload();
    return res.json({
      ok: true,
      strategyPaused: true,
      enabled: false,
      openTrades: [],
      signal: null,
      settings: { symbol: chart.symbol },
      wallet: null,
      dateKey: chart.dateKey,
      chart,
      note: 'Strategy paused — no entries / open positions.',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseTrades(_req, res) {
  return res.json({
    ok: true,
    trades: [],
    total: 0,
    page: 1,
    pageSize: 20,
    pagination: { page: 1, pageSize: 20, totalPages: 1, totalRows: 0 },
    note: 'Strategy paused — trade history hidden.',
  });
}

async function postLiquidityOiChaseEnabled(_req, res) {
  return res.json({
    ok: true,
    enabled: false,
    note: 'Strategy paused — enable will return when rules are rebuilt.',
  });
}

async function patchLiquidityOiChaseSettings(_req, res) {
  return res.json({
    ok: true,
    settings: { symbol: 'NIFTY' },
    note: 'Strategy paused — settings locked for now.',
  });
}

async function postLiquidityOiChaseClose(_req, res) {
  try {
    if (typeof paperEngine.closeOpenTradeManual === 'function') {
      const trade = await paperEngine.closeOpenTradeManual('STRATEGY_PAUSED');
      return res.json({ ok: true, trade, note: 'Closed leftover open trade (strategy paused).' });
    }
    return res.json({ ok: true, trade: null, note: 'Strategy paused.' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

/**
 * POST /liquidity-oi-chase/backtest
 * Body: { year: 2024, settings?: { targetMode, targetPts, bufferPts, ... } }
 */
async function postLiquidityOiChaseBacktest(req, res) {
  try {
    const year = Number(req.body?.year || req.query?.year);
    if (!Number.isFinite(year) || year < 2018 || year > 2030) {
      return res.status(400).json({ ok: false, error: 'Provide a valid year (e.g. 2024).' });
    }

    // Default = best scenario from 100-run search (S086 PDY Break&Go 2R @ 10 lots)
    const BEST = {
      mode: 'break_go',
      targetMode: 'rr',
      rrMultiple: 2,
      bufferPts: 5,
      minVisits: 1,
      priorDayZonesOnly: true,
      maxTradesPerDay: 2,
      maxZoneLookbackDays: 3,
      length: 14,
      sessionStartMin: 9 * 60 + 20,
      sessionEndMin: 14 * 60 + 45,
    };

    const body = { ...BEST, ...(req.body || {}), ...(req.body?.settings || {}) };
    const settings = {
      mode: body.mode,
      targetMode: body.targetMode,
      targetPts: body.targetPts,
      rrMultiple: body.rrMultiple,
      bufferPts: body.bufferPts,
      maxTradesPerDay: body.maxTradesPerDay,
      lotSize: body.lotSize,
      minVisits: body.minVisits,
      length: body.length,
      priorDayZonesOnly: body.priorDayZonesOnly,
      maxZoneLookbackDays: body.maxZoneLookbackDays,
      sessionStartMin: body.sessionStartMin,
      sessionEndMin: body.sessionEndMin,
      emaPeriod: body.emaPeriod,
      sideBias: body.sideBias,
      minSweepPts: body.minSweepPts,
    };

    const candles = await loadYearCandles({ symbol: 'NIFTY', interval: '5', year });
    // lotSize 1 → engine pnl == points (UI shows points only, no money)
    const result = runLiquiditySweepBacktest(candles.rows, { ...settings, lotSize: 1 });
    const trades = enrichTradeTimes(result.trades).map((t) => ({
      ...t,
      pnlPoints: Number(t.pnlPoints),
      // keep pnl as points alias for shared report helpers
      pnl: Number(t.pnlPoints),
    }));
    const byDayMap = new Map();
    for (const t of trades) {
      const key = t.dateKey;
      if (!byDayMap.has(key)) {
        byDayMap.set(key, { dateKey: key, trades: [], pnl: 0, points: 0, wins: 0, losses: 0 });
      }
      const d = byDayMap.get(key);
      d.trades.push(t);
      d.points += t.pnlPoints;
      d.pnl += t.pnlPoints;
      if (t.pnlPoints > 0) d.wins += 1;
      else if (t.pnlPoints < 0) d.losses += 1;
    }
    const byDay = [...byDayMap.values()]
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey))
      .map((d) => ({
        ...d,
        points: Number(d.points.toFixed(2)),
        pnl: Number(d.pnl.toFixed(2)),
        tradeCount: d.trades.length,
      }));

    const report = buildValidationReport(
      trades.map((t) => ({
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        pnl: t.pnlPoints,
        reason: t.reason,
      })),
    );
    report.assumptions = [
      `Strategy: ${result.strategyName} (Break & Go · prior-day zones).`,
      'Enter WITH the break when price closes through a prior-day liquidity zone.',
      `SL beyond broken zone ± ${result.settings.bufferPts} pts. Target: ${result.settings.targetMode}${
        result.settings.targetMode === 'rr' ? ` ×${result.settings.rrMultiple}` : ` ${result.settings.targetPts} pts`
      }.`,
      'All stats are in Nifty POINTS (gains/losses) — no rupee conversion.',
      'Candle-level fills; no slippage/charges.',
      `Candle source: ${candles.source} · ${candles.barCount} bars · through ${candles.throughDateKey || '—'}.`,
    ];
    // Rename money-ish labels in stats for clarity (values are already points)
    if (report.stats) {
      report.stats.unit = 'points';
      report.stats.netPoints = report.stats.netPnl;
      report.stats.grossProfitPoints = report.stats.grossProfit;
      report.stats.grossLossPoints = report.stats.grossLoss;
      report.stats.maxDrawdownPoints = report.stats.maxDrawdown;
      report.stats.expectancyPoints = report.stats.expectancy;
      report.stats.avgWinPoints = report.stats.avgWin;
      report.stats.avgLossPoints = report.stats.avgLoss;
    }
    if (Array.isArray(report.monthly)) {
      report.monthly = report.monthly.map((m) => ({
        ...m,
        points: m.pnl,
      }));
    }

    return res.json({
      ok: true,
      year,
      symbol: 'NIFTY',
      interval: '5',
      strategyName: result.strategyName,
      strategyKey: result.strategyKey,
      note: result.note,
      settings: result.settings,
      candles: {
        source: candles.source,
        barCount: candles.barCount,
        fromDate: candles.fromDate,
        toDate: candles.toDate,
        throughDateKey: candles.throughDateKey || null,
        refreshError: candles.refreshError || null,
      },
      zoneCount: result.zoneCount,
      report,
      byDay,
      trades,
      tradeCount: trades.length,
      cachedYears: listCachedYears('NIFTY', '5'),
    });
  } catch (error) {
    console.error('[LIQ BACKTEST]', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getLiquidityOiChaseBacktestMeta(_req, res) {
  try {
    const cachedYears = listCachedYears('NIFTY', '5');
    return res.json({
      ok: true,
      symbol: 'NIFTY',
      interval: '5',
      cachedYears,
      years: [2021, 2022, 2023, 2024, 2025, 2026],
      strategyName: 'Liquidity Break & Go (prior-day zones · 2R)',
      defaults: {
        mode: 'break_go',
        targetMode: 'rr',
        rrMultiple: 2,
        bufferPts: 5,
        maxTradesPerDay: 2,
        minVisits: 1,
        length: 14,
        priorDayZonesOnly: true,
        maxZoneLookbackDays: 3,
      },
      note: 'Report shows Nifty POINTS only (no money). Disk cache years are fast.',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getLiquidityOiChaseStatus,
  getLiquidityOiChaseChart,
  getLiquidityOiChaseBook,
  getLiquidityOiChaseTrades,
  postLiquidityOiChaseEnabled,
  patchLiquidityOiChaseSettings,
  postLiquidityOiChaseClose,
  postLiquidityOiChaseBacktest,
  getLiquidityOiChaseBacktestMeta,
};

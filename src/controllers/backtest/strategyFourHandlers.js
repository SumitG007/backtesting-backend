/**
 * Strategy 4 — PHANTOM STRIKE (backtest only; no live/paper).
 */

const StrategyRun = require('../../models/strategyRun');
const StrategyTrade = require('../../models/strategyTrade');
const { getLotSize } = require('../../utils/market');
const { fetchWithRateLimitRetry } = require('../../services/dhanDataService');
const { STRATEGY_FOUR_KEY } = require('../../strategies/keys');
const { runStrategyFourBacktest } = require('../../strategies/strategy4/backtest');
const { parseNumberInput, parseStringInput } = require('./parsers');
const { getRunTradesByStrategy, getRunValidationByStrategy } = require('./tradeQueries');

let strategy4RunInFlight = false;

async function runStrategyFour(req, res) {
  if (strategy4RunInFlight) {
    return res.status(409).json({
      ok: false,
      error: 'A Strategy 4 backtest is already running. Wait for it to finish before starting another.',
    });
  }
  strategy4RunInFlight = true;
  const startedAt = Date.now();
  try {
    const { symbol = 'NIFTY', interval = '15', year = 2026 } = req.body || {};
    const settings = {
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      emaPeriod: parseNumberInput(req.body?.emaPeriod, 50),
      rsiPeriod: parseNumberInput(req.body?.rsiPeriod, 14),
      rsiMin: parseNumberInput(req.body?.rsiMin, 45),
      rsiMax: parseNumberInput(req.body?.rsiMax, 65),
      atrPeriod: parseNumberInput(req.body?.atrPeriod, 14),
      slAtrMult: parseNumberInput(req.body?.slAtrMult, 1.5),
      targetAtrMult: parseNumberInput(req.body?.targetAtrMult, 3),
      volumeMult: parseNumberInput(req.body?.volumeMult, 1.5),
      volumeLookback: parseNumberInput(req.body?.volumeLookback, 20),
      entryFromTime: parseStringInput(req.body?.entryFromTime, '10:15'),
      entryToTime: parseStringInput(req.body?.entryToTime, '14:00'),
      exitTime: parseStringInput(req.body?.exitTime, '15:15'),
      lotCount: parseNumberInput(req.body?.lotCount, 1),
      lotSize: parseNumberInput(req.body?.lotSize, getLotSize(symbol)),
      perTradeCost: parseNumberInput(req.body?.perTradeCost, 100),
      maxTradesPerDay: parseNumberInput(req.body?.maxTradesPerDay, 1),
    };

    const yearNum = parseNumberInput(year, 2026);
    const runTagInterval = String(interval);
    console.log(`[Strategy4] Run started ${settings.symbol} ${yearNum} (tag interval ${runTagInterval}m; fetch 1+5+15)`);

    // Sequential fetch avoids hammering Dhan with 3 parallel year downloads (rate limits / hangs).
    const payload1m = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: '1',
      year: yearNum,
    });
    const payload5m = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: '5',
      year: yearNum,
    });
    const payload15m = await fetchWithRateLimitRetry({
      symbol: settings.symbol,
      interval: '15',
      year: yearNum,
    });
    console.log(
      `[Strategy4] Candles loaded — 1m: ${payload1m.rows.length}, 5m: ${payload5m.rows.length}, 15m: ${payload15m.rows.length}`,
    );

    if (!payload1m.rows.length || !payload5m.rows.length || !payload15m.rows.length) {
      return res.status(400).json({
        ok: false,
        error: 'No candle data returned from Dhan for one or more timeframes. Check token, symbol, and year.',
      });
    }

    console.log('[Strategy4] Running backtest...');
    const result = runStrategyFourBacktest({
      candles1m: payload1m.rows,
      candles5m: payload5m.rows,
      candles15m: payload15m.rows,
      settings,
    });
    console.log(`[Strategy4] Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${result.trades.length} trades`);

    const runDoc = await StrategyRun.create({
      strategyKey: STRATEGY_FOUR_KEY,
      symbol: settings.symbol,
      interval: String(interval),
      year: yearNum,
      settings,
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          ...t,
          runId: runDoc._id,
          strategyKey: STRATEGY_FOUR_KEY,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 4 - PHANTOM STRIKE',
      year: yearNum,
      symbol: settings.symbol,
      interval: runTagInterval,
      summary: result.summary,
      candleCounts: {
        '1m': payload1m.rows.length,
        '5m': payload5m.rows.length,
        '15m': payload15m.rows.length,
      },
      trades: result.trades.slice(0, pageSize),
      pagination: {
        page: 1,
        pageSize,
        totalRows: result.trades.length,
        totalPages: Math.max(1, Math.ceil(result.trades.length / pageSize)),
      },
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({
        ok: false,
        error: 'Dhan API error',
        details: error.response.data,
      });
    }
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    strategy4RunInFlight = false;
  }
}

async function getStrategyFourRunTrades(req, res) {
  return getRunTradesByStrategy(req, res, STRATEGY_FOUR_KEY);
}

async function getStrategyFourValidation(req, res) {
  return getRunValidationByStrategy(req, res, STRATEGY_FOUR_KEY);
}

module.exports = {
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
};

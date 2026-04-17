require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'backtesting-api' });
});

const strategyRunSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    interval: { type: String, required: true },
    year: { type: Number, required: true },
    settings: { type: Object, required: true },
    summary: { type: Object, required: true },
    status: { type: String, default: 'completed' },
  },
  { timestamps: true }
);

const strategyTradeSchema = new mongoose.Schema(
  {
    runId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    strategyKey: { type: String, required: true, index: true },
    pair: String,
    type: String,
    strike: Number,
    buyPrice: Number,
    sellPrice: Number,
    lots: Number,
    invested: Number,
    finalValue: Number,
    closed: String,
    order: String,
    entryTime: Date,
    exitTime: Date,
    entryPrice: Number,
    exitPrice: Number,
    stopLoss: Number,
    target: Number,
    qty: Number,
    premium: Number,
    lotCount: Number,
    lotSize: Number,
    investmentAmount: Number,
    stopLossAmount: Number,
    targetAmount: Number,
    pnl: Number,
    pnlPct: Number,
    reason: String,
  },
  { timestamps: true }
);

const StrategyRun =
  mongoose.models.StrategyRun || mongoose.model('StrategyRun', strategyRunSchema);
const StrategyTrade =
  mongoose.models.StrategyTrade || mongoose.model('StrategyTrade', strategyTradeSchema);

const PRESET_SYMBOLS = {
  NIFTY: { securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  BANKNIFTY: { securityId: '25', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  RELIANCE: { securityId: '2885', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HDFCBANK: { securityId: '1333', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ICICIBANK: { securityId: '4963', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
};

const DEFAULT_LOT_SIZES = {
  NIFTY: 50,
  BANKNIFTY: 65,
};

function toIntradayDateTime(value, endOfDay = false) {
  if (!value) return '';
  if (value.includes(' ')) return value;
  return `${value} ${endOfDay ? '15:30:00' : '09:15:00'}`;
}

function parseDateOnly(value) {
  return new Date(`${value}T00:00:00`);
}

function formatDateOnly(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function differenceInDaysInclusive(fromDate, toDate) {
  const ms = parseDateOnly(toDate).getTime() - parseDateOnly(fromDate).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24)) + 1;
}

function resolveSymbolConfig(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  const map = PRESET_SYMBOLS[resolvedSymbol];
  return {
    symbol: resolvedSymbol,
    securityId: map?.securityId,
    exchangeSegment: map?.exchangeSegment,
    instrument: map?.instrument || 'INDEX',
  };
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const num = Number(value);
    return new Date(num < 1e12 ? num * 1000 : num);
  }
  return new Date(value);
}

function getIstClock(isoValue) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(isoValue));

  const pick = (type) => parts.find((p) => p.type === type)?.value || '00';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const hour = Number(pick('hour'));
  const minute = Number(pick('minute'));
  return {
    dateKey: `${year}-${month}-${day}`,
    minutes: hour * 60 + minute,
  };
}

function getLotSize(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  return DEFAULT_LOT_SIZES[resolvedSymbol] || 1;
}

function getStrikeStep(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  return resolvedSymbol === 'NIFTY' ? 50 : 100;
}

function getOptionPremiumFromSpotMove({
  side,
  entrySpot,
  currentSpot,
  entryPremium,
  premiumLeverage,
}) {
  const safeEntrySpot = Number(entrySpot);
  const safeCurrentSpot = Number(currentSpot);
  const safePremium = Math.max(0.05, Number(entryPremium) || 0.05);
  const safeLeverage = Math.max(1, Number(premiumLeverage) || 8);
  if (!Number.isFinite(safeEntrySpot) || safeEntrySpot <= 0) return safePremium;
  if (!Number.isFinite(safeCurrentSpot) || safeCurrentSpot <= 0) return safePremium;

  const spotMovePct = ((safeCurrentSpot - safeEntrySpot) / safeEntrySpot) * 100;
  const directionalMovePct = side === 'LONG' ? spotMovePct : -spotMovePct;
  const premiumMovePct = directionalMovePct * safeLeverage;
  return Math.max(0.05, safePremium * (1 + premiumMovePct / 100));
}

function calculateEma(values, period) {
  const k = 2 / (period + 1);
  const out = Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (Number.isNaN(v)) continue;
    ema = ema === null ? v : v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

async function fetchDhanIntradayChunk({
  fromDate,
  toDate,
  interval,
  securityId,
  exchangeSegment,
  instrument,
}) {
  const clientId = process.env.DHAN_CLIENT_ID;
  const accessToken = process.env.DHAN_ACCESS_TOKEN;
  if (!clientId || !accessToken) {
    throw new Error('DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN not configured in backend .env');
  }

  const baseUrl = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
  const response = await axios.post(
    `${baseUrl}/charts/intraday`,
    {
      securityId,
      exchangeSegment,
      instrument,
      interval: String(interval),
      oi: false,
      fromDate: toIntradayDateTime(fromDate, false),
      toDate: toIntradayDateTime(toDate, true),
    },
    {
      headers: {
        'access-token': accessToken,
        'client-id': clientId,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return response.data || {};
}

const yearCache = new Map();
const inflightRequests = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getYearRange(year) {
  const safeYear = Number(year);
  const now = new Date();
  const currentYear = now.getFullYear();
  return {
    fromDate: `${safeYear}-01-01`,
    toDate: safeYear === currentYear ? now.toISOString().slice(0, 10) : `${safeYear}-12-31`,
  };
}

async function fetchYearCandles({ symbol, interval, year }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol selected');
  }
  const { fromDate, toDate } = getYearRange(year);
  const totalDays = differenceInDaysInclusive(fromDate, toDate);
  const chunkCount = Math.ceil(totalDays / 90);
  const allRows = [];
  let currentFrom = parseDateOnly(fromDate);
  const overallEnd = parseDateOnly(toDate);

  for (let i = 0; i < chunkCount; i += 1) {
    const chunkStart = currentFrom;
    const chunkEndCandidate = addDays(chunkStart, 89);
    const chunkEnd = chunkEndCandidate > overallEnd ? overallEnd : chunkEndCandidate;
    const raw = await fetchDhanIntradayChunk({
      fromDate: formatDateOnly(chunkStart),
      toDate: formatDateOnly(chunkEnd),
      interval,
      securityId: resolved.securityId,
      exchangeSegment: resolved.exchangeSegment,
      instrument: resolved.instrument,
    });
    await sleep(250);

    const timestamps = raw.timestamp || [];
    const opens = raw.open || [];
    const highs = raw.high || [];
    const lows = raw.low || [];
    const closes = raw.close || [];
    const volumes = raw.volume || [];

    for (let j = 0; j < timestamps.length; j += 1) {
      const ts = normalizeTimestamp(timestamps[j]);
      if (Number.isNaN(ts.getTime())) continue;
      allRows.push([ts.toISOString(), opens[j], highs[j], lows[j], closes[j], volumes[j]]);
    }
    currentFrom = addDays(chunkEnd, 1);
  }

  allRows.sort((a, b) => new Date(a[0]) - new Date(b[0]));
  return { rows: allRows, fromDate, toDate };
}

function runStrategyTwo({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.85);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));
  const stopLossPct = Math.max(0.5, Number(settings.stopLossPct) || 10);
  const targetPct = Math.max(0.5, Number(settings.targetPct) || 20);
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 1);
  const maxHoldCandles = Math.max(1, Number(settings.maxHoldCandles) || 18);
  const minBreakoutBodyPct = Math.max(0.45, Number(settings.minBreakoutBodyPct) || 0.6);
  const breakoutRangeMult = Math.max(1, Number(settings.breakoutRangeMult) || 1.2);
  const minOpeningRangePct = Math.max(0.05, Number(settings.minOpeningRangePct) || 0.15);
  const retestBufferPct = Math.max(0, Number(settings.retestBufferPct) || 0.03);

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const dayKeys = Array.from(byDay.keys()).sort();
  const dayOpenMap = new Map();
  for (const dayKey of dayKeys) {
    const firstCandle = byDay.get(dayKey)?.[0];
    dayOpenMap.set(dayKey, Number(firstCandle?.[1]));
  }

  const trades = [];
  for (let d = 1; d < dayKeys.length; d += 1) {
    const prevDayKey = dayKeys[d - 1];
    const dayKey = dayKeys[d];
    const pdo = dayOpenMap.get(prevDayKey);
    const dayCandles = byDay.get(dayKey) || [];
    if (!Number.isFinite(pdo) || dayCandles.length < 12) continue;

    const opens = dayCandles.map((c) => Number(c[1]));
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const closes = dayCandles.map((c) => Number(c[4]));

    const openingIndexes = [];
    for (let i = 0; i < dayCandles.length; i += 1) {
      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes >= 555 && clock.minutes < 570) openingIndexes.push(i);
    }
    if (openingIndexes.length === 0) continue;

    const openingHigh = Math.max(...openingIndexes.map((idx) => highs[idx]));
    const openingLow = Math.min(...openingIndexes.map((idx) => lows[idx]));
    const openingRange = openingHigh - openingLow;
    if (!Number.isFinite(openingRange) || openingRange <= 0) continue;
    const openingRangePct = (openingRange / Math.max(1, opens[openingIndexes[0]])) * 100;
    if (openingRangePct < minOpeningRangePct) continue;

    // Middle 40% of the opening range is no-trade area.
    const zoneLow = openingLow + openingRange * 0.3;
    const zoneHigh = openingHigh - openingRange * 0.3;
    const levelBuffer = openingRange * (retestBufferPct / 100);

    let tradesToday = 0;
    let longBreakIndex = -1;
    let shortBreakIndex = -1;
    let longRetestConsumed = false;
    let shortRetestConsumed = false;

    for (let i = openingIndexes[openingIndexes.length - 1] + 1; i < dayCandles.length; i += 1) {
      if (tradesToday >= maxTradesPerDay) break;

      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes < 570 || clock.minutes > 900) continue;

      const open = opens[i];
      const high = highs[i];
      const low = lows[i];
      const close = closes[i];
      const range = Math.max(0.0001, high - low);
      const body = Math.abs(close - open);
      const bodyPct = body / range;
      const avgPrevRange =
        i >= 5 ? highs.slice(i - 5, i).map((h, j) => h - lows[i - 5 + j]).reduce((a, v) => a + v, 0) / 5 : range;
      const strongBullish =
        close > open && bodyPct >= minBreakoutBodyPct && range >= avgPrevRange * breakoutRangeMult;
      const strongBearish =
        close < open && bodyPct >= minBreakoutBodyPct && range >= avgPrevRange * breakoutRangeMult;
      const inNoTradeZone = close >= zoneLow && close <= zoneHigh;

      if (close > pdo && !inNoTradeZone && longBreakIndex === -1 && close > openingHigh && strongBullish) {
        longBreakIndex = i;
        continue;
      }
      if (close < pdo && !inNoTradeZone && shortBreakIndex === -1 && close < openingLow && strongBearish) {
        shortBreakIndex = i;
        continue;
      }

      if (longBreakIndex >= 0 && !longRetestConsumed && i > longBreakIndex && close > pdo) {
        const touchedLevel = low <= openingHigh + levelBuffer;
        if (touchedLevel) {
          longRetestConsumed = true;
          const lowerWick = Math.max(0, Math.min(open, close) - low);
          const rejection = close > open && lowerWick >= body;
          const confirm = rejection || strongBullish;
          if (confirm && !inNoTradeZone) {
            const entrySpot = close;
            const side = 'LONG';
            const optionType = 'CE';
            const strike = Math.round(entrySpot / strikeStep) * strikeStep;
            const entryPremium = Math.max(1, (entrySpot * basePremiumPct) / 100);
            const stopPremium = Math.max(0.05, entryPremium * (1 - stopLossPct / 100));
            const targetPremium = entryPremium * (1 + targetPct / 100);
              let exitIndex = dayCandles.length - 1;
              let exitSpot = closes[exitIndex];
              let exitPremium = getOptionPremiumFromSpotMove({
                side,
                entrySpot,
                currentSpot: exitSpot,
                entryPremium,
                premiumLeverage,
              });
              let reason = 'DAY_CLOSE';

              for (let j = i + 1; j < dayCandles.length; j += 1) {
                const favorablePremium = getOptionPremiumFromSpotMove({
                  side,
                  entrySpot,
                  currentSpot: highs[j],
                  entryPremium,
                  premiumLeverage,
                });
                const adversePremium = getOptionPremiumFromSpotMove({
                  side,
                  entrySpot,
                  currentSpot: lows[j],
                  entryPremium,
                  premiumLeverage,
                });
                const closePremium = getOptionPremiumFromSpotMove({
                  side,
                  entrySpot,
                  currentSpot: closes[j],
                  entryPremium,
                  premiumLeverage,
                });

                if (adversePremium <= stopPremium) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = stopPremium;
                  reason = 'STOP_LOSS';
                  break;
                }
                if (favorablePremium >= targetPremium) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = targetPremium;
                  reason = 'TARGET';
                  break;
                }
                if (j - i >= maxHoldCandles) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = closePremium;
                  reason = 'TIME_EXIT';
                  break;
                }
                const jClock = getIstClock(dayCandles[j][0]);
                if (jClock.minutes >= 930) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = closePremium;
                  reason = 'DAY_CLOSE';
                  break;
                }
              }

              const invested = entryPremium * lotSize * lotCount;
              const finalValue = exitPremium * lotSize * lotCount;
              const pnl = finalValue - invested;
              trades.push({
                pair: symbol,
                type: optionType,
                strike,
                buyPrice: Number(entryPremium.toFixed(2)),
                sellPrice: Number(exitPremium.toFixed(2)),
                lotSize,
                lots: lotCount,
                invested: Number(invested.toFixed(2)),
                finalValue: Number(finalValue.toFixed(2)),
                closed: optionType,
                order: 'BUY',
                entryTime: dayCandles[i][0],
                exitTime: dayCandles[exitIndex][0],
                entryPrice: Number(entrySpot.toFixed(2)),
                exitPrice: Number(exitSpot.toFixed(2)),
                stopLoss: Number(stopPremium.toFixed(2)),
                target: Number(targetPremium.toFixed(2)),
                qty: lotSize * lotCount,
                premium: Number(entryPremium.toFixed(2)),
                lotCount,
                investmentAmount: Number(invested.toFixed(2)),
                stopLossAmount: Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2)),
                targetAmount: Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2)),
                pnl: Number(pnl.toFixed(2)),
                pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
                reason,
              });
              tradesToday += 1;
          }
        }
      }

      if (shortBreakIndex >= 0 && !shortRetestConsumed && i > shortBreakIndex && close < pdo) {
        const touchedLevel = high >= openingLow - levelBuffer;
        if (touchedLevel) {
          shortRetestConsumed = true;
          const upperWick = Math.max(0, high - Math.max(open, close));
          const rejection = close < open && upperWick >= body;
          const confirm = rejection || strongBearish;
          if (confirm && !inNoTradeZone) {
            const entrySpot = close;
            const side = 'SHORT';
            const optionType = 'PE';
            const strike = Math.round(entrySpot / strikeStep) * strikeStep;
            const entryPremium = Math.max(1, (entrySpot * basePremiumPct) / 100);
            const stopPremium = Math.max(0.05, entryPremium * (1 - stopLossPct / 100));
            const targetPremium = entryPremium * (1 + targetPct / 100);
              let exitIndex = dayCandles.length - 1;
              let exitSpot = closes[exitIndex];
              let exitPremium = getOptionPremiumFromSpotMove({
                side,
                entrySpot,
                currentSpot: exitSpot,
                entryPremium,
                premiumLeverage,
              });
              let reason = 'DAY_CLOSE';

              for (let j = i + 1; j < dayCandles.length; j += 1) {
                const favorablePremium = getOptionPremiumFromSpotMove({
                  side,
                  entrySpot,
                  currentSpot: lows[j],
                  entryPremium,
                  premiumLeverage,
                });
                const adversePremium = getOptionPremiumFromSpotMove({
                  side,
                  entrySpot,
                  currentSpot: highs[j],
                  entryPremium,
                  premiumLeverage,
                });
                const closePremium = getOptionPremiumFromSpotMove({
                  side,
                  entrySpot,
                  currentSpot: closes[j],
                  entryPremium,
                  premiumLeverage,
                });

                if (adversePremium <= stopPremium) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = stopPremium;
                  reason = 'STOP_LOSS';
                  break;
                }
                if (favorablePremium >= targetPremium) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = targetPremium;
                  reason = 'TARGET';
                  break;
                }
                if (j - i >= maxHoldCandles) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = closePremium;
                  reason = 'TIME_EXIT';
                  break;
                }
                const jClock = getIstClock(dayCandles[j][0]);
                if (jClock.minutes >= 930) {
                  exitIndex = j;
                  exitSpot = closes[j];
                  exitPremium = closePremium;
                  reason = 'DAY_CLOSE';
                  break;
                }
              }

              const invested = entryPremium * lotSize * lotCount;
              const finalValue = exitPremium * lotSize * lotCount;
              const pnl = finalValue - invested;
              trades.push({
                pair: symbol,
                type: optionType,
                strike,
                buyPrice: Number(entryPremium.toFixed(2)),
                sellPrice: Number(exitPremium.toFixed(2)),
                lotSize,
                lots: lotCount,
                invested: Number(invested.toFixed(2)),
                finalValue: Number(finalValue.toFixed(2)),
                closed: optionType,
                order: 'BUY',
                entryTime: dayCandles[i][0],
                exitTime: dayCandles[exitIndex][0],
                entryPrice: Number(entrySpot.toFixed(2)),
                exitPrice: Number(exitSpot.toFixed(2)),
                stopLoss: Number(stopPremium.toFixed(2)),
                target: Number(targetPremium.toFixed(2)),
                qty: lotSize * lotCount,
                premium: Number(entryPremium.toFixed(2)),
                lotCount,
                investmentAmount: Number(invested.toFixed(2)),
                stopLossAmount: Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2)),
                targetAmount: Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2)),
                pnl: Number(pnl.toFixed(2)),
                pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
                reason,
              });
              tradesToday += 1;
          }
        }
      }
    }
  }

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const netPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);

  return {
    summary: {
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(2)) : 0,
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
    },
    trades,
  };
}

function runStrategyOneSimple({ candles, settings }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const lotSize = Math.max(1, Number(settings.lotSize) || getLotSize(symbol));
  const lotCount = Math.max(1, Number(settings.lotCount) || 1);
  const basePremiumPct = Math.max(0.05, Number(settings.basePremiumPct) || 0.85);
  const premiumLeverage = Math.max(1, Number(settings.premiumLeverage) || 8);
  const emaPeriod = Math.max(5, Number(settings.emaPeriod) || 20);
  const breakoutLookback = Math.max(2, Number(settings.breakoutLookback) || 3);
  const stopLossPct = Math.max(0.5, Number(settings.stopLossPct) || 10);
  const targetPct = Math.max(0.5, Number(settings.targetPct) || 12);
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay) || 3);
  const maxHoldCandles = Math.max(1, Number(settings.maxHoldCandles) || 12);
  const strikeStep = Math.max(1, Number(settings.strikeStep) || getStrikeStep(symbol));

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const trades = [];
  for (const [, dayCandles] of byDay.entries()) {
    if (dayCandles.length <= Math.max(emaPeriod, breakoutLookback + 1)) continue;

    const closes = dayCandles.map((c) => Number(c[4]));
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const ema = calculateEma(closes, emaPeriod);

    let tradesToday = 0;
    for (
      let i = Math.max(emaPeriod, breakoutLookback);
      i < dayCandles.length && tradesToday < maxTradesPerDay;
      i += 1
    ) {
      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes < 570 || clock.minutes > 900) continue;
      if (ema[i] === null) continue;

      const prevHigh = Math.max(...highs.slice(i - breakoutLookback, i));
      const prevLow = Math.min(...lows.slice(i - breakoutLookback, i));

      const longSignal = closes[i] > ema[i] && closes[i] > prevHigh;
      const shortSignal = closes[i] < ema[i] && closes[i] < prevLow;
      if (!longSignal && !shortSignal) continue;

      const side = longSignal ? 'LONG' : 'SHORT';
      const optionType = side === 'LONG' ? 'CE' : 'PE';
      const entrySpot = closes[i];
      const strike = Math.round(entrySpot / strikeStep) * strikeStep;
      const entryPremium = Math.max(1, (entrySpot * basePremiumPct) / 100);
      const stopPremium = Math.max(0.05, entryPremium * (1 - stopLossPct / 100));
      const targetPremium = entryPremium * (1 + targetPct / 100);

      let exitIndex = dayCandles.length - 1;
      let exitReason = 'DAY_CLOSE';
      let exitPremium = getOptionPremiumFromSpotMove({
        side,
        entrySpot,
        currentSpot: closes[exitIndex],
        entryPremium,
        premiumLeverage,
      });
      let exitSpot = closes[exitIndex];

      for (let j = i + 1; j < dayCandles.length; j += 1) {
        const favorableSpot = side === 'LONG' ? highs[j] : lows[j];
        const adverseSpot = side === 'LONG' ? lows[j] : highs[j];
        const favorablePremium = getOptionPremiumFromSpotMove({
          side,
          entrySpot,
          currentSpot: favorableSpot,
          entryPremium,
          premiumLeverage,
        });
        const adversePremium = getOptionPremiumFromSpotMove({
          side,
          entrySpot,
          currentSpot: adverseSpot,
          entryPremium,
          premiumLeverage,
        });
        const closePremium = getOptionPremiumFromSpotMove({
          side,
          entrySpot,
          currentSpot: closes[j],
          entryPremium,
          premiumLeverage,
        });

        if (adversePremium <= stopPremium) {
          exitIndex = j;
          exitReason = 'STOP_LOSS';
          exitPremium = stopPremium;
          exitSpot = closes[j];
          break;
        }
        if (favorablePremium >= targetPremium) {
          exitIndex = j;
          exitReason = 'TARGET';
          exitPremium = targetPremium;
          exitSpot = closes[j];
          break;
        }
        if (j - i >= maxHoldCandles) {
          exitIndex = j;
          exitReason = 'TIME_EXIT';
          exitPremium = closePremium;
          exitSpot = closes[j];
          break;
        }

        const jClock = getIstClock(dayCandles[j][0]);
        // Hold until the real session close candle (15:30 IST).
        if (jClock.minutes >= 930) {
          exitIndex = j;
          exitReason = 'DAY_CLOSE';
          exitPremium = closePremium;
          exitSpot = closes[j];
          break;
        }
      }

      const invested = entryPremium * lotSize * lotCount;
      const finalValue = exitPremium * lotSize * lotCount;
      const pnl = finalValue - invested;

      trades.push({
        pair: symbol,
        type: optionType,
        strike,
        buyPrice: Number(entryPremium.toFixed(2)),
        sellPrice: Number(exitPremium.toFixed(2)),
        lotSize,
        lots: lotCount,
        invested: Number(invested.toFixed(2)),
        finalValue: Number(finalValue.toFixed(2)),
        closed: optionType,
        order: 'BUY',
        entryTime: dayCandles[i][0],
        exitTime: dayCandles[exitIndex][0],
        entryPrice: Number(entrySpot.toFixed(2)),
        exitPrice: Number(exitSpot.toFixed(2)),
        stopLoss: Number(stopPremium.toFixed(2)),
        target: Number(targetPremium.toFixed(2)),
        qty: lotSize * lotCount,
        premium: Number(entryPremium.toFixed(2)),
        lotCount,
        investmentAmount: Number(invested.toFixed(2)),
        stopLossAmount: Number((Math.max(0, entryPremium - stopPremium) * lotSize * lotCount).toFixed(2)),
        targetAmount: Number((Math.max(0, targetPremium - entryPremium) * lotSize * lotCount).toFixed(2)),
        pnl: Number(pnl.toFixed(2)),
        pnlPct: invested > 0 ? Number(((pnl / invested) * 100).toFixed(2)) : 0,
        reason: exitReason,
      });
      tradesToday += 1;
      i = exitIndex;
    }
  }

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const netPnl = trades.reduce((acc, t) => acc + t.pnl, 0);
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);

  return {
    summary: {
      totalTrades,
      wins,
      losses: totalTrades - wins,
      winRate: totalTrades ? Number(((wins / totalTrades) * 100).toFixed(2)) : 0,
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)),
    },
    trades,
  };
}


async function fetchWithRateLimitRetry(args) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetchYearCandles(args);
    } catch (error) {
      const errorCode = error?.response?.data?.errorCode;
      if (errorCode === 'DH-904' && attempt < 3) {
        await sleep((attempt + 1) * 2000);
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

app.get('/api/data/candles', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BANKNIFTY').toUpperCase();
    const interval = String(req.query.interval || '1');
    const year = Number(req.query.year || 2025);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(1000, Math.max(50, Number(req.query.pageSize) || 200));
    const refresh = String(req.query.refresh || 'false') === 'true';
    const cacheKey = `${symbol}:${interval}:${year}`;

    let payload = yearCache.get(cacheKey);
    if (!payload || refresh || Date.now() - payload.fetchedAt > CACHE_TTL_MS) {
      if (!inflightRequests.has(cacheKey)) {
        inflightRequests.set(
          cacheKey,
          fetchWithRateLimitRetry({ symbol, interval, year }).finally(() => {
            inflightRequests.delete(cacheKey);
          })
        );
      }
      const fresh = await inflightRequests.get(cacheKey);
      payload = { ...fresh, fetchedAt: Date.now() };
      yearCache.set(cacheKey, payload);
    }

    const totalRows = payload.rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const candles = payload.rows.slice(start, start + pageSize);

    res.json({
      ok: true,
      source: refresh ? 'live-dhan' : 'live/cache',
      symbol,
      interval,
      year,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      pagination: { page: currentPage, pageSize, totalRows, totalPages },
      data: { candles },
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({
        ok: false,
        error: 'Dhan API error',
        details: error.response.data,
      });
    }
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/strategy1/run', async (req, res) => {
  try {
    const {
      symbol = 'NIFTY',
      interval = '5',
      year = 2025,
      basePremiumPct = 0.85,
      lotCount = 1,
      lotSize = getLotSize(symbol),
      premiumLeverage = 8,
      stopLossPct = 10,
      targetPct = 20,
      maxTradesPerDay = 1,
      maxHoldCandles = 18,
      minBreakoutBodyPct = 0.6,
      breakoutRangeMult = 1.2,
      minOpeningRangePct = 0.15,
      retestBufferPct = 0.03,
      strikeStep = getStrikeStep(symbol),
    } = req.body || {};

    const payload = await fetchWithRateLimitRetry({
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
    });

    const result = runStrategyTwo({
      candles: payload.rows,
      settings: {
        symbol: String(symbol).toUpperCase(),
        basePremiumPct: Number(basePremiumPct),
        lotCount: Number(lotCount),
        lotSize: Number(lotSize),
        premiumLeverage: Number(premiumLeverage),
        stopLossPct: Number(stopLossPct),
        targetPct: Number(targetPct),
        maxTradesPerDay: Number(maxTradesPerDay),
        maxHoldCandles: Number(maxHoldCandles),
        minBreakoutBodyPct: Number(minBreakoutBodyPct),
        breakoutRangeMult: Number(breakoutRangeMult),
        minOpeningRangePct: Number(minOpeningRangePct),
        retestBufferPct: Number(retestBufferPct),
        strikeStep: Number(strikeStep),
      },
    });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy1_breakout_retest',
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
      settings: {
        basePremiumPct: Number(basePremiumPct),
        lotCount: Number(lotCount),
        lotSize: Number(lotSize),
        premiumLeverage: Number(premiumLeverage),
        stopLossPct: Number(stopLossPct),
        targetPct: Number(targetPct),
        maxTradesPerDay: Number(maxTradesPerDay),
        maxHoldCandles: Number(maxHoldCandles),
        minBreakoutBodyPct: Number(minBreakoutBodyPct),
        breakoutRangeMult: Number(breakoutRangeMult),
        minOpeningRangePct: Number(minOpeningRangePct),
        retestBufferPct: Number(retestBufferPct),
        strikeStep: Number(strikeStep),
      },
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          runId: runDoc._id,
          strategyKey: 'strategy1_breakout_retest',
          pair: t.pair,
          type: t.type,
          strike: t.strike,
          buyPrice: t.buyPrice,
          sellPrice: t.sellPrice,
          lots: t.lots,
          invested: t.invested,
          finalValue: t.finalValue,
          closed: t.closed,
          order: t.order,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          stopLoss: t.stopLoss,
          target: t.target,
          qty: t.qty,
          premium: t.premium,
          lotCount: t.lotCount,
          lotSize: t.lotSize,
          investmentAmount: t.investmentAmount,
          stopLossAmount: t.stopLossAmount,
          targetAmount: t.targetAmount,
          pnl: t.pnl,
          pnlPct: t.pnlPct,
          reason: t.reason,
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 1 - 15M Breakout + First Retest',
      year: Number(year),
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      summary: result.summary,
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
  }
});

app.get('/api/strategy1/runs/:runId/trades', async (req, res) => {
  try {
    const { runId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 25));

    const totalRows = await StrategyTrade.countDocuments({
      runId,
      strategyKey: 'strategy1_breakout_retest',
    });
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find({
      runId,
      strategyKey: 'strategy1_breakout_retest',
    })
      .sort({ entryTime: 1 })
      .skip(skip)
      .limit(pageSize)
      .lean();

    res.json({
      ok: true,
      runId,
      trades,
      pagination: { page: currentPage, pageSize, totalRows, totalPages },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/backtest/run', (req, res) => {
  const { symbol, from, to } = req.body || {};
  if (!symbol || !from || !to) {
    return res.status(400).json({
      error: 'symbol, from, and to (ISO dates) are required',
    });
  }
  res.json({
    message: 'Backtest runner not implemented yet — add strategy logic next.',
    received: { symbol, from, to },
  });
});

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI missing in backend .env');
  }
  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');
  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});

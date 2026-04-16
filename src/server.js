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

function getPositionSize(entryPrice, investmentAmount, fallbackQty = 1) {
  const safeEntryPrice = Number(entryPrice);
  const safeInvestmentAmount = Number(investmentAmount);
  const safeFallbackQty = Math.max(1, Number(fallbackQty) || 1);
  if (!Number.isFinite(safeEntryPrice) || safeEntryPrice <= 0) return safeFallbackQty;
  if (!Number.isFinite(safeInvestmentAmount) || safeInvestmentAmount <= 0) return safeFallbackQty;
  return safeInvestmentAmount / safeEntryPrice;
}

function getLotSize(symbol) {
  const resolvedSymbol = String(symbol || 'BANKNIFTY').toUpperCase();
  return DEFAULT_LOT_SIZES[resolvedSymbol] || 1;
}

function getTradeSizing({ symbol, premium, lotCount, lotSize, investmentAmount, qty }) {
  const resolvedLotSize = Math.max(1, Number(lotSize) || getLotSize(symbol));
  const resolvedLotCount = Math.max(1, Number(lotCount) || 1);
  const resolvedPremium = Math.max(0, Number(premium) || 0);
  const autoInvestmentAmount = resolvedPremium * resolvedLotSize * resolvedLotCount;
  const resolvedInvestmentAmount =
    autoInvestmentAmount > 0 ? autoInvestmentAmount : Math.max(0, Number(investmentAmount) || 0);

  return {
    premium: resolvedPremium,
    lotCount: resolvedLotCount,
    lotSize: resolvedLotSize,
    investmentAmount: resolvedInvestmentAmount,
    fallbackQty: Math.max(1, Number(qty) || 1),
  };
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

function calculateSma(values, period) {
  const out = Array(values.length).fill(null);
  let rollingSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = Number(values[i]);
    if (Number.isNaN(v)) continue;
    rollingSum += v;
    if (i >= period) {
      rollingSum -= Number(values[i - period]);
    }
    if (i >= period - 1) {
      out[i] = rollingSum / period;
    }
  }
  return out;
}

function calculateMacd(values) {
  const ema12 = calculateEma(values, 12);
  const ema26 = calculateEma(values, 26);
  const macd = values.map((_, i) =>
    ema12[i] === null || ema26[i] === null ? null : ema12[i] - ema26[i]
  );
  const signal = calculateEma(macd.map((v) => (v === null ? 0 : v)), 9);
  return { macd, signal };
}

function calculateAdx(highs, lows, closes, period = 14) {
  const len = closes.length;
  const plusDI = Array(len).fill(null);
  const minusDI = Array(len).fill(null);
  const adx = Array(len).fill(null);
  if (len < period + 2) return { plusDI, minusDI, adx };

  const tr = Array(len).fill(0);
  const pdm = Array(len).fill(0);
  const mdm = Array(len).fill(0);

  for (let i = 1; i < len; i += 1) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    pdm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    mdm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const tr1 = highs[i] - lows[i];
    const tr2 = Math.abs(highs[i] - closes[i - 1]);
    const tr3 = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(tr1, tr2, tr3);
  }

  let trSum = 0;
  let pdmSum = 0;
  let mdmSum = 0;
  for (let i = 1; i <= period; i += 1) {
    trSum += tr[i];
    pdmSum += pdm[i];
    mdmSum += mdm[i];
  }

  const dx = Array(len).fill(null);
  for (let i = period + 1; i < len; i += 1) {
    trSum = trSum - trSum / period + tr[i];
    pdmSum = pdmSum - pdmSum / period + pdm[i];
    mdmSum = mdmSum - mdmSum / period + mdm[i];
    if (trSum === 0) continue;
    plusDI[i] = (100 * pdmSum) / trSum;
    minusDI[i] = (100 * mdmSum) / trSum;
    const denom = plusDI[i] + minusDI[i];
    dx[i] = denom === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / denom;
  }

  let adxSeedCount = 0;
  let adxSeed = 0;
  for (let i = period + 1; i < len; i += 1) {
    if (dx[i] !== null) {
      adxSeed += dx[i];
      adxSeedCount += 1;
    }
    if (adxSeedCount === period) {
      adx[i] = adxSeed / period;
      for (let j = i + 1; j < len; j += 1) {
        if (dx[j] === null || adx[j - 1] === null) continue;
        adx[j] = (adx[j - 1] * (period - 1) + dx[j]) / period;
      }
      break;
    }
  }

  return { plusDI, minusDI, adx };
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

function runStrategyOne({ candles, settings }) {
  const closes = candles.map((c) => Number(c[4]));
  const highs = candles.map((c) => Number(c[2]));
  const lows = candles.map((c) => Number(c[3]));
  const ema = calculateEma(closes, settings.emaPeriod);
  const { macd, signal } = calculateMacd(closes);
  const { plusDI, minusDI, adx } = calculateAdx(highs, lows, closes, 14);

  let position = null;
  const trades = [];
  const stopLossPct = Math.max(0.1, Number(settings.stopLossPct));
  const sizing = getTradeSizing(settings);

  function closePosition(i, reason) {
    if (!position) return;
    const price = closes[i];
    const pnl =
      position.side === 'LONG'
        ? (price - position.entryPrice) * position.positionSize
        : (position.entryPrice - price) * position.positionSize;
    trades.push({
      pair: settings.symbol,
      closed: position.side,
      order: position.side === 'LONG' ? 'SELL' : 'BUY',
      entryTime: position.entryTime,
      exitTime: candles[i][0],
      entryPrice: position.entryPrice,
      exitPrice: price,
      qty: Number(position.positionSize.toFixed(4)),
      premium: Number(position.premium.toFixed(2)),
      lotCount: position.lotCount,
      lotSize: position.lotSize,
      investmentAmount: Number(position.investmentAmount.toFixed(2)),
      stopLossAmount: Number(position.stopLossAmount.toFixed(2)),
      pnl: Number(pnl.toFixed(2)),
      pnlPct: Number(((pnl / position.investmentAmount) * 100).toFixed(2)),
      reason,
    });
    position = null;
  }

  for (let i = 30; i < candles.length; i += 1) {
    if (
      ema[i] === null ||
      macd[i] === null ||
      signal[i] === null ||
      adx[i] === null ||
      plusDI[i] === null ||
      minusDI[i] === null
    ) {
      continue;
    }

    const close = closes[i];
    const longSignal =
      plusDI[i] > minusDI[i] &&
      macd[i] > signal[i] &&
      close > ema[i] &&
      adx[i] >= Number(settings.adxThreshold);
    const shortSignal =
      minusDI[i] > plusDI[i] &&
      macd[i] < signal[i] &&
      close < ema[i] &&
      adx[i] >= Number(settings.adxThreshold);

    if (position) {
      const lossPnl =
        position.side === 'LONG'
          ? (close - position.entryPrice) * position.positionSize
          : (position.entryPrice - close) * position.positionSize;
      if (lossPnl <= -position.stopLossAmount) {
        closePosition(i, 'STOP_LOSS');
      }
    }

    if (longSignal) {
      if (!position) {
        position = {
          side: 'LONG',
          entryPrice: close,
          entryTime: candles[i][0],
          positionSize: getPositionSize(close, sizing.investmentAmount, sizing.fallbackQty),
          premium: sizing.premium,
          lotCount: sizing.lotCount,
          lotSize: sizing.lotSize,
          investmentAmount:
            sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1),
          stopLossAmount:
            (sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1)) * (stopLossPct / 100),
        };
      } else if (position.side === 'SHORT') {
        closePosition(i, 'REVERSAL_LONG');
        position = {
          side: 'LONG',
          entryPrice: close,
          entryTime: candles[i][0],
          positionSize: getPositionSize(close, sizing.investmentAmount, sizing.fallbackQty),
          premium: sizing.premium,
          lotCount: sizing.lotCount,
          lotSize: sizing.lotSize,
          investmentAmount:
            sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1),
          stopLossAmount:
            (sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1)) * (stopLossPct / 100),
        };
      }
    } else if (shortSignal) {
      if (!position) {
        position = {
          side: 'SHORT',
          entryPrice: close,
          entryTime: candles[i][0],
          positionSize: getPositionSize(close, sizing.investmentAmount, sizing.fallbackQty),
          premium: sizing.premium,
          lotCount: sizing.lotCount,
          lotSize: sizing.lotSize,
          investmentAmount:
            sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1),
          stopLossAmount:
            (sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1)) * (stopLossPct / 100),
        };
      } else if (position.side === 'LONG') {
        closePosition(i, 'REVERSAL_SHORT');
        position = {
          side: 'SHORT',
          entryPrice: close,
          entryTime: candles[i][0],
          positionSize: getPositionSize(close, sizing.investmentAmount, sizing.fallbackQty),
          premium: sizing.premium,
          lotCount: sizing.lotCount,
          lotSize: sizing.lotSize,
          investmentAmount:
            sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1),
          stopLossAmount:
            (sizing.investmentAmount > 0
              ? sizing.investmentAmount
              : close * Math.max(1, sizing.fallbackQty || 1)) * (stopLossPct / 100),
        };
      }
    }
  }

  if (position) closePosition(candles.length - 1, 'FINAL_CLOSE');

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

function runStrategyTwo({ candles, settings }) {
  const symbol = String(settings.symbol || 'BANKNIFTY').toUpperCase();
  const qty = Number(settings.qty);
  const lookback = Math.max(2, Number(settings.momentumLookback));
  const momentumPct = Math.max(0.1, Number(settings.momentumPct));
  const relVolumeMult = Math.max(1, Number(settings.relVolumeMult));
  const emaPeriod = Math.max(2, Number(settings.emaPeriod));
  const stopLossPct = Math.max(0.05, Number(settings.stopLossPct));
  const targetRR = Math.max(1, Number(settings.targetRR));
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay));
  const maxHoldCandles = Math.max(1, Number(settings.maxHoldCandles));

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const trades = [];
  for (const [, dayCandles] of byDay.entries()) {
    if (dayCandles.length <= lookback + 2) continue;
    let tradesToday = 0;

    const closes = dayCandles.map((c) => Number(c[4]));
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const rawVolumes = dayCandles.map((c) => Number(c[5] ?? 0));
    const volumes = rawVolumes.map((v) => Math.max(1, v));
    const hasReliableVolume = rawVolumes.some((v) => v > 0);
    const ema = calculateEma(closes, emaPeriod);

    const vwap = [];
    let cumulativePV = 0;
    let cumulativeVolume = 0;
    for (let i = 0; i < dayCandles.length; i += 1) {
      const typicalPrice = (highs[i] + lows[i] + closes[i]) / 3;
      cumulativePV += typicalPrice * volumes[i];
      cumulativeVolume += volumes[i];
      vwap.push(cumulativePV / cumulativeVolume);
    }

    for (let i = lookback; i < dayCandles.length && tradesToday < maxTradesPerDay; i += 1) {
      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes < 570 || clock.minutes > 900) continue; // 9:30 to 15:00 entries
      if (ema[i] === null || i < lookback + 1) continue;

      const previousClose = closes[i - lookback];
      if (!previousClose) continue;
      const movePct = ((closes[i] - previousClose) / previousClose) * 100;
      const avgVolume =
        volumes.slice(i - lookback, i).reduce((a, v) => a + v, 0) / lookback;
      const relativeVolume = avgVolume > 0 ? volumes[i] / avgVolume : 0;
      const volumePass = hasReliableVolume ? relativeVolume >= relVolumeMult : true;

      const bullishMomentum =
        movePct >= momentumPct &&
        volumePass &&
        closes[i] > vwap[i] &&
        closes[i] > ema[i] &&
        closes[i] > highs[i - 1];

      const bearishMomentum =
        movePct <= -momentumPct &&
        volumePass &&
        closes[i] < vwap[i] &&
        closes[i] < ema[i] &&
        closes[i] < lows[i - 1];

      if (!bullishMomentum && !bearishMomentum) continue;

      const side = bullishMomentum ? 'LONG' : 'SHORT';
      const entryPrice = closes[i];
      const structureLow = Math.min(...lows.slice(i - lookback, i + 1));
      const structureHigh = Math.max(...highs.slice(i - lookback, i + 1));
      const pctStopLong = entryPrice * (1 - stopLossPct / 100);
      const pctStopShort = entryPrice * (1 + stopLossPct / 100);

      const stopLoss =
        side === 'LONG'
          ? Math.max(pctStopLong, structureLow)
          : Math.min(pctStopShort, structureHigh);
      const risk =
        side === 'LONG' ? entryPrice - stopLoss : stopLoss - entryPrice;
      if (risk <= 0) continue;
      const target =
        side === 'LONG'
          ? entryPrice + risk * targetRR
          : entryPrice - risk * targetRR;

      let exitIndex = dayCandles.length - 1;
      let exitPrice = closes[exitIndex];
      let reason = 'DAY_CLOSE';

      for (let j = i + 1; j < dayCandles.length; j += 1) {
        if (side === 'LONG') {
          if (lows[j] <= stopLoss) {
            exitIndex = j;
            exitPrice = stopLoss;
            reason = 'STOP_LOSS';
            break;
          }
          if (highs[j] >= target) {
            exitIndex = j;
            exitPrice = target;
            reason = 'TARGET';
            break;
          }
        } else {
          if (highs[j] >= stopLoss) {
            exitIndex = j;
            exitPrice = stopLoss;
            reason = 'STOP_LOSS';
            break;
          }
          if (lows[j] <= target) {
            exitIndex = j;
            exitPrice = target;
            reason = 'TARGET';
            break;
          }
        }

        if (j - i >= maxHoldCandles) {
          exitIndex = j;
          exitPrice = closes[j];
          reason = 'TIME_EXIT';
          break;
        }
      }

      const pnl =
        side === 'LONG'
          ? (exitPrice - entryPrice) * qty
          : (entryPrice - exitPrice) * qty;
      trades.push({
        pair: symbol,
        closed: side,
        order: side === 'LONG' ? 'SELL' : 'BUY',
        entryTime: dayCandles[i][0],
        exitTime: dayCandles[exitIndex][0],
        entryPrice: Number(entryPrice.toFixed(2)),
        exitPrice: Number(exitPrice.toFixed(2)),
        stopLoss: Number(stopLoss.toFixed(2)),
        target: Number(target.toFixed(2)),
        qty,
        pnl: Number(pnl.toFixed(2)),
        reason,
      });
      tradesToday += 1;
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

function runStrategyFour({ candles, settings }) {
  const symbol = String(settings.symbol || 'BANKNIFTY').toUpperCase();
  const sizing = getTradeSizing({ ...settings, symbol });
  const maPeriod = Math.max(5, Number(settings.maPeriod));
  const stopLossPct = Math.max(0.1, Number(settings.stopLossPct));
  const takeProfitPct = Math.max(0.1, Number(settings.takeProfitPct));
  const maxTradesPerDay = Math.max(1, Number(settings.maxTradesPerDay));
  const useCrashFilter = settings.useCrashFilter !== false;
  const crashFilterPct = Math.max(0.2, Number(settings.crashFilterPct));
  const maxHoldCandles = Math.max(1, Number(settings.maxHoldCandles));

  const byDay = new Map();
  for (const c of candles) {
    const clock = getIstClock(c[0]);
    if (clock.minutes < 555 || clock.minutes > 930) continue;
    if (!byDay.has(clock.dateKey)) byDay.set(clock.dateKey, []);
    byDay.get(clock.dateKey).push(c);
  }

  const trades = [];
  for (const [, dayCandles] of byDay.entries()) {
    if (dayCandles.length < maPeriod + 2) continue;
    const closes = dayCandles.map((c) => Number(c[4]));
    const highs = dayCandles.map((c) => Number(c[2]));
    const lows = dayCandles.map((c) => Number(c[3]));
    const ma = calculateSma(closes, maPeriod);

    let tradesToday = 0;
    let position = null;

    for (let i = 1; i < dayCandles.length && tradesToday < maxTradesPerDay; i += 1) {
      const clock = getIstClock(dayCandles[i][0]);
      if (clock.minutes < 560 || clock.minutes > 915) continue;
      if (ma[i] === null) continue;

      if (position) {
        let exitPrice = null;
        let reason = null;
        const lowPnl =
          position.side === 'LONG'
            ? (lows[i] - position.entryPrice) * position.positionSize
            : (position.entryPrice - highs[i]) * position.positionSize;
        const highPnl =
          position.side === 'LONG'
            ? (highs[i] - position.entryPrice) * position.positionSize
            : (position.entryPrice - lows[i]) * position.positionSize;

        if (lowPnl <= -position.stopLossAmount) {
          const lossMove = position.stopLossAmount / position.positionSize;
          exitPrice =
            position.side === 'LONG'
              ? position.entryPrice - lossMove
              : position.entryPrice + lossMove;
          reason = 'STOP_LOSS';
        } else if (highPnl >= position.targetAmount) {
          const targetMove = position.targetAmount / position.positionSize;
          exitPrice =
            position.side === 'LONG'
              ? position.entryPrice + targetMove
              : position.entryPrice - targetMove;
          reason = 'TARGET';
        }

        if (exitPrice === null && i - position.entryIndex >= maxHoldCandles) {
          exitPrice = closes[i];
          reason = 'TIME_EXIT';
        }

        if (exitPrice === null && clock.minutes >= 925) {
          exitPrice = closes[i];
          reason = 'DAY_CLOSE';
        }

        if (exitPrice !== null) {
          const pnl =
            position.side === 'LONG'
              ? (exitPrice - position.entryPrice) * position.positionSize
              : (position.entryPrice - exitPrice) * position.positionSize;
          trades.push({
            pair: symbol,
            closed: position.side,
            order: position.side === 'LONG' ? 'SELL' : 'BUY',
            entryTime: position.entryTime,
            exitTime: dayCandles[i][0],
            entryPrice: Number(position.entryPrice.toFixed(2)),
            exitPrice: Number(exitPrice.toFixed(2)),
            stopLoss: Number(position.stopLoss.toFixed(2)),
            target: Number(position.target.toFixed(2)),
            qty: Number(position.positionSize.toFixed(4)),
            premium: Number(position.premium.toFixed(2)),
            lotCount: position.lotCount,
            lotSize: position.lotSize,
            investmentAmount: Number(position.investmentAmount.toFixed(2)),
            stopLossAmount: Number(position.stopLossAmount.toFixed(2)),
            targetAmount: Number(position.targetAmount.toFixed(2)),
            pnl: Number(pnl.toFixed(2)),
            pnlPct: Number(((pnl / position.investmentAmount) * 100).toFixed(2)),
            reason,
          });
          position = null;
        }
      }

      if (position || tradesToday >= maxTradesPerDay) continue;

      const deviation = ((closes[i] - ma[i]) / ma[i]) * 100;
      const prevDeviation = ((closes[i - 1] - ma[i - 1]) / ma[i - 1]) * 100;
      const recentMovePct = i > 0 ? ((closes[i] - closes[i - 1]) / closes[i - 1]) * 100 : 0;

      // Mean-reversion confirmation:
      // 1) Previous candle was stretched away from the mean
      // 2) Current candle starts reverting back toward the mean
      const longSignal =
        deviation > prevDeviation &&
        prevDeviation < 0 &&
        deviation < 0 &&
        (!useCrashFilter || recentMovePct > -crashFilterPct);
      const shortSignal =
        deviation < prevDeviation &&
        prevDeviation > 0 &&
        deviation > 0 &&
        (!useCrashFilter || recentMovePct < crashFilterPct);

      if (!longSignal && !shortSignal) continue;

      const side = longSignal ? 'LONG' : 'SHORT';
      const entryPrice = closes[i];
      const positionSize = getPositionSize(entryPrice, sizing.investmentAmount, sizing.fallbackQty);
      const tradeCapital =
        sizing.investmentAmount > 0
          ? sizing.investmentAmount
          : entryPrice * Math.max(1, sizing.fallbackQty || 1);
      const stopLossAmount = tradeCapital * (stopLossPct / 100);
      const targetAmount = tradeCapital * (takeProfitPct / 100);
      const lossMove = stopLossAmount / positionSize;
      const targetMove = targetAmount / positionSize;
      const stopLoss = side === 'LONG' ? entryPrice - lossMove : entryPrice + lossMove;
      const target = side === 'LONG' ? entryPrice + targetMove : entryPrice - targetMove;

      position = {
        side,
        entryPrice,
        premium: sizing.premium,
        lotCount: sizing.lotCount,
        lotSize: sizing.lotSize,
        stopLoss,
        target,
        positionSize,
        investmentAmount: tradeCapital,
        stopLossAmount,
        targetAmount,
        entryIndex: i,
        entryTime: dayCandles[i][0],
      };
      tradesToday += 1;
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
      symbol = 'BANKNIFTY',
      interval = '15',
      year = 2025,
      qty = 1,
      premium = 183,
      lotCount = 1,
      lotSize = getLotSize(symbol),
      investmentAmount = 100000,
      adxThreshold = 20,
      emaPeriod = 9,
      stopLossPct = 10,
    } = req.body || {};

    const payload = await fetchWithRateLimitRetry({
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
    });

    const result = runStrategyOne({
      candles: payload.rows,
      settings: {
        symbol: String(symbol).toUpperCase(),
        qty: Number(qty),
        premium: Number(premium),
        lotCount: Number(lotCount),
        lotSize: Number(lotSize),
        investmentAmount: Number(investmentAmount),
        adxThreshold: Number(adxThreshold),
        emaPeriod: Number(emaPeriod),
        stopLossPct: Number(stopLossPct),
      },
    });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy1_adx_macd_ema',
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
      settings: {
        qty: Number(qty),
        premium: Number(premium),
        lotCount: Number(lotCount),
        lotSize: Number(lotSize),
        investmentAmount: Number(investmentAmount),
        adxThreshold: Number(adxThreshold),
        emaPeriod: Number(emaPeriod),
        stopLossPct: Number(stopLossPct),
      },
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          runId: runDoc._id,
          strategyKey: 'strategy1_adx_macd_ema',
          pair: t.pair,
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
    const firstPageTrades = result.trades.slice(0, pageSize);

    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 1 - ADX MACD EMA Reversal',
      year: Number(year),
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      summary: result.summary,
      trades: firstPageTrades,
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

    const totalRows = await StrategyTrade.countDocuments({ runId });
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find({ runId })
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

app.post('/api/strategy2/run', async (req, res) => {
  try {
    const {
      symbol = 'BANKNIFTY',
      interval = '5',
      year = 2025,
      qty = 1,
      momentumLookback = 3,
      momentumPct = 0.4,
      relVolumeMult = 1.1,
      emaPeriod = 9,
      stopLossPct = 0.25,
      targetRR = 2,
      maxTradesPerDay = 30,
      maxHoldCandles = 6,
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
        qty: Number(qty),
        momentumLookback: Number(momentumLookback),
        momentumPct: Number(momentumPct),
        relVolumeMult: Number(relVolumeMult),
        emaPeriod: Number(emaPeriod),
        stopLossPct: Number(stopLossPct),
        targetRR: Number(targetRR),
        maxTradesPerDay: Number(maxTradesPerDay),
        maxHoldCandles: Number(maxHoldCandles),
      },
    });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy2_momentum',
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
      settings: {
        qty: Number(qty),
        momentumLookback: Number(momentumLookback),
        momentumPct: Number(momentumPct),
        relVolumeMult: Number(relVolumeMult),
        emaPeriod: Number(emaPeriod),
        stopLossPct: Number(stopLossPct),
        targetRR: Number(targetRR),
        maxTradesPerDay: Number(maxTradesPerDay),
        maxHoldCandles: Number(maxHoldCandles),
      },
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          runId: runDoc._id,
          strategyKey: 'strategy2_momentum',
          pair: t.pair,
          closed: t.closed,
          order: t.order,
          entryTime: new Date(t.entryTime),
          exitTime: new Date(t.exitTime),
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          stopLoss: t.stopLoss,
          target: t.target,
          qty: t.qty,
          pnl: t.pnl,
          reason: t.reason,
        }))
      );
    }

    const pageSize = 25;
    return res.json({
      ok: true,
      runId: runDoc._id,
      strategy: 'Strategy 2 - Momentum Trading',
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

app.get('/api/strategy2/runs/:runId/trades', async (req, res) => {
  try {
    const { runId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 25));

    const totalRows = await StrategyTrade.countDocuments({
      runId,
      strategyKey: 'strategy2_momentum',
    });
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find({
      runId,
      strategyKey: 'strategy2_momentum',
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

app.post('/api/strategy4/run', async (req, res) => {
  try {
    const {
      symbol = 'BANKNIFTY',
      interval = '5',
      year = 2025,
      qty = 1,
      premium = 183,
      lotCount = 1,
      lotSize = getLotSize(symbol),
      investmentAmount = 100000,
      maPeriod = 14,
      stopLossPct = 10,
      takeProfitPct = 1.2,
      maxTradesPerDay = 15,
      useCrashFilter = false,
      crashFilterPct = 1.2,
      maxHoldCandles = 12,
    } = req.body || {};

    const payload = await fetchWithRateLimitRetry({
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
    });

    const result = runStrategyFour({
      candles: payload.rows,
      settings: {
        symbol: String(symbol).toUpperCase(),
        qty: Number(qty),
        premium: Number(premium),
        lotCount: Number(lotCount),
        lotSize: Number(lotSize),
        investmentAmount: Number(investmentAmount),
        maPeriod: Number(maPeriod),
        stopLossPct: Number(stopLossPct),
        takeProfitPct: Number(takeProfitPct),
        maxTradesPerDay: Number(maxTradesPerDay),
        useCrashFilter: Boolean(useCrashFilter),
        crashFilterPct: Number(crashFilterPct),
        maxHoldCandles: Number(maxHoldCandles),
      },
    });

    const runDoc = await StrategyRun.create({
      strategyKey: 'strategy4_mean_reversion',
      symbol: String(symbol).toUpperCase(),
      interval: String(interval),
      year: Number(year),
      settings: {
        qty: Number(qty),
        premium: Number(premium),
        lotCount: Number(lotCount),
        lotSize: Number(lotSize),
        investmentAmount: Number(investmentAmount),
        maPeriod: Number(maPeriod),
        stopLossPct: Number(stopLossPct),
        takeProfitPct: Number(takeProfitPct),
        maxTradesPerDay: Number(maxTradesPerDay),
        useCrashFilter: Boolean(useCrashFilter),
        crashFilterPct: Number(crashFilterPct),
        maxHoldCandles: Number(maxHoldCandles),
      },
      summary: result.summary,
      status: 'completed',
    });

    if (result.trades.length > 0) {
      await StrategyTrade.insertMany(
        result.trades.map((t) => ({
          runId: runDoc._id,
          strategyKey: 'strategy4_mean_reversion',
          pair: t.pair,
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
      strategy: 'Strategy 4 - Mean Reversion',
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

app.get('/api/strategy4/runs/:runId/trades', async (req, res) => {
  try {
    const { runId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 25));

    const totalRows = await StrategyTrade.countDocuments({
      runId,
      strategyKey: 'strategy4_mean_reversion',
    });
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * pageSize;

    const trades = await StrategyTrade.find({
      runId,
      strategyKey: 'strategy4_mean_reversion',
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

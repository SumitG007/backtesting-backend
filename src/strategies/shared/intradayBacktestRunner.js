/**
 * Generic intraday long-option / spread backtest loop.
 */

const { getIstClock, parseClockMinutes } = require('../../utils/dateTime');
const { getOptionPremiumFromSpotMove } = require('../../utils/market');
const { buildStrategyRunSummary } = require('./summary');
const {
  buildIntradayByDay,
  pickStrike,
  simulateLongOptionExit,
  buildLongOptionTrade,
  parseCommonOptionSettings,
} = require('./intradayOptions');

function premiumAt({ side, entrySpot, currentSpot, entryPremium, strike, strikeStep, premiumLeverage }) {
  return getOptionPremiumFromSpotMove({
    side,
    entrySpot,
    currentSpot,
    entryPremium,
    premiumLeverage,
    strike,
    strikeStep,
  });
}

function runIntradaySignalBacktest({ execCandles, settings, minWarmup, findSignal, spreadMode = false }) {
  const symbol = String(settings.symbol || 'NIFTY').toUpperCase();
  const common = parseCommonOptionSettings(settings, symbol);
  const entryFromMinutes = parseClockMinutes(settings.entryFromTime, 555);
  const entryToMinutes = parseClockMinutes(settings.entryToTime, 915);
  const minBarsBetween = Math.max(1, Number(settings.minBarsBetweenTrades) || 3);
  const warmup = Math.max(20, minWarmup || 30);

  const intraByDay = buildIntradayByDay(execCandles || []);
  const trades = [];

  for (const [, dayBars] of intraByDay) {
    if (dayBars.length < warmup + 3) continue;

    const closes = dayBars.map((c) => Number(c[4]));
    const ctx = { dayBars, closes, settings };

    let dayTrades = 0;
    let lastEntry = -minBarsBetween;

    for (let j = warmup; j < dayBars.length - 1; j += 1) {
      if (dayTrades >= common.maxTradesPerDay) break;
      const clock = getIstClock(dayBars[j][0]);
      if (clock.minutes < entryFromMinutes || clock.minutes > entryToMinutes) continue;
      if (j - lastEntry < minBarsBetween) continue;

      const signal = findSignal(dayBars, j, ctx);
      if (!signal) continue;

      const entryIdx = j;
      const entrySpot = Number(dayBars[entryIdx][4]);
      if (!Number.isFinite(entrySpot) || entrySpot <= 0) continue;

      if (spreadMode && signal.spread) {
        const spread = signal.spread;
        const shortStrike = spread.shortStrike;
        const longStrike = spread.longStrike;
        const shortEntryPrem = Math.max(0.05, (entrySpot * common.basePremiumPct) / 100);
        const longEntryPrem = Math.max(
          0.05,
          shortEntryPrem * 0.45
        );
        const credit = (shortEntryPrem - longEntryPrem) * common.lotSize * common.lotCount;
        let exitIdx = dayBars.length - 1;
        let exitSpot = Number(dayBars[exitIdx][4]);
        let reason = 'DAY_CLOSE';
        for (let k = entryIdx + 1; k < dayBars.length; k += 1) {
          const cl = Number(dayBars[k][4]);
          const kMin = getIstClock(dayBars[k][0]).minutes;
          const shortExit = premiumAt({
            side: 'SHORT',
            entrySpot,
            currentSpot: cl,
            entryPremium: shortEntryPrem,
            strike: shortStrike,
            strikeStep: common.strikeStep,
            premiumLeverage: common.premiumLeverage,
          });
          const longExit = premiumAt({
            side: 'LONG',
            entrySpot,
            currentSpot: cl,
            entryPremium: longEntryPrem,
            strike: longStrike,
            strikeStep: common.strikeStep,
            premiumLeverage: common.premiumLeverage,
          });
          const debit = (shortExit - longExit) * common.lotSize * common.lotCount;
          const maxLoss = spread.width * common.lotSize * common.lotCount;
          if (debit - credit >= maxLoss) {
            exitIdx = k;
            exitSpot = cl;
            reason = 'SPREAD_MAX_LOSS';
            break;
          }
          if (kMin >= 915) {
            exitIdx = k;
            exitSpot = cl;
            reason = 'DAY_CLOSE';
            break;
          }
        }
        const shortExit = premiumAt({
          side: 'SHORT',
          entrySpot,
          currentSpot: exitSpot,
          entryPremium: shortEntryPrem,
          strike: shortStrike,
          strikeStep: common.strikeStep,
          premiumLeverage: common.premiumLeverage,
        });
        const longExit = premiumAt({
          side: 'LONG',
          entrySpot,
          currentSpot: exitSpot,
          entryPremium: longEntryPrem,
          strike: longStrike,
          strikeStep: common.strikeStep,
          premiumLeverage: common.premiumLeverage,
        });
        const finalDebit = (shortExit - longExit) * common.lotSize * common.lotCount;
        const rawPnl = credit - finalDebit;
        const pnl = rawPnl - common.perTradeCost;
        trades.push({
          pair: symbol,
          type: 'BEAR_CALL_SPREAD',
          strike: shortStrike,
          buyPrice: Number((credit / (common.lotSize * common.lotCount)).toFixed(2)),
          sellPrice: Number((finalDebit / (common.lotSize * common.lotCount)).toFixed(2)),
          lotSize: common.lotSize,
          lots: common.lotCount,
          invested: Number(credit.toFixed(2)),
          finalValue: Number((credit - rawPnl).toFixed(2)),
          closed: 'SPREAD',
          order: 'SELL_SPREAD',
          entryTime: dayBars[entryIdx][0],
          exitTime: dayBars[exitIdx][0],
          entryPrice: Number(entrySpot.toFixed(2)),
          exitPrice: Number(exitSpot.toFixed(2)),
          qty: common.lotSize * common.lotCount,
          premium: Number(shortEntryPrem.toFixed(2)),
          lotCount: common.lotCount,
          grossPnl: Number(rawPnl.toFixed(2)),
          charges: common.perTradeCost,
          pnl: Number(pnl.toFixed(2)),
          pnlPct: credit > 0 ? Number(((pnl / credit) * 100).toFixed(2)) : 0,
          reason,
        });
        dayTrades += 1;
        lastEntry = entryIdx;
        continue;
      }

      const optionType = signal.optionType || 'CE';
      const strike = pickStrike({
        entrySpot,
        strikeStep: common.strikeStep,
        optionType,
        strikeMode: common.strikeMode,
      });
      const entryPremium = Math.max(0.05, (entrySpot * common.basePremiumPct) / 100);
      const targetPremium = common.hasTarget ? entryPremium + common.targetPoints : null;
      const stopPremium = common.hasStopLoss ? Math.max(0.05, entryPremium - common.stopLossPoints) : null;

      const { exitIdx, exitSpot, exitPremium, reason } = simulateLongOptionExit({
        dayBars,
        entryIdx,
        optionType,
        entrySpot,
        entryPremium,
        strike,
        strikeStep: common.strikeStep,
        premiumLeverage: common.premiumLeverage,
        hasStopLoss: common.hasStopLoss,
        stopPremium,
        hasTarget: common.hasTarget,
        targetPremium,
        useIndexExits: common.usePatternExits && (signal.stopIndex != null || signal.targetIndex != null),
        stopIndex: signal.stopIndex,
        targetIndex: signal.targetIndex,
      });

      trades.push(
        buildLongOptionTrade({
          symbol,
          lotSize: common.lotSize,
          lotCount: common.lotCount,
          perTradeCost: common.perTradeCost,
          dayBars,
          entryIdx,
          optionType,
          strike,
          entrySpot,
          entryPremium,
          exitIdx,
          exitSpot,
          exitPremium,
          reason,
          hasStopLoss: common.hasStopLoss,
          stopPremium,
          hasTarget: common.hasTarget,
          targetPremium,
          extra: { signal: signal.reason || 'SIGNAL' },
        })
      );
      dayTrades += 1;
      lastEntry = entryIdx;
    }
  }

  return { trades, summary: buildStrategyRunSummary(trades) };
}

module.exports = { runIntradaySignalBacktest, premiumAt };

const FnoStockSnapshot = require('../models/FnoStockSnapshot');
const { buildStockUnderlyingMeta } = require('./dhanLiveService');
const { getIstClock } = require('../utils/dateTime');

function todayDateKey() {
  return getIstClock(new Date()).dateKey;
}

function diffSymbolSets(currentSymbols, previousSymbols) {
  const current = [...new Set((currentSymbols || []).map((s) => String(s).toUpperCase()))].sort();
  const previousSet = new Set((previousSymbols || []).map((s) => String(s).toUpperCase()));
  const currentSet = new Set(current);
  return {
    symbols: current,
    count: current.length,
    added: current.filter((s) => !previousSet.has(s)),
    removed: [...previousSet].filter((s) => !currentSet.has(s)).sort(),
  };
}

async function loadCurrentSymbols(instrumentType) {
  const meta = await buildStockUnderlyingMeta(instrumentType);
  return meta.map((row) => row.symbol);
}

async function syncInstrumentSnapshot(instrumentType, { symbols: providedSymbols } = {}) {
  const dateKey = todayDateKey();
  const symbols = providedSymbols || await loadCurrentSymbols(instrumentType);
  const normalized = [...new Set(symbols.map((s) => String(s).toUpperCase().trim()).filter(Boolean))].sort();

  await FnoStockSnapshot.findOneAndUpdate(
    { instrumentType, dateKey },
    { symbols: normalized, count: normalized.length },
    { upsert: true, setDefaultsOnInsert: true },
  );

  const previous = await FnoStockSnapshot.findOne({
    instrumentType,
    dateKey: { $lt: dateKey },
  })
    .sort({ dateKey: -1 })
    .lean();

  const diff = diffSymbolSets(normalized, previous?.symbols || []);

  return {
    instrumentType,
    dateKey,
    count: diff.count,
    previousDateKey: previous?.dateKey || null,
    previousCount: previous?.count ?? null,
    added: diff.added,
    removed: diff.removed,
    netChange: previous ? diff.count - previous.count : 0,
    hasPreviousSnapshot: Boolean(previous),
  };
}

async function getFnoInstrumentSummary() {
  const [options, futures] = await Promise.all([
    syncInstrumentSnapshot('OPTSTK'),
    syncInstrumentSnapshot('FUTSTK'),
  ]);

  return {
    dateKey: options.dateKey,
    options,
    futures,
  };
}

module.exports = {
  getFnoInstrumentSummary,
  syncInstrumentSnapshot,
};

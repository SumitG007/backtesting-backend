const VolumeMetrics = require('../models/VolumeMetrics');

function normalizeExpiry(expiryDate) {
  return expiryDate ? String(expiryDate).slice(0, 10) : '';
}

function docToRow(doc) {
  if (!doc) return null;
  return {
    ok: Boolean(doc.ok),
    symbol: doc.symbol,
    product: doc.product,
    expiry: doc.expiryDate || null,
    cashSupported: Boolean(doc.cashSupported),
    futureSupported: Boolean(doc.futureSupported),
    avgVolume: doc.avgVolume ?? null,
    todayVolume: doc.todayVolume ?? null,
    ratio: doc.ratio ?? null,
    pctVsAvg: doc.pctVsAvg ?? null,
    signal: doc.signal || 'UNAVAILABLE',
    sampleDays: doc.sampleDays ?? 0,
    todayDate: doc.todayDate || '',
    partialToday: Boolean(doc.partialToday),
    priorDays: Array.isArray(doc.priorDays) ? doc.priorDays : [],
    prevDayClose: doc.prevDayClose ?? null,
    todayPrice: doc.todayPrice ?? null,
    priceChangePct: doc.priceChangePct ?? null,
    prevDayDate: doc.prevDayDate || null,
    error: doc.error || null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

async function loadMetricsMap({ product, expiryDate, lookbackDays, symbols = [] } = {}) {
  const expiry = normalizeExpiry(expiryDate);
  const lookback = Number(lookbackDays) || 10;
  const filter = {
    product,
    expiryDate: expiry,
    lookbackDays: lookback,
  };
  if (symbols.length) {
    filter.symbol = { $in: symbols.map((s) => String(s).toUpperCase()) };
  }

  const docs = await VolumeMetrics.find(filter).lean();
  const map = new Map();
  for (const doc of docs) {
    map.set(doc.symbol, docToRow(doc));
  }
  return map;
}

async function upsertMetricRow({
  product,
  expiryDate,
  lookbackDays,
  row,
}) {
  const expiry = normalizeExpiry(expiryDate);
  const lookback = Number(lookbackDays) || 10;
  const symbol = String(row.symbol || '').toUpperCase();
  if (!symbol) return null;

  const payload = {
    symbol,
    product,
    expiryDate: expiry,
    lookbackDays: lookback,
    ok: Boolean(row.ok),
    cashSupported: Boolean(row.cashSupported),
    futureSupported: Boolean(row.futureSupported),
    avgVolume: row.avgVolume ?? null,
    todayVolume: row.todayVolume ?? null,
    ratio: row.ratio ?? null,
    pctVsAvg: row.pctVsAvg ?? null,
    signal: row.signal || 'UNAVAILABLE',
    sampleDays: row.sampleDays ?? 0,
    todayDate: row.todayDate || '',
    partialToday: Boolean(row.partialToday),
    priorDays: Array.isArray(row.priorDays) ? row.priorDays : [],
    prevDayClose: row.prevDayClose ?? null,
    todayPrice: row.todayPrice ?? null,
    priceChangePct: row.priceChangePct ?? null,
    prevDayDate: row.prevDayDate || null,
    error: row.ok ? null : (row.error || 'Failed'),
  };

  const doc = await VolumeMetrics.findOneAndUpdate(
    { symbol, product, expiryDate: expiry, lookbackDays: lookback },
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return docToRow(doc);
}

async function upsertMetricRows({
  product,
  expiryDate,
  lookbackDays,
  rows = [],
}) {
  const results = [];
  for (const row of rows) {
    results.push(await upsertMetricRow({ product, expiryDate, lookbackDays, row }));
  }
  return results;
}

async function getLatestBatchUpdatedAt({ product, expiryDate, lookbackDays } = {}) {
  const expiry = normalizeExpiry(expiryDate);
  const lookback = Number(lookbackDays) || 10;
  const doc = await VolumeMetrics.findOne({
    product,
    expiryDate: expiry,
    lookbackDays: lookback,
  })
    .sort({ updatedAt: -1 })
    .select('updatedAt')
    .lean();
  return doc?.updatedAt ? new Date(doc.updatedAt) : null;
}

async function countMetrics({ product, expiryDate, lookbackDays } = {}) {
  const expiry = normalizeExpiry(expiryDate);
  const lookback = Number(lookbackDays) || 10;
  return VolumeMetrics.countDocuments({
    product,
    expiryDate: expiry,
    lookbackDays: lookback,
  });
}

module.exports = {
  loadMetricsMap,
  upsertMetricRow,
  upsertMetricRows,
  getLatestBatchUpdatedAt,
  countMetrics,
  docToRow,
};

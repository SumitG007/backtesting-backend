const {
  runVolumeAnalysis,
  runVolumeAnalysisBatch,
  runVolumeAnalysisScan,
  listSymbolsByProduct,
  getVolumeAnalysisMeta,
  getFutureExpiriesForSymbol,
  searchInstruments,
  LOOKBACK_PRESETS,
} = require('../services/volumeAnalysisService');

function parseLookbackDays(raw) {
  const n = Number(raw);
  if (LOOKBACK_PRESETS[n]) return n;
  return 5;
}

function parseProduct(raw) {
  const p = String(raw || 'cash').toLowerCase();
  return p === 'future' ? 'future' : 'cash';
}

async function runMarketAnalysis(req, res) {
  try {
    const symbol = String(req.body?.symbol || req.query?.symbol || 'HDFCBANK').toUpperCase();
    const lookbackDays = parseLookbackDays(req.body?.lookbackDays ?? req.query?.lookbackDays);
    const product = parseProduct(req.body?.product ?? req.query?.product);
    const expiryDate = req.body?.expiryDate ?? req.query?.expiryDate ?? null;

    const result = await runVolumeAnalysis({ symbol, lookbackDays, product, expiryDate });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const httpErr = error?.cause || error;
    if (httpErr.response) {
      const details = httpErr.response.data;
      const dhanMsg =
        (typeof details === 'object' && (details?.errorMessage || details?.message || details?.error))
        || (typeof details === 'string' ? details : null)
        || error.message;
      return res.status(httpErr.response.status).json({
        ok: false,
        error: dhanMsg || 'Dhan API error',
        details,
        request: error.dhanBody || null,
      });
    }
    return res.status(500).json({
      ok: false,
      error: error.message,
      request: error.dhanBody || null,
    });
  }
}

function parsePage(raw, fallback = 1) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function parsePageSize(raw, fallback = 25) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(50, Math.floor(n)));
}

async function listMarketAnalysisSymbols(req, res) {
  try {
    const product = parseProduct(req.query?.product ?? 'future');
    const q = String(req.query?.q ?? '').trim();
    const page = parsePage(req.query?.page, 1);
    const pageSize = parsePageSize(req.query?.pageSize, 25);
    const result = await listSymbolsByProduct({ product, q, page, pageSize });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function scanMarketAnalysis(req, res) {
  try {
    const product = parseProduct(req.body?.product ?? req.query?.product ?? 'future');
    const lookbackDays = parseLookbackDays(req.body?.lookbackDays ?? req.query?.lookbackDays ?? 10);
    const expiryDate = req.body?.expiryDate ?? req.query?.expiryDate ?? null;
    const q = String(req.body?.q ?? req.query?.q ?? '').trim();
    const page = parsePage(req.body?.page ?? req.query?.page, 1);
    const pageSize = parsePageSize(req.body?.pageSize ?? req.query?.pageSize, 25);

    const result = await runVolumeAnalysisScan({
      product,
      lookbackDays,
      expiryDate,
      q,
      page,
      pageSize,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function runMarketAnalysisBatch(req, res) {
  try {
    const symbols = req.body?.symbols ?? req.query?.symbols;
    const lookbackDays = parseLookbackDays(req.body?.lookbackDays ?? req.query?.lookbackDays ?? 10);
    const product = parseProduct(req.body?.product ?? req.query?.product);
    const expiryDate = req.body?.expiryDate ?? req.query?.expiryDate ?? null;

    const result = await runVolumeAnalysisBatch({ symbols, lookbackDays, product, expiryDate });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getMarketAnalysisMeta(_req, res) {
  try {
    const meta = await getVolumeAnalysisMeta();
    return res.json({ ok: true, ...meta });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function searchMarketInstruments(req, res) {
  try {
    const q = String(req.query?.q ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit) || 25));
    const results = await searchInstruments(q, limit);
    return res.json({ ok: true, query: q, results });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getMarketAnalysisExpiries(req, res) {
  try {
    const symbol = String(req.query?.symbol || '').toUpperCase();
    if (!symbol) {
      return res.status(400).json({ ok: false, error: 'symbol query is required' });
    }
    const data = await getFutureExpiriesForSymbol(symbol);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  runMarketAnalysis,
  runMarketAnalysisBatch,
  scanMarketAnalysis,
  listMarketAnalysisSymbols,
  getMarketAnalysisMeta,
  searchMarketInstruments,
  getMarketAnalysisExpiries,
};

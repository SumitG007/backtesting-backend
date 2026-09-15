const { getStockUnderlyingExportRows } = require('../services/dhanLiveService');
const { getFnoInstrumentSummary, syncInstrumentSnapshot } = require('../services/fnoStockSnapshotService');

const CSV_HEADERS = ['Sr No', 'Symbol', 'Current Price', 'Lot Size', 'Nearest Expiry'];

function csvCell(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function exportRowsToCsv(rows) {
  const lines = [
    CSV_HEADERS.join(','),
    ...rows.map((row) => [
      row.srNo,
      row.symbol,
      row.currentPrice,
      row.lotSize,
      row.nearestExpiry,
    ].map(csvCell).join(',')),
  ];
  return `${lines.join('\n')}\n`;
}

function sendExportCsv(res, { rows, filenamePrefix }) {
  const date = new Date().toISOString().slice(0, 10);
  const csv = exportRowsToCsv(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenamePrefix}-${date}.csv"`);
  return res.send(csv);
}

async function getInstrumentSummary(_req, res) {
  try {
    const summary = await getFnoInstrumentSummary();
    return res.json({ ok: true, ...summary });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function exportOptionStocksCsv(_req, res) {
  try {
    const rows = await getStockUnderlyingExportRows('OPTSTK');
    await syncInstrumentSnapshot('OPTSTK', { symbols: rows.map((row) => row.symbol) });
    return sendExportCsv(res, { rows, filenamePrefix: 'option-stocks' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function exportFutureStocksCsv(_req, res) {
  try {
    const rows = await getStockUnderlyingExportRows('FUTSTK');
    await syncInstrumentSnapshot('FUTSTK', { symbols: rows.map((row) => row.symbol) });
    return sendExportCsv(res, { rows, filenamePrefix: 'future-stocks' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getInstrumentSummary,
  exportOptionStocksCsv,
  exportFutureStocksCsv,
};

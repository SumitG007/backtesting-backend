const manualEngine = require('../services/manualTradeEngine');

function parsePage(raw, fallback = 1) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function parsePageSize(raw, fallback = 25, max = 100) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function getManualConsoleStatus(_req, res) {
  try {
    const data = await manualEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualExpiries(req, res) {
  try {
    const data = await manualEngine.getExpiries(req.query?.symbol || 'NIFTY');
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualQuote(req, res) {
  try {
    const data = await manualEngine.getQuote({
      symbol: req.query?.symbol,
      expiry: req.query?.expiry,
      strike: req.query?.strike,
      optionType: req.query?.optionType,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getManualChain(req, res) {
  try {
    const data = await manualEngine.getChainAroundAtm({
      symbol: req.query?.symbol,
      expiry: req.query?.expiry,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getManualInstruments(_req, res) {
  try {
    const data = await manualEngine.getInstrumentUniverse();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualFutureQuote(req, res) {
  try {
    const data = await manualEngine.getFuture({
      symbol: req.query?.symbol,
      expiry: req.query?.expiry,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postManualOrder(req, res) {
  try {
    const result = await manualEngine.createOrder(req.body || {});
    return res.json({
      ok: true,
      order: result.order,
      trade: result.trade,
      filled: result.filled,
      message: result.filled
        ? `Filled ${result.trade?.optionType} ${result.trade?.strike} @ ₹${result.trade?.entryPremium}`
        : 'Limit order placed — fills when LTP reaches your price',
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function deleteManualOrder(req, res) {
  try {
    const orderId = String(req.params?.orderId || '').trim();
    if (!orderId) return res.status(400).json({ ok: false, error: 'orderId required' });
    const order = await manualEngine.cancelOrder(orderId);
    return res.json({ ok: true, order, message: 'Order cancelled' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postManualClosePosition(req, res) {
  try {
    const tradeId = String(req.params?.tradeId || '').trim();
    if (!tradeId) return res.status(400).json({ ok: false, error: 'tradeId required' });
    const trade = await manualEngine.closePositionById(tradeId, { reason: 'MANUAL_CLOSE' });
    return res.json({
      ok: true,
      trade,
      message: trade?.pnl != null ? `Closed. P/L ₹${Number(trade.pnl).toFixed(2)}` : 'Position closed',
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchManualPositionRisk(req, res) {
  try {
    const tradeId = String(req.params?.tradeId || '').trim();
    if (!tradeId) return res.status(400).json({ ok: false, error: 'tradeId required' });
    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const riskPayload = {};
    if (has('stopLossValue')) {
      riskPayload.stopLossValue = body.stopLossValue;
      riskPayload.stopLossMode = body.stopLossMode;
    } else if (has('stopLossPoints')) {
      riskPayload.stopLossPoints = body.stopLossPoints;
    }
    if (has('targetValue')) {
      riskPayload.targetValue = body.targetValue;
      riskPayload.targetMode = body.targetMode;
    } else if (has('targetProfitPoints')) {
      riskPayload.targetProfitPoints = body.targetProfitPoints;
    }
    const trade = await manualEngine.updatePositionRisk(tradeId, riskPayload);
    return res.json({
      ok: true,
      trade,
      message: `Updated — SL ${trade.stopLossPremium != null ? `₹${trade.stopLossPremium}` : 'off'}, target ${trade.targetPremium != null ? `₹${trade.targetPremium}` : 'EOD'}`,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getManualTrades(req, res) {
  try {
    const data = await manualEngine.listTrades({
      page: parsePage(req.query?.page),
      pageSize: parsePageSize(req.query?.pageSize, 25),
      status: req.query?.status,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualActions(req, res) {
  try {
    const data = await manualEngine.listActions({
      page: parsePage(req.query?.page),
      pageSize: parsePageSize(req.query?.pageSize, 50, 200),
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postManualWalletReset(req, res) {
  try {
    const wallet = await manualEngine.resetWallet();
    return res.json({ ok: true, wallet, message: 'Manual console history cleared' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getManualConsoleStatus,
  getManualExpiries,
  getManualQuote,
  getManualChain,
  getManualInstruments,
  getManualFutureQuote,
  postManualOrder,
  deleteManualOrder,
  postManualClosePosition,
  patchManualPositionRisk,
  getManualTrades,
  getManualActions,
  postManualWalletReset,
};

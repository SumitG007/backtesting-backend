const express = require('express');
const {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  postStrategyShortStraddleValidationYear,
} = require('../controllers/backtestController');
const { postLogin, getAuthConfig, getMe, postLogout, postVerifyPassword } = require('../controllers/authController');
const { postDhanAccessToken, getDhanTokenStatus } = require('../controllers/dhanTokenController');
const {
  getStatus: getLiveStatus,
  startLive,
  stopLive,
  saveLiveSettings,
  resetWallet: resetLiveWallet,
  listTrades: listLiveTrades,
  exportTradesExcel: exportLiveTradesExcel,
  getLiveMeta,
  closeLivePosition,
} = require('../controllers/liveTradeController');
const { getDrishtiDashboard } = require('../controllers/drishtiDashboardController');
const { getTodayNotifications, clearTodayNotifications } = require('../controllers/notificationController');
const {
  getInstrumentSummary,
  exportOptionStocksCsv,
  exportFutureStocksCsv,
} = require('../controllers/instrumentDataController');
const {
  getManualConsoleStatus,
  getManualExpiries,
  getManualQuote,
  getManualChain,
  getManualOiBoard,
  getManualOiTotals,
  getManualInstruments,
  getManualFutureQuote,
  postManualOrder,
  deleteManualOrder,
  postManualClosePosition,
  patchManualPositionRisk,
  getManualTrades,
  getManualActions,
  postManualWalletReset,
  postManualWalletTopup,
} = require('../controllers/manualConsoleController');
const {
  getManualOiAutoStatus,
  getManualOiAutoBook,
  getManualOiAutoTrades,
  postManualOiAutoEnabled,
  patchManualOiAutoSettings,
  postManualOiAutoClose,
} = require('../controllers/manualOiAutoController');
const {
  getOiWallReactionStatus,
  getOiWallReactionBook,
  getOiWallReactionTrades,
  postOiWallReactionEnabled,
  patchOiWallReactionSettings,
  postOiWallReactionClose,
} = require('../controllers/oiWallReactionController');
const {
  getOiFlowStatus,
  getOiFlowToday,
  getOiFlowHeaderSignal,
  getOiFlowSignals,
  postOiFlowSignalsBackfill,
} = require('../controllers/oiFlowController');
const {
  getLiquidityOiChaseChart,
} = require('../controllers/liquidityOiChaseController');

const router = express.Router();

router.get('/health', health);
router.post('/auth/login', postLogin);
router.get('/auth/config', getAuthConfig);
router.get('/auth/me', getMe);
router.post('/auth/logout', postLogout);
router.post('/auth/verify-password', postVerifyPassword);
router.get('/dhan/token-status', getDhanTokenStatus);
router.post('/dhan/access-token', postDhanAccessToken);
router.get('/data/candles', getCandles);
router.get('/data/candles/day', getCandlesDay);
router.get('/data/option-stocks.csv', exportOptionStocksCsv);
router.get('/data/future-stocks.csv', exportFutureStocksCsv);
router.get('/data/instrument-summary', getInstrumentSummary);
router.get('/results/drishti', getDrishtiDashboard);
router.get('/dashboard/drishti', getDrishtiDashboard);
router.get('/notifications/today', getTodayNotifications);
router.post('/notifications/clear', clearTodayNotifications);
// Strategy 2 — short straddle (entry day + next day exit)
router.post('/strategy2/run', runStrategyShortStraddleNextDay);
router.post('/strategy2/validation', postStrategyShortStraddleValidation);
router.post('/strategy2/validation-year', postStrategyShortStraddleValidationYear);
router.get('/strategy2/runs/:runId/trades', getStrategyShortStraddleRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyShortStraddleValidation);
// Paper live (real market data, simulated fills in DB)
router.get('/live/:strategyId/status', getLiveStatus);
router.get('/live/:strategyId/meta', getLiveMeta);
router.post('/live/:strategyId/start', startLive);
router.post('/live/:strategyId/stop', stopLive);
router.post('/live/:strategyId/settings', saveLiveSettings);
router.post('/live/:strategyId/wallet/reset', resetLiveWallet);
router.get('/live/:strategyId/trades', listLiveTrades);
router.get('/live/:strategyId/trades/export', exportLiveTradesExcel);
router.post('/live/:strategyId/close', closeLivePosition);
// Manual trading console (paper — Dhan LTP, simulated fills)
router.get('/manual-console/status', getManualConsoleStatus);
router.get('/manual-console/expiries', getManualExpiries);
router.get('/manual-console/quote', getManualQuote);
router.get('/manual-console/chain', getManualChain);
router.get('/manual-console/oi-board', getManualOiBoard);
router.get('/manual-console/oi-totals', getManualOiTotals);
router.get('/manual-console/instruments', getManualInstruments);
router.get('/manual-console/future-quote', getManualFutureQuote);
router.post('/manual-console/orders', postManualOrder);
router.delete('/manual-console/orders/:orderId', deleteManualOrder);
router.post('/manual-console/positions/:tradeId/close', postManualClosePosition);
router.patch('/manual-console/positions/:tradeId/risk', patchManualPositionRisk);
router.get('/manual-console/trades', getManualTrades);
router.get('/manual-console/actions', getManualActions);
router.post('/manual-console/wallet/reset', postManualWalletReset);
router.post('/manual-console/wallet/topup', postManualWalletTopup);

router.get('/manual-oi-auto/status', getManualOiAutoStatus);
router.get('/manual-oi-auto/book', getManualOiAutoBook);
router.get('/manual-oi-auto/trades', getManualOiAutoTrades);
router.post('/manual-oi-auto/enabled', postManualOiAutoEnabled);
router.patch('/manual-oi-auto/settings', patchManualOiAutoSettings);
router.post('/manual-oi-auto/close', postManualOiAutoClose);

router.get('/oi-wall-reaction/status', getOiWallReactionStatus);
router.get('/oi-wall-reaction/book', getOiWallReactionBook);
router.get('/oi-wall-reaction/trades', getOiWallReactionTrades);
router.post('/oi-wall-reaction/enabled', postOiWallReactionEnabled);
router.patch('/oi-wall-reaction/settings', patchOiWallReactionSettings);
router.post('/oi-wall-reaction/close', postOiWallReactionClose);

router.get('/oi-flow/status', getOiFlowStatus);
router.get('/oi-flow/today', getOiFlowToday);
router.get('/oi-flow/header-signal', getOiFlowHeaderSignal);
router.get('/oi-flow/signals', getOiFlowSignals);
router.post('/oi-flow/signals/backfill', postOiFlowSignalsBackfill);

router.get('/liquidity-oi-chase/chart', getLiquidityOiChaseChart);

module.exports = router;

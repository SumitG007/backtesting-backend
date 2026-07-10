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
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
  postStrategySevenValidationYear,
  runStrategyNine,
  getStrategyNineRunTrades,
  getStrategyNineValidation,
  postStrategyNineValidation,
  postStrategyNineValidationYear,
} = require('../controllers/backtestController');
const { postLogin, getAuthConfig, getMe, postLogout } = require('../controllers/authController');
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
  reopenLiveTrade,
} = require('../controllers/liveTradeController');
const { getDrishtiDashboard } = require('../controllers/drishtiDashboardController');
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
  getManualInstruments,
  getManualFutureQuote,
  postManualOrder,
  deleteManualOrder,
  postManualClosePosition,
  patchManualPositionRisk,
  getManualTrades,
  getManualActions,
  postManualWalletReset,
} = require('../controllers/manualConsoleController');
const {
  getPatternResearch,
  getPatternResearchReport,
  getMultiScenarioResearch,
} = require('../controllers/patternResearchController');

const router = express.Router();

router.get('/health', health);
router.post('/auth/login', postLogin);
router.get('/auth/config', getAuthConfig);
router.get('/auth/me', getMe);
router.post('/auth/logout', postLogout);
router.get('/dhan/token-status', getDhanTokenStatus);
router.post('/dhan/access-token', postDhanAccessToken);
router.get('/data/candles', getCandles);
router.get('/data/candles/day', getCandlesDay);
router.get('/data/option-stocks.csv', exportOptionStocksCsv);
router.get('/data/future-stocks.csv', exportFutureStocksCsv);
router.get('/data/instrument-summary', getInstrumentSummary);
router.get('/research/patterns', getPatternResearch);
router.get('/research/patterns/report.txt', getPatternResearchReport);
router.get('/research/patterns/multi', getMultiScenarioResearch);
router.get('/results/drishti', getDrishtiDashboard);
router.get('/dashboard/drishti', getDrishtiDashboard);
// Strategy 2 — short straddle (entry day + next day exit)
router.post('/strategy2/run', runStrategyShortStraddleNextDay);
router.post('/strategy2/validation', postStrategyShortStraddleValidation);
router.post('/strategy2/validation-year', postStrategyShortStraddleValidationYear);
router.get('/strategy2/runs/:runId/trades', getStrategyShortStraddleRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyShortStraddleValidation);
// Strategy 3 — timed put buy (long PE)
router.post('/strategy3/run', runStrategySeven);
router.post('/strategy3/validation', postStrategySevenValidation);
router.post('/strategy3/validation-year', postStrategySevenValidationYear);
router.get('/strategy3/runs/:runId/trades', getStrategySevenRunTrades);
router.get('/strategy3/runs/:runId/validation', getStrategySevenValidation);
// Strategy 5 — Trail Scalp Put/Call (multi-entry intraday with trailing profit)
router.post('/strategy5/run', runStrategyNine);
router.post('/strategy5/validation', postStrategyNineValidation);
router.post('/strategy5/validation-year', postStrategyNineValidationYear);
router.get('/strategy5/runs/:runId/trades', getStrategyNineRunTrades);
router.get('/strategy5/runs/:runId/validation', getStrategyNineValidation);
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
router.post('/live/:strategyId/reopen-trade', reopenLiveTrade);
// Manual trading console (paper — Dhan LTP, simulated fills)
router.get('/manual-console/status', getManualConsoleStatus);
router.get('/manual-console/expiries', getManualExpiries);
router.get('/manual-console/quote', getManualQuote);
router.get('/manual-console/chain', getManualChain);
router.get('/manual-console/instruments', getManualInstruments);
router.get('/manual-console/future-quote', getManualFutureQuote);
router.post('/manual-console/orders', postManualOrder);
router.delete('/manual-console/orders/:orderId', deleteManualOrder);
router.post('/manual-console/positions/:tradeId/close', postManualClosePosition);
router.patch('/manual-console/positions/:tradeId/risk', patchManualPositionRisk);
router.get('/manual-console/trades', getManualTrades);
router.get('/manual-console/actions', getManualActions);
router.post('/manual-console/wallet/reset', postManualWalletReset);

module.exports = router;

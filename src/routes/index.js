const express = require('express');
const {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  postStrategyFiveValidation,
  runStrategySeven,
  getStrategySevenRunTrades,
  getStrategySevenValidation,
  postStrategySevenValidation,
} = require('../controllers/backtestController');
const { postLogin, getAuthConfig, getMe, postLogout } = require('../controllers/authController');
const { postDhanAccessToken, getDhanTokenStatus } = require('../controllers/dhanTokenController');
const { runMarketAnalysis, getMarketAnalysisMeta } = require('../controllers/marketAnalysisController');
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
router.get('/market-analysis/meta', getMarketAnalysisMeta);
router.post('/market-analysis/run', runMarketAnalysis);
// Strategy 3 — IV mean reversion
router.post('/strategy3/run', runStrategyFive);
router.post('/strategy3/validation', postStrategyFiveValidation);
router.get('/strategy3/runs/:runId/trades', getStrategyFiveRunTrades);
router.get('/strategy3/runs/:runId/validation', getStrategyFiveValidation);
// Strategy 4 — short straddle (entry day + next day exit)
router.post('/strategy4/run', runStrategyShortStraddleNextDay);
router.post('/strategy4/validation', postStrategyShortStraddleValidation);
router.get('/strategy4/runs/:runId/trades', getStrategyShortStraddleRunTrades);
router.get('/strategy4/runs/:runId/validation', getStrategyShortStraddleValidation);
// Strategy 5 — timed put buy (long PE)
router.post('/strategy5/run', runStrategySeven);
router.post('/strategy5/validation', postStrategySevenValidation);
router.get('/strategy5/runs/:runId/trades', getStrategySevenRunTrades);
router.get('/strategy5/runs/:runId/validation', getStrategySevenValidation);
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

module.exports = router;

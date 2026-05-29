const express = require('express');
const {
  health,
  getCandles,
  getCandlesDay,
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  postStrategyOneValidation,
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
  postStrategyFourValidation,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  postStrategyFiveValidation,
  runBacktestStub,
} = require('../controllers/backtestController');
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
router.get('/dhan/token-status', getDhanTokenStatus);
router.post('/dhan/access-token', postDhanAccessToken);
router.get('/data/candles', getCandles);
router.get('/data/candles/day', getCandlesDay);
router.get('/market-analysis/meta', getMarketAnalysisMeta);
router.post('/market-analysis/run', runMarketAnalysis);
// Strategy 1 — implement in `strategies/strategy1/` (run currently returns 501 until wired).
router.post('/strategy1/run', runStrategyOne);
router.post('/strategy1/validation', postStrategyOneValidation);
router.get('/strategy1/runs/:runId/trades', getStrategyOneRunTrades);
router.get('/strategy1/runs/:runId/validation', getStrategyOneValidation);
// Strategy 2 — First hour open bias (intraday tier)
router.post('/strategy2/run', runStrategyFour);
router.post('/strategy2/validation', postStrategyFourValidation);
router.get('/strategy2/runs/:runId/trades', getStrategyFourRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyFourValidation);
// Strategy 3 — IV mean reversion (intraday tier)
router.post('/strategy3/run', runStrategyFive);
router.post('/strategy3/validation', postStrategyFiveValidation);
router.get('/strategy3/runs/:runId/trades', getStrategyFiveRunTrades);
router.get('/strategy3/runs/:runId/validation', getStrategyFiveValidation);
// Strategy 4 — short straddle (entry day + next day exit)
router.post('/strategy4/run', runStrategyShortStraddleNextDay);
router.post('/strategy4/validation', postStrategyShortStraddleValidation);
router.get('/strategy4/runs/:runId/trades', getStrategyShortStraddleRunTrades);
router.get('/strategy4/runs/:runId/validation', getStrategyShortStraddleValidation);
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
router.post('/backtest/run', runBacktestStub);

module.exports = router;

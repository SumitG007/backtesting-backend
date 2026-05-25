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
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  postStrategyFiveValidation,
  runBacktestStub,
} = require('../controllers/backtestController');
const { postDhanAccessToken, getDhanTokenStatus } = require('../controllers/dhanTokenController');
const { runMarketAnalysis, getMarketAnalysisMeta } = require('../controllers/marketAnalysisController');
const {
  getConfig: getOptionChainArchiveConfig,
  getRecorder: getOptionChainRecorder,
  getLatest: getOptionChainLatest,
  getSnapshotsList,
  getAvailableTimes,
  postPurge: postOptionChainArchivePurge,
  getSnapshotDetail,
  getStats: getOptionChainArchiveStats,
} = require('../controllers/optionChainArchiveController');
const { registerCatalogStrategyRoutes } = require('../controllers/backtest/registerCatalogRoutes');

const router = express.Router();

router.get('/health', health);
router.get('/dhan/token-status', getDhanTokenStatus);
router.post('/dhan/access-token', postDhanAccessToken);
router.get('/data/candles', getCandles);
router.get('/data/candles/day', getCandlesDay);
router.get('/market-analysis/meta', getMarketAnalysisMeta);
router.post('/market-analysis/run', runMarketAnalysis);
router.get('/option-chain-archive/config', getOptionChainArchiveConfig);
router.get('/option-chain-archive/stats', getOptionChainArchiveStats);
router.get('/option-chain-archive/recorder', getOptionChainRecorder);
router.get('/option-chain-archive/latest', getOptionChainLatest);
router.get('/option-chain-archive/snapshots', getSnapshotsList);
router.get('/option-chain-archive/available-times', getAvailableTimes);
router.post('/option-chain-archive/purge', postOptionChainArchivePurge);
router.get('/option-chain-archive/snapshots/:id', getSnapshotDetail);
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
registerCatalogStrategyRoutes(router);
router.post('/backtest/run', runBacktestStub);

module.exports = router;

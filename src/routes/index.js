const express = require('express');
const {
  health,
  getCandles,
  getCandlesDay,
  runStrategyOne,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  runStrategyFour,
  getStrategyFourRunTrades,
  getStrategyFourValidation,
  runStrategyFive,
  getStrategyFiveRunTrades,
  getStrategyFiveValidation,
  runBacktestStub,
} = require('../controllers/backtestController');
const { postDhanAccessToken, getDhanTokenStatus } = require('../controllers/dhanTokenController');
const { runMarketAnalysis, getMarketAnalysisMeta } = require('../controllers/marketAnalysisController');
const {
  getConfig: getOptionChainArchiveConfig,
  getRecorder: getOptionChainRecorder,
  getLatest: getOptionChainLatest,
  getSnapshotsList,
  getSnapshotDetail,
  getStats: getOptionChainArchiveStats,
} = require('../controllers/optionChainArchiveController');
const { runStrategyFourAnalysis } = require('../controllers/strategyFourAnalysisController');
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
router.get('/option-chain-archive/snapshots/:id', getSnapshotDetail);
// Strategy 1 — implement in `strategies/strategy1/` (run currently returns 501 until wired).
router.post('/strategy1/run', runStrategyOne);
router.get('/strategy1/runs/:runId/trades', getStrategyOneRunTrades);
router.get('/strategy1/runs/:runId/validation', getStrategyOneValidation);
// Strategy 2 — First hour open bias (intraday tier)
router.post('/strategy2/run', runStrategyFour);
router.get('/strategy2/runs/:runId/trades', getStrategyFourRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyFourValidation);
router.post('/strategy2/analysis', runStrategyFourAnalysis);
// Strategy 3 — IV mean reversion (intraday tier)
router.post('/strategy3/run', runStrategyFive);
router.get('/strategy3/runs/:runId/trades', getStrategyFiveRunTrades);
router.get('/strategy3/runs/:runId/validation', getStrategyFiveValidation);
registerCatalogStrategyRoutes(router);
router.post('/backtest/run', runBacktestStub);

module.exports = router;

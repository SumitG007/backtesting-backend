const express = require('express');
const {
  health,
  getCandles,
  runStrategyOne,
  runStrategyTwo,
  getStrategyOneRunTrades,
  getStrategyOneValidation,
  getStrategyTwoRunTrades,
  getStrategyTwoValidation,
  runBacktestStub,
} = require('../controllers/backtestController');
const {
  getStatus,
  startLive,
  stopLive,
  saveLiveSettings,
  updateWallet,
  resetWallet,
  listTrades,
  exportTradesExcel,
  getLiveMeta,
} = require('../controllers/liveTradeController');
const { postDhanAccessToken, getDhanTokenStatus } = require('../controllers/dhanTokenController');

const router = express.Router();

router.get('/health', health);
router.get('/dhan/token-status', getDhanTokenStatus);
router.post('/dhan/access-token', postDhanAccessToken);
router.get('/data/candles', getCandles);
// Strategy 1 — implement in `strategies/strategy1/` (run currently returns 501 until wired).
router.post('/strategy1/run', runStrategyOne);
router.get('/strategy1/runs/:runId/trades', getStrategyOneRunTrades);
router.get('/strategy1/runs/:runId/validation', getStrategyOneValidation);
// Strategy 2 — Short straddle (`strategies/strategy2/`)
router.post('/strategy2/run', runStrategyTwo);
router.get('/strategy2/runs/:runId/trades', getStrategyTwoRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyTwoValidation);
router.post('/backtest/run', runBacktestStub);

// Live paper trading
router.get('/live/:strategyId/status', getStatus);
router.post('/live/:strategyId/start', startLive);
router.post('/live/:strategyId/stop', stopLive);
router.post('/live/:strategyId/settings', saveLiveSettings);
router.get('/live/:strategyId/trades', listTrades);
router.get('/live/:strategyId/trades/export', exportTradesExcel);
router.get('/live/status', getStatus);
router.post('/live/start', startLive);
router.post('/live/stop', stopLive);
router.post('/live/settings', saveLiveSettings);
router.post('/live/wallet', updateWallet);
router.post('/live/wallet/reset', resetWallet);
router.get('/live/trades', listTrades);
router.get('/live/trades/export', exportTradesExcel);
router.get('/live/meta', getLiveMeta);

module.exports = router;

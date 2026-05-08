const express = require('express');
const {
  health,
  getCandles,
  runStrategyOne,
  getStrategyOneRunTrades,
  runBacktestStub,
} = require('../controllers/backtestController');

const router = express.Router();

router.get('/health', health);
router.get('/data/candles', getCandles);
router.post('/strategy1/run', runStrategyOne);
router.get('/strategy1/runs/:runId/trades', getStrategyOneRunTrades);
router.post('/backtest/run', runBacktestStub);

module.exports = router;

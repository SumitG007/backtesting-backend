const express = require('express');
const {
  health,
  getCandles,
  runStrategyOne,
  runStrategyTwo,
  getStrategyOneRunTrades,
  getStrategyTwoRunTrades,
  getStrategyTwoValidation,
  runBacktestStub,
} = require('../controllers/backtestController');

const router = express.Router();

router.get('/health', health);
router.get('/data/candles', getCandles);
router.post('/strategy1/run', runStrategyOne);
router.get('/strategy1/runs/:runId/trades', getStrategyOneRunTrades);
router.post('/strategy2/run', runStrategyTwo);
router.get('/strategy2/runs/:runId/trades', getStrategyTwoRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyTwoValidation);
router.post('/backtest/run', runBacktestStub);

module.exports = router;

const { createSlFlipPaperLiveEngine } = require('./createSlFlipPaperLiveEngine');
const { STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY } = require('../strategies/keys');

const engine = createSlFlipPaperLiveEngine({
  scenarioId: 'A',
  liveId: 'strategy-8',
  strategyKey: STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY,
  walletKey: 'paper_live_strategy11',
  optionSubKey: 'engine:strategy11:slflip:option',
  logTag: 'SlFlipPaperLive',
  scenarioLabel: 'SL Flip paper live',
  barIntervalMinutes: 5,
  defaultStopLossPoints: 8,
  defaultTrailActivationPoints: 4,
  defaultTrailStepPoints: 2,
});

module.exports = engine;

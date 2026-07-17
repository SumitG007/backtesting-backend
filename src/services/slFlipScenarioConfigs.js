/**
 * SL Flip paper-live scenario presets (A is live baseline; B/C/D are experiments).
 */
const {
  STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY,
  STRATEGY_ELEVEN_SL_FLIP_LIVE_B_KEY,
  STRATEGY_ELEVEN_SL_FLIP_LIVE_C_KEY,
  STRATEGY_ELEVEN_SL_FLIP_LIVE_D_KEY,
} = require('../strategies/keys');

const SCENARIO_A = {
  scenarioId: 'A',
  liveId: 'strategy-8',
  strategyKey: STRATEGY_ELEVEN_SL_FLIP_LIVE_KEY,
  walletKey: 'paper_live_strategy11',
  optionSubKey: 'engine:strategy11:slflip:option',
  logTag: 'SlFlipPaperLive-A',
  scenarioLabel: 'SL Flip — Scenario A (Balanced)',
  barIntervalMinutes: 5,
  defaultStopLossPoints: 8,
  defaultTrailActivationPoints: 4,
  defaultTrailStepPoints: 2,
};

const SCENARIO_B = {
  scenarioId: 'B',
  liveId: 'strategy-8b',
  strategyKey: STRATEGY_ELEVEN_SL_FLIP_LIVE_B_KEY,
  walletKey: 'paper_live_strategy11_b',
  optionSubKey: 'engine:strategy11:slflip:option:b',
  logTag: 'SlFlipPaperLive-B',
  scenarioLabel: 'SL Flip — Scenario B (Safer)',
  barIntervalMinutes: 5,
  defaultStopLossPoints: 12,
  defaultTrailActivationPoints: 6,
  defaultTrailStepPoints: 3,
};

const SCENARIO_C = {
  scenarioId: 'C',
  liveId: 'strategy-8c',
  strategyKey: STRATEGY_ELEVEN_SL_FLIP_LIVE_C_KEY,
  walletKey: 'paper_live_strategy11_c',
  optionSubKey: 'engine:strategy11:slflip:option:c',
  logTag: 'SlFlipPaperLive-C',
  scenarioLabel: 'SL Flip — Scenario C (Scalp)',
  barIntervalMinutes: 5,
  defaultStopLossPoints: 6,
  defaultTrailActivationPoints: 3,
  defaultTrailStepPoints: 1.5,
};

const SCENARIO_D = {
  scenarioId: 'D',
  liveId: 'strategy-8d',
  strategyKey: STRATEGY_ELEVEN_SL_FLIP_LIVE_D_KEY,
  walletKey: 'paper_live_strategy11_d',
  optionSubKey: 'engine:strategy11:slflip:option:d',
  logTag: 'SlFlipPaperLive-D',
  scenarioLabel: 'SL Flip — Scenario D (15m re-entry)',
  barIntervalMinutes: 15,
  defaultStopLossPoints: 8,
  defaultTrailActivationPoints: 4,
  defaultTrailStepPoints: 2,
};

const ALL_SCENARIOS = [SCENARIO_A, SCENARIO_B, SCENARIO_C, SCENARIO_D];

function getScenarioByLiveId(liveId) {
  return ALL_SCENARIOS.find((s) => s.liveId === String(liveId || '').toLowerCase()) || null;
}

module.exports = {
  SCENARIO_A,
  SCENARIO_B,
  SCENARIO_C,
  SCENARIO_D,
  ALL_SCENARIOS,
  getScenarioByLiveId,
};

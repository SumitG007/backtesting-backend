const { createSlFlipPaperLiveEngine } = require('./createSlFlipPaperLiveEngine');
const {
  SCENARIO_A,
  SCENARIO_B,
  SCENARIO_C,
  SCENARIO_D,
} = require('./slFlipScenarioConfigs');

const engineA = createSlFlipPaperLiveEngine(SCENARIO_A);
const engineB = createSlFlipPaperLiveEngine(SCENARIO_B);
const engineC = createSlFlipPaperLiveEngine(SCENARIO_C);
const engineD = createSlFlipPaperLiveEngine(SCENARIO_D);

module.exports = {
  engineA,
  engineB,
  engineC,
  engineD,
  SCENARIO_A,
  SCENARIO_B,
  SCENARIO_C,
  SCENARIO_D,
};

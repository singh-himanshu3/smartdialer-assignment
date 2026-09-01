import type { PacingMode } from "../pacing/types.js";
import { runSimulation } from "../simulation/runner.js";
import { SCENARIOS, scenarioByName } from "../simulation/scenarios.js";

const arguments_ = process.argv.slice(2);
const scenarioArgument = valueAfter("--scenario", arguments_);
const modeArgument = (valueAfter("--mode", arguments_) ?? "PREDICTIVE").toUpperCase();
if (modeArgument !== "PROGRESSIVE" && modeArgument !== "PREDICTIVE") {
  throw new Error("--mode must be progressive or predictive");
}
const mode: PacingMode = modeArgument;
const scenarios = scenarioArgument === undefined ? SCENARIOS : [scenarioByName(scenarioArgument)];
const results = scenarios.map((scenario) => runSimulation(scenario, { mode, seed: 42 }));

console.table(
  results.map((result) => ({
    scenario: result.scenario,
    mode: result.mode,
    utilization: `${(result.averageAgentUtilization * 100).toFixed(1)}%`,
    initiated: result.callsInitiated,
    answered: result.callsAnswered,
    connected: result.callsConnected,
    abandoned: result.callsAbandoned,
    providerFailures: result.providerFailures,
    safetyReductions: result.safetyDecisions.REDUCED,
    safetyRejections: result.safetyDecisions.REJECTED,
    fallbacks: result.safetyDecisions.FALLBACK_TO_PROGRESSIVE,
  })),
);

for (const result of results) {
  process.stdout.write(`\nScenario ${result.scenario} decision samples:\n`);
  for (const explanation of result.firstDecisionExplanations) {
    process.stdout.write(`- ${explanation}\n`);
  }
}

function valueAfter(name: string, arguments_: readonly string[]): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

import { performance } from "node:perf_hooks";
import { runSimulation } from "../simulation/runner.js";
import { scenarioByName } from "../simulation/scenarios.js";

const scenario = scenarioByName("B");
const agentCounts = [100, 1_000, 10_000];
const rows = agentCounts.map((agents) => {
  const startedAt = performance.now();
  const result = runSimulation(scenario, {
    mode: "PREDICTIVE",
    seed: agents,
    overrideAgents: agents,
  });
  const elapsedMs = performance.now() - startedAt;
  return {
    agents,
    simulatedSeconds: result.durationSeconds,
    runtimeMs: Number(elapsedMs.toFixed(2)),
    callsInitiated: result.callsInitiated,
    peakRinging: result.peakRingingCalls,
    utilization: `${(result.averageAgentUtilization * 100).toFixed(1)}%`,
    abandoned: result.callsAbandoned,
  };
});

console.table(rows);
process.stdout.write(
  "This is a decision-engine/simulator load test. Database lock contention is covered separately by integration tests.\n",
);

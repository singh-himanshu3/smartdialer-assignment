import { evaluateScenario } from "../simulation/evaluation.js";
import { SCENARIOS } from "../simulation/scenarios.js";

const seeds = positiveIntegerAfter("--seeds", process.argv.slice(2)) ?? 30;
const evaluations = SCENARIOS.map((scenario) => evaluateScenario(scenario, seeds));

process.stdout.write(
  `SmartDialer safety evaluation (${seeds} deterministic seed${seeds === 1 ? "" : "s"} per mode and scenario)\n\n`,
);
console.table(
  evaluations.map((evaluation) => ({
    scenario: evaluation.scenario,
    progressiveUtilization: percentage(evaluation.progressive.averageUtilization),
    predictiveUtilization: percentage(evaluation.predictive.averageUtilization),
    utilizationLift: signedPercentagePoints(evaluation.utilizationLift),
    predictiveAbandonment: percentage(evaluation.predictive.abandonmentRate),
    predictiveAbandoned: evaluation.predictive.callsAbandoned,
    safetyFallbacks: evaluation.predictive.safetyFallbacks,
    safetyRejections: evaluation.predictive.safetyRejections,
  })),
);

const stable = evaluations.filter((evaluation) => evaluation.scenario !== "D");
const shock = evaluations.find((evaluation) => evaluation.scenario === "D");
const lowAnswer = evaluations.find((evaluation) => evaluation.scenario === "A");
const checks = [
  {
    name: "No abandoned predictive answers in stable scenarios A-C",
    passed: stable.every((evaluation) => evaluation.predictive.callsAbandoned === 0),
  },
  {
    name: "Shock-scenario predictive abandonment remains below 2%",
    passed: shock !== undefined && shock.predictive.abandonmentRate < 0.02,
  },
  {
    name: "Low-answer predictive utilization improves by at least 2 percentage points",
    passed: lowAnswer !== undefined && lowAnswer.utilizationLift >= 0.02,
  },
  {
    name: "Unsafe provider/capacity conditions trigger rejection or fallback",
    passed:
      shock !== undefined &&
      shock.predictive.safetyRejections > 0 &&
      shock.predictive.safetyFallbacks > 0,
  },
];

process.stdout.write("\nAcceptance checks:\n");
for (const check of checks) {
  process.stdout.write(`- ${check.passed ? "PASS" : "FAIL"}: ${check.name}\n`);
}

if (checks.some((check) => !check.passed)) process.exitCode = 1;

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function signedPercentagePoints(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(2)} pp`;
}

function positiveIntegerAfter(name: string, arguments_: readonly string[]): number | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const raw = arguments_[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be followed by a positive integer.`);
  }
  return value;
}

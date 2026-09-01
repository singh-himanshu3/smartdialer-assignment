import type { PacingMode } from "../pacing/types.js";
import { runSimulation } from "./runner.js";
import type { SimulationScenario } from "./scenarios.js";

export interface ModeEvaluation {
  readonly mode: PacingMode;
  readonly seeds: number;
  readonly averageUtilization: number;
  readonly callsAnswered: number;
  readonly callsAbandoned: number;
  readonly abandonmentRate: number;
  readonly safetyRejections: number;
  readonly safetyFallbacks: number;
}

export interface ScenarioEvaluation {
  readonly scenario: string;
  readonly description: string;
  readonly progressive: ModeEvaluation;
  readonly predictive: ModeEvaluation;
  readonly utilizationLift: number;
}

export function evaluateScenario(
  scenario: SimulationScenario,
  seeds = 30,
): ScenarioEvaluation {
  if (!Number.isInteger(seeds) || seeds <= 0) {
    throw new Error("The evaluation seed count must be a positive integer.");
  }

  const progressive = evaluateMode(scenario, "PROGRESSIVE", seeds);
  const predictive = evaluateMode(scenario, "PREDICTIVE", seeds);
  return {
    scenario: scenario.name,
    description: scenario.description,
    progressive,
    predictive,
    utilizationLift: predictive.averageUtilization - progressive.averageUtilization,
  };
}

function evaluateMode(
  scenario: SimulationScenario,
  mode: PacingMode,
  seeds: number,
): ModeEvaluation {
  let utilization = 0;
  let callsAnswered = 0;
  let callsAbandoned = 0;
  let safetyRejections = 0;
  let safetyFallbacks = 0;

  for (let seed = 1; seed <= seeds; seed += 1) {
    const result = runSimulation(scenario, { mode, seed });
    utilization += result.averageAgentUtilization;
    callsAnswered += result.callsAnswered;
    callsAbandoned += result.callsAbandoned;
    safetyRejections += result.safetyDecisions.REJECTED;
    safetyFallbacks += result.safetyDecisions.FALLBACK_TO_PROGRESSIVE;
  }

  return {
    mode,
    seeds,
    averageUtilization: utilization / seeds,
    callsAnswered,
    callsAbandoned,
    abandonmentRate: callsAnswered === 0 ? 0 : callsAbandoned / callsAnswered,
    safetyRejections,
    safetyFallbacks,
  };
}

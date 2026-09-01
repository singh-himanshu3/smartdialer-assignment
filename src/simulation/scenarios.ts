export interface ScenarioPoint {
  readonly answerRate: number;
  readonly averageTalkTimeSeconds: number;
  readonly providerFailureRate: number;
  readonly providerLatencyMs: number;
  readonly providerOutage: boolean;
  readonly availableAgentRatio: number;
}

export interface SimulationScenario {
  readonly name: string;
  readonly description: string;
  readonly durationSeconds: number;
  readonly initialAgents: number;
  at(second: number): ScenarioPoint;
}

const stable = (
  name: string,
  answerRate: number,
  averageTalkTimeSeconds: number,
): SimulationScenario => ({
  name,
  description: `${(answerRate * 100).toFixed(0)}% answer rate, ${averageTalkTimeSeconds}s average talk time`,
  durationSeconds: 600,
  initialAgents: 100,
  at: () => ({
    answerRate,
    averageTalkTimeSeconds,
    providerFailureRate: 0.01,
    providerLatencyMs: 500,
    providerOutage: false,
    availableAgentRatio: 1,
  }),
});

export const SCENARIOS: readonly SimulationScenario[] = [
  stable("A", 0.2, 120),
  stable("B", 0.5, 90),
  stable("C", 0.7, 180),
  {
    name: "D",
    description: "Changing answer rate/talk time, a 40% agent drop, and a provider outage",
    durationSeconds: 600,
    initialAgents: 100,
    at: (second) => {
      const firstPhase = second < 200;
      const outage = second >= 320 && second < 350;
      return {
        answerRate: firstPhase ? 0.25 : second < 400 ? 0.7 : 0.1,
        averageTalkTimeSeconds: firstPhase ? 90 : second < 400 ? 180 : 60,
        providerFailureRate: outage ? 1 : second >= 280 && second < 380 ? 0.15 : 0.02,
        providerLatencyMs: outage ? 8_000 : second >= 280 && second < 380 ? 4_000 : 600,
        providerOutage: outage,
        availableAgentRatio: second < 240 ? 1 : 0.6,
      };
    },
  },
];

export function scenarioByName(name: string): SimulationScenario {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name.toUpperCase());
  if (scenario === undefined) throw new Error(`Unknown scenario: ${name}`);
  return scenario;
}

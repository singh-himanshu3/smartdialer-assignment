import { describe, expect, it } from "vitest";
import { runSimulation } from "../../src/simulation/runner.js";
import { scenarioByName } from "../../src/simulation/scenarios.js";

describe("dialer simulation", () => {
  it("keeps stable progressive dialing free of abandoned answers", () => {
    const result = runSimulation(scenarioByName("A"), {
      mode: "PROGRESSIVE",
      seed: 7,
    });
    expect(result.callsInitiated).toBeGreaterThan(0);
    expect(result.callsAbandoned).toBe(0);
  });

  it("reacts to provider outage and agent loss in the changing scenario", () => {
    const result = runSimulation(scenarioByName("D"), {
      mode: "PREDICTIVE",
      seed: 9,
    });
    expect(result.safetyDecisions.REJECTED).toBeGreaterThan(0);
    expect(result.safetyDecisions.FALLBACK_TO_PROGRESSIVE).toBeGreaterThan(0);
  });

  it("keeps predictive abandonment at zero across stable seeded scenarios", () => {
    for (const scenarioName of ["A", "B", "C"] as const) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const result = runSimulation(scenarioByName(scenarioName), {
          mode: "PREDICTIVE",
          seed,
        });
        expect(result.callsAbandoned, `${scenarioName}, seed ${seed}`).toBe(0);
      }
    }
  });

  it("limits abandonment during a sudden 40% capacity loss", () => {
    let answered = 0;
    let abandoned = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const result = runSimulation(scenarioByName("D"), {
        mode: "PREDICTIVE",
        seed,
      });
      answered += result.callsAnswered;
      abandoned += result.callsAbandoned;
    }

    expect(abandoned / answered).toBeLessThan(0.02);
  });

  it("improves stable low-answer utilization over progressive dialing", () => {
    const progressive = runSimulation(scenarioByName("A"), {
      mode: "PROGRESSIVE",
      seed: 42,
    });
    const predictive = runSimulation(scenarioByName("A"), {
      mode: "PREDICTIVE",
      seed: 42,
    });

    expect(predictive.averageAgentUtilization).toBeGreaterThan(
      progressive.averageAgentUtilization + 0.02,
    );
  });
});

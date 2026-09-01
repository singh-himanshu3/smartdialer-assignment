import { describe, expect, it } from "vitest";
import { PredictivePacingEngine } from "../../src/pacing/predictive.js";
import { ProgressivePacingEngine } from "../../src/pacing/progressive.js";
import type { CampaignSnapshot } from "../../src/pacing/types.js";
import { SafetyController, hoeffdingUpperAnswerBound } from "../../src/safety/controller.js";

function snapshot(overrides: Partial<CampaignSnapshot> = {}): CampaignSnapshot {
  return {
    campaignId: "campaign-1",
    capturedAt: new Date("2026-09-01T00:00:00Z"),
    telemetryAgeMs: 50,
    availableAgents: 10,
    expectedAgentsFreeByAnswerHorizon: 0,
    connectedCalls: 0,
    ringingCalls: 0,
    outstandingDialPermits: 0,
    answeredWaitingCalls: 0,
    recentAttempts: 100,
    answerRateMean: 0.2,
    answerRateUpperBound: 0.3,
    averageSetupTimeMs: 5_000,
    averageTalkTimeMs: 120_000,
    recentAgentDropRatio: 0,
    provider: {
      healthy: true,
      errorRate: 0.01,
      p95LatencyMs: 200,
      consecutiveFailures: 0,
    },
    ...overrides,
  };
}

describe("pacing engines", () => {
  it("progressive mode proposes one call per available agent", () => {
    expect(new ProgressivePacingEngine().propose(snapshot()).requestedCalls).toBe(10);
  });

  it("predictive mode explains and proposes calls from the answer-rate estimate", () => {
    const proposal = new PredictivePacingEngine().propose(snapshot());
    expect(proposal.requestedCalls).toBe(45);
    expect(proposal.explanation).toContain("20.0% answer rate");
  });
});

describe("safety controller", () => {
  it("caps progressive calls at available agent capacity", () => {
    const proposal = new ProgressivePacingEngine().propose(snapshot({ availableAgents: 150 }));
    const decision = new SafetyController().evaluate(
      snapshot({ availableAgents: 150 }),
      proposal,
    );
    expect(decision.approvedCalls).toBe(100);
    expect(decision.verdict).toBe("REDUCED");
  });

  it("falls back to progressive mode when there is insufficient history", () => {
    const current = snapshot({ availableAgents: 7, recentAttempts: 4 });
    const decision = new SafetyController().evaluate(
      current,
      new PredictivePacingEngine().propose(current),
    );
    expect(decision.effectiveMode).toBe("PROGRESSIVE");
    expect(decision.approvedCalls).toBe(7);
    expect(decision.verdict).toBe("FALLBACK_TO_PROGRESSIVE");
  });

  it("rejects all calls when provider health is unsafe", () => {
    const current = snapshot({ provider: { healthy: false, errorRate: 1, p95LatencyMs: 9_000, consecutiveFailures: 4 } });
    const decision = new SafetyController().evaluate(
      current,
      new PredictivePacingEngine().propose(current),
    );
    expect(decision.approvedCalls).toBe(0);
    expect(decision.verdict).toBe("REJECTED");
  });

  it("falls back immediately after a sudden agent-capacity drop", () => {
    const current = snapshot({ availableAgents: 60, recentAgentDropRatio: 0.4 });
    const decision = new SafetyController().evaluate(
      current,
      new PredictivePacingEngine().propose(current),
    );
    expect(decision.effectiveMode).toBe("PROGRESSIVE");
    expect(decision.verdict).toBe("FALLBACK_TO_PROGRESSIVE");
    expect(decision.reasons[0]).toContain("dropped 40.0%");
  });

  it("uses a conservative answer bound", () => {
    expect(hoeffdingUpperAnswerBound(20, 0.3, 0.01)).toBeGreaterThan(6);
  });
});

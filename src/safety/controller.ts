import type {
  CampaignSnapshot,
  DialProposal,
  SafetyDecision,
  SafetyVerdict,
} from "../pacing/types.js";

export interface SafetyControllerConfig {
  readonly reserveAgentRatio: number;
  readonly maximumCallsPerDecision: number;
  readonly maximumTelemetryAgeMs: number;
  readonly minimumPredictiveSamples: number;
  readonly maximumProviderErrorRate: number;
  readonly maximumProviderP95LatencyMs: number;
  readonly suddenAgentDropRatio: number;
  readonly riskProbability: number;
}

export const DEFAULT_SAFETY_CONFIG: SafetyControllerConfig = {
  reserveAgentRatio: 0.15,
  maximumCallsPerDecision: 100,
  maximumTelemetryAgeMs: 2_000,
  minimumPredictiveSamples: 30,
  maximumProviderErrorRate: 0.1,
  maximumProviderP95LatencyMs: 5_000,
  suddenAgentDropRatio: 0.2,
  // This bound is evaluated once per campaign tick. Keep it much smaller than
  // the acceptable run-level risk because a campaign makes hundreds of ticks.
  riskProbability: 0.000001,
};

export class SafetyController {
  constructor(private readonly config: SafetyControllerConfig = DEFAULT_SAFETY_CONFIG) {}

  evaluate(snapshot: CampaignSnapshot, proposal: DialProposal): SafetyDecision {
    if (proposal.campaignId !== snapshot.campaignId) {
      return this.decision(snapshot, proposal, 0, "PREDICTIVE", "REJECTED", [
        "The proposal campaign does not match the safety snapshot.",
      ]);
    }

    const hardFailure = this.hardFailureReason(snapshot);
    if (hardFailure !== undefined) {
      return this.decision(snapshot, proposal, 0, proposal.mode, "REJECTED", [hardFailure]);
    }

    if (proposal.mode === "PROGRESSIVE") {
      const approved = Math.min(
        proposal.requestedCalls,
        snapshot.availableAgents,
        this.config.maximumCallsPerDecision,
      );
      return this.decision(
        snapshot,
        proposal,
        approved,
        "PROGRESSIVE",
        verdictFor(proposal.requestedCalls, approved),
        approved < proposal.requestedCalls
          ? ["Progressive calls were capped by current agent capacity or the batch limit."]
          : ["Every approved call has a currently available agent."],
      );
    }

    const fallbackReason = this.predictiveFallbackReason(snapshot);
    if (fallbackReason !== undefined) {
      const progressiveCalls = Math.min(
        proposal.requestedCalls,
        snapshot.availableAgents,
        this.config.maximumCallsPerDecision,
      );
      return this.decision(
        snapshot,
        proposal,
        progressiveCalls,
        "PROGRESSIVE",
        "FALLBACK_TO_PROGRESSIVE",
        [fallbackReason],
      );
    }

    const projectedCapacity =
      snapshot.availableAgents + snapshot.expectedAgentsFreeByAnswerHorizon;
    const reserveAgents = Math.max(1, Math.ceil(projectedCapacity * this.config.reserveAgentRatio));
    const usableCapacity = Math.max(
      0,
      projectedCapacity - reserveAgents - snapshot.answeredWaitingCalls,
    );
    const requestCap = Math.min(proposal.requestedCalls, this.config.maximumCallsPerDecision);
    const approved = this.maximumSafeNewCalls(
      snapshot.ringingCalls + snapshot.outstandingDialPermits,
      requestCap,
      snapshot.answerRateUpperBound,
      usableCapacity,
    );

    const reasons = [
      `Reserved ${reserveAgents} projected agent slot(s) as safety headroom.`,
      `Conservative answer-rate bound is ${(snapshot.answerRateUpperBound * 100).toFixed(1)}%.`,
      `The risk bound allows ${approved} new call(s) within ${usableCapacity} usable future agent slot(s).`,
    ];

    return this.decision(
      snapshot,
      proposal,
      approved,
      "PREDICTIVE",
      verdictFor(proposal.requestedCalls, approved),
      reasons,
    );
  }

  private hardFailureReason(snapshot: CampaignSnapshot): string | undefined {
    if (snapshot.telemetryAgeMs > this.config.maximumTelemetryAgeMs) {
      return `Telemetry is stale (${snapshot.telemetryAgeMs}ms old).`;
    }
    if (!snapshot.provider.healthy) {
      return "The provider reports an unhealthy state.";
    }
    if (snapshot.provider.consecutiveFailures >= 3) {
      return "The provider has at least three consecutive failures.";
    }
    return undefined;
  }

  private predictiveFallbackReason(snapshot: CampaignSnapshot): string | undefined {
    if (snapshot.recentAttempts < this.config.minimumPredictiveSamples) {
      return `Only ${snapshot.recentAttempts} recent attempt(s) are available; predictive mode requires ${this.config.minimumPredictiveSamples}.`;
    }
    if (snapshot.provider.errorRate > this.config.maximumProviderErrorRate) {
      return `Provider error rate ${(snapshot.provider.errorRate * 100).toFixed(1)}% exceeds the predictive limit.`;
    }
    if (snapshot.provider.p95LatencyMs > this.config.maximumProviderP95LatencyMs) {
      return `Provider p95 latency ${snapshot.provider.p95LatencyMs}ms exceeds the predictive limit.`;
    }
    if (snapshot.recentAgentDropRatio >= this.config.suddenAgentDropRatio) {
      return `Agent capacity recently dropped ${(snapshot.recentAgentDropRatio * 100).toFixed(1)}%.`;
    }
    return undefined;
  }

  private maximumSafeNewCalls(
    existingRinging: number,
    maximumNewCalls: number,
    answerRateUpperBound: number,
    usableCapacity: number,
  ): number {
    let low = 0;
    let high = Math.max(0, maximumNewCalls);

    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      const upperAnswers = hoeffdingUpperAnswerBound(
        existingRinging + candidate,
        answerRateUpperBound,
        this.config.riskProbability,
      );
      if (upperAnswers <= usableCapacity) {
        low = candidate;
      } else {
        high = candidate - 1;
      }
    }

    return low;
  }

  private decision(
    snapshot: CampaignSnapshot,
    proposal: DialProposal,
    approvedCalls: number,
    effectiveMode: "PROGRESSIVE" | "PREDICTIVE",
    verdict: SafetyVerdict,
    reasons: readonly string[],
  ): SafetyDecision {
    return {
      proposalId: proposal.proposalId,
      campaignId: proposal.campaignId,
      requestedCalls: proposal.requestedCalls,
      approvedCalls,
      requestedMode: proposal.mode,
      effectiveMode,
      verdict,
      reasons,
      limits: {
        maximumCallsPerDecision: this.config.maximumCallsPerDecision,
        maximumTelemetryAgeMs: this.config.maximumTelemetryAgeMs,
        riskProbability: this.config.riskProbability,
        snapshotCapturedAt: snapshot.capturedAt.toISOString(),
      },
      decidedAt: new Date(),
    };
  }
}

export function hoeffdingUpperAnswerBound(
  attempts: number,
  answerProbability: number,
  riskProbability: number,
): number {
  if (attempts <= 0) return 0;
  const safeProbability = Math.min(1, Math.max(0, answerProbability));
  const safeRisk = Math.min(0.5, Math.max(Number.EPSILON, riskProbability));
  const deviation = Math.sqrt((attempts * Math.log(1 / safeRisk)) / 2);
  return Math.min(attempts, Math.ceil(attempts * safeProbability + deviation));
}

function verdictFor(requested: number, approved: number): SafetyVerdict {
  if (approved <= 0) return "REJECTED";
  if (approved < requested) return "REDUCED";
  return "APPROVED";
}

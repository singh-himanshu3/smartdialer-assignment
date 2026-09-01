export type PacingMode = "PROGRESSIVE" | "PREDICTIVE";

export interface ProviderHealthSnapshot {
  readonly healthy: boolean;
  readonly errorRate: number;
  readonly p95LatencyMs: number;
  readonly consecutiveFailures: number;
}

export interface CampaignSnapshot {
  readonly campaignId: string;
  readonly capturedAt: Date;
  readonly telemetryAgeMs: number;
  readonly availableAgents: number;
  readonly expectedAgentsFreeByAnswerHorizon: number;
  readonly connectedCalls: number;
  readonly ringingCalls: number;
  readonly outstandingDialPermits: number;
  readonly answeredWaitingCalls: number;
  readonly recentAttempts: number;
  readonly answerRateMean: number;
  readonly answerRateUpperBound: number;
  readonly averageSetupTimeMs: number;
  readonly averageTalkTimeMs: number;
  readonly recentAgentDropRatio: number;
  readonly provider: ProviderHealthSnapshot;
}

export interface DialProposal {
  readonly proposalId: string;
  readonly campaignId: string;
  readonly mode: PacingMode;
  readonly requestedCalls: number;
  readonly explanation: string;
  readonly inputs: Readonly<Record<string, number | string | boolean>>;
  readonly createdAt: Date;
}

export type SafetyVerdict = "APPROVED" | "REDUCED" | "REJECTED" | "FALLBACK_TO_PROGRESSIVE";

export interface SafetyDecision {
  readonly proposalId: string;
  readonly campaignId: string;
  readonly requestedCalls: number;
  readonly approvedCalls: number;
  readonly requestedMode: PacingMode;
  readonly effectiveMode: PacingMode;
  readonly verdict: SafetyVerdict;
  readonly reasons: readonly string[];
  readonly limits: Readonly<Record<string, number | string | boolean>>;
  readonly decidedAt: Date;
}

export interface PacingEngine {
  propose(snapshot: CampaignSnapshot): DialProposal;
}

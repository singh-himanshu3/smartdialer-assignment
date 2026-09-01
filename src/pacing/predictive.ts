import { randomUUID } from "node:crypto";
import type { CampaignSnapshot, DialProposal, PacingEngine } from "./types.js";

export interface PredictivePacingConfig {
  readonly targetCapacityRatio: number;
  readonly minimumAnswerRate: number;
  readonly maximumProposalSize: number;
}

const DEFAULT_CONFIG: PredictivePacingConfig = {
  targetCapacityRatio: 0.95,
  minimumAnswerRate: 0.05,
  maximumProposalSize: 500,
};

export class PredictivePacingEngine implements PacingEngine {
  constructor(private readonly config: PredictivePacingConfig = DEFAULT_CONFIG) {}

  propose(snapshot: CampaignSnapshot): DialProposal {
    const futureCapacity =
      snapshot.availableAgents + snapshot.expectedAgentsFreeByAnswerHorizon;
    const targetAnswers = Math.floor(futureCapacity * this.config.targetCapacityRatio);
    const inFlightExposure = snapshot.ringingCalls + snapshot.outstandingDialPermits;
    const expectedAnswersFromRinging =
      inFlightExposure * snapshot.answerRateMean + snapshot.answeredWaitingCalls;
    const additionalAnswersWanted = Math.max(0, targetAnswers - expectedAnswersFromRinging);
    const answerRate = Math.max(snapshot.answerRateMean, this.config.minimumAnswerRate);
    const requestedCalls = Math.min(
      this.config.maximumProposalSize,
      Math.max(0, Math.ceil(additionalAnswersWanted / answerRate)),
    );

    return {
      proposalId: randomUUID(),
      campaignId: snapshot.campaignId,
      mode: "PREDICTIVE",
      requestedCalls,
      explanation:
        `Targeting ${targetAnswers} answer(s) at the setup horizon. ` +
        `${expectedAnswersFromRinging.toFixed(2)} are already expected from in-flight calls; ` +
        `${additionalAnswersWanted.toFixed(2)} more are wanted at a ${(answerRate * 100).toFixed(1)}% answer rate.`,
      inputs: {
        futureCapacity,
        targetAnswers,
        expectedAnswersFromRinging: Number(expectedAnswersFromRinging.toFixed(4)),
        inFlightExposure,
        additionalAnswersWanted: Number(additionalAnswersWanted.toFixed(4)),
        answerRate,
        averageSetupTimeMs: snapshot.averageSetupTimeMs,
        averageTalkTimeMs: snapshot.averageTalkTimeMs,
      },
      createdAt: new Date(),
    };
  }
}

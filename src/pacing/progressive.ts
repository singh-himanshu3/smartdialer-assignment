import { randomUUID } from "node:crypto";
import type { CampaignSnapshot, DialProposal, PacingEngine } from "./types.js";

export class ProgressivePacingEngine implements PacingEngine {
  propose(snapshot: CampaignSnapshot): DialProposal {
    const requestedCalls = Math.max(0, snapshot.availableAgents);

    return {
      proposalId: randomUUID(),
      campaignId: snapshot.campaignId,
      mode: "PROGRESSIVE",
      requestedCalls,
      explanation: `One call per currently available agent: ${snapshot.availableAgents} available agent(s).`,
      inputs: {
        availableAgents: snapshot.availableAgents,
      },
      createdAt: new Date(),
    };
  }
}

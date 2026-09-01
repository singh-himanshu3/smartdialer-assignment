import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  CampaignSnapshot,
  DialProposal,
  SafetyDecision,
} from "../pacing/types.js";
import { withTransaction } from "../persistence/database.js";

export interface IssuedSafetyDecision {
  readonly decisionId: string;
  readonly permitIds: readonly string[];
}

export class SafetyDecisionStore {
  constructor(
    private readonly pool: Pool,
    private readonly permitTtlMs = 5_000,
  ) {}

  async recordAndIssuePermits(
    snapshot: CampaignSnapshot,
    proposal: DialProposal,
    decision: SafetyDecision,
  ): Promise<IssuedSafetyDecision> {
    const decisionId = randomUUID();
    const permitIds = Array.from({ length: decision.approvedCalls }, () => randomUUID());
    const expiresAt = new Date(Date.now() + this.permitTtlMs);

    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO safety_decisions (
           id, proposal_id, campaign_id, requested_mode, effective_mode,
           requested_calls, approved_calls, verdict, reasons, snapshot, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
        [
          decisionId,
          proposal.proposalId,
          proposal.campaignId,
          decision.requestedMode,
          decision.effectiveMode,
          decision.requestedCalls,
          decision.approvedCalls,
          decision.verdict,
          JSON.stringify(decision.reasons),
          JSON.stringify(snapshot),
          decision.decidedAt,
        ],
      );

      for (const permitId of permitIds) {
        await client.query(
          `INSERT INTO dial_permits (id, decision_id, campaign_id, mode, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [permitId, decisionId, decision.campaignId, decision.effectiveMode, expiresAt],
        );
      }
    });

    return { decisionId, permitIds };
  }
}

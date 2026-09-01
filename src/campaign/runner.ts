import type { CallAllocator, AllocationResult } from "../allocation/service.js";
import type { PacingEngine, SafetyDecision } from "../pacing/types.js";
import type { SafetyController } from "../safety/controller.js";
import type { SafetyDecisionStore } from "../safety/decision-store.js";
import type { CampaignSnapshotRepository } from "./snapshot-repository.js";
import type { CampaignTickLock } from "./tick-lock.js";

export interface CampaignTickResult {
  readonly campaignId: string;
  readonly mode: "PROGRESSIVE" | "PREDICTIVE";
  readonly decision: SafetyDecision;
  readonly allocations: readonly AllocationResult[];
}

export class CampaignRunner {
  constructor(
    private readonly tickLock: CampaignTickLock,
    private readonly snapshots: CampaignSnapshotRepository,
    private readonly progressive: PacingEngine,
    private readonly predictive: PacingEngine,
    private readonly safety: SafetyController,
    private readonly decisions: SafetyDecisionStore,
    private readonly allocator: CallAllocator,
  ) {}

  async tick(campaignId: string): Promise<CampaignTickResult> {
    return this.tickLock.runExclusive(campaignId, () => this.tickExclusive(campaignId));
  }

  private async tickExclusive(campaignId: string): Promise<CampaignTickResult> {
    const configuration = await this.snapshots.loadConfiguration(campaignId);
    if (configuration === undefined) throw new Error(`Campaign ${campaignId} was not found.`);
    if (configuration.status !== "ACTIVE") {
      throw new Error(`Campaign ${campaignId} is ${configuration.status.toLowerCase()}.`);
    }

    const snapshot = await this.snapshots.capture(campaignId, configuration.provider);
    const engine = configuration.pacingMode === "PREDICTIVE" ? this.predictive : this.progressive;
    const proposal = engine.propose(snapshot);
    const decision = this.safety.evaluate(snapshot, proposal);
    const issued = await this.decisions.recordAndIssuePermits(snapshot, proposal, decision);
    const allocations = await this.allocator.allocateBatch(
      campaignId,
      issued.permitIds,
      configuration.provider,
    );

    return {
      campaignId,
      mode: configuration.pacingMode,
      decision,
      allocations,
    };
  }
}

import { CallAllocator } from "../allocation/service.js";
import { CampaignRunner } from "../campaign/runner.js";
import { CampaignSnapshotRepository } from "../campaign/snapshot-repository.js";
import { CampaignTickLock } from "../campaign/tick-lock.js";
import { loadConfig } from "../config.js";
import { PredictivePacingEngine } from "../pacing/predictive.js";
import { ProgressivePacingEngine } from "../pacing/progressive.js";
import { createPool } from "../persistence/database.js";
import { SafetyController } from "../safety/controller.js";
import { SafetyDecisionStore } from "../safety/decision-store.js";

const DEFAULT_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const campaignId = process.argv[2] ?? DEFAULT_CAMPAIGN_ID;
const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const runner = new CampaignRunner(
    new CampaignTickLock(pool),
    new CampaignSnapshotRepository(pool),
    new ProgressivePacingEngine(),
    new PredictivePacingEngine(),
    new SafetyController(),
    new SafetyDecisionStore(pool),
    new CallAllocator(pool, config.reservationTtlSeconds),
  );
  const result = await runner.tick(campaignId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await pool.end();
}

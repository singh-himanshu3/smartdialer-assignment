import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../config.js";
import { CallAllocator } from "../allocation/service.js";
import { CampaignRunner } from "../campaign/runner.js";
import { CampaignScheduler } from "../campaign/scheduler.js";
import { CampaignSnapshotRepository } from "../campaign/snapshot-repository.js";
import { CampaignTickLock } from "../campaign/tick-lock.js";
import { PredictivePacingEngine } from "../pacing/predictive.js";
import { ProgressivePacingEngine } from "../pacing/progressive.js";
import { createPool } from "../persistence/database.js";
import { createProviderA, createProviderB } from "../providers/mock-provider.js";
import { ProviderRegistry } from "../providers/registry.js";
import { SafetyController } from "../safety/controller.js";
import { SafetyDecisionStore } from "../safety/decision-store.js";
import { OutboxWorker } from "../workers/outbox-worker.js";
import { ProviderEventService } from "../workers/provider-event-service.js";
import { ProviderHealthReporter } from "../workers/provider-health-reporter.js";
import { RecoveryService } from "../workers/recovery-service.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const providers = new ProviderRegistry([createProviderA(), createProviderB()]);
const events = new ProviderEventService(pool);
const outbox = new OutboxWorker(pool, providers, `worker-${randomUUID()}`);
const recovery = new RecoveryService(pool);
const healthReporter = new ProviderHealthReporter(pool, providers);
const campaignRunner = new CampaignRunner(
  new CampaignTickLock(pool),
  new CampaignSnapshotRepository(pool),
  new ProgressivePacingEngine(),
  new PredictivePacingEngine(),
  new SafetyController(),
  new SafetyDecisionStore(pool),
  new CallAllocator(pool, config.reservationTtlSeconds),
);
const scheduler = new CampaignScheduler(pool, campaignRunner);
let running = true;
let nextHealthReportAt = 0;
let nextRecoveryAt = 0;
let nextCampaignTickAt = 0;

for (const provider of providers.all()) {
  provider.subscribe(async (event) => {
    const result = await events.accept(event);
    process.stdout.write(`Provider event ${event.type} for ${event.callId}: ${result}\n`);
  });
}

process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

process.stdout.write("SmartDialer worker started. Press Ctrl+C to stop.\n");
try {
  await healthReporter.report();
  while (running) {
    const processed = await outbox.runOnce();
    const now = Date.now();
    if (now >= nextHealthReportAt) {
      await healthReporter.report();
      nextHealthReportAt = now + 1_000;
    }
    if (now >= nextRecoveryAt) {
      await recovery.runOnce();
      nextRecoveryAt = now + 5_000;
    }
    if (now >= nextCampaignTickAt) {
      const scheduled = await scheduler.runOnce();
      for (const failure of scheduled.failures) {
        process.stderr.write(`Campaign ${failure.campaignId} tick failed: ${failure.error}\n`);
      }
      nextCampaignTickAt = now + 1_000;
    }
    if (!processed) await delay(config.workerPollMs);
  }
} finally {
  await pool.end();
}

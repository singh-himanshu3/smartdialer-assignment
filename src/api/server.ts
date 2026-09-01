import Fastify from "fastify";
import { CallAllocator } from "../allocation/service.js";
import { AgentService } from "../agents/service.js";
import { CampaignRunner } from "../campaign/runner.js";
import { CampaignAdminService, type CampaignStatus } from "../campaign/admin-service.js";
import { CampaignSnapshotRepository } from "../campaign/snapshot-repository.js";
import { CampaignTickLock } from "../campaign/tick-lock.js";
import { loadConfig } from "../config.js";
import { PROVIDER_EVENT_TYPES, type ProviderEvent, type ProviderEventType } from "../domain/provider-event.js";
import { PredictivePacingEngine } from "../pacing/predictive.js";
import type { PacingMode } from "../pacing/types.js";
import { ProgressivePacingEngine } from "../pacing/progressive.js";
import { createPool } from "../persistence/database.js";
import { SafetyController } from "../safety/controller.js";
import { SafetyDecisionStore } from "../safety/decision-store.js";
import { ProviderEventService } from "../workers/provider-event-service.js";
import { MetricsRepository } from "../metrics/repository.js";
import { loadDashboard } from "./dashboard.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const snapshots = new CampaignSnapshotRepository(pool);
const events = new ProviderEventService(pool);
const runner = new CampaignRunner(
  new CampaignTickLock(pool),
  snapshots,
  new ProgressivePacingEngine(),
  new PredictivePacingEngine(),
  new SafetyController(),
  new SafetyDecisionStore(pool),
  new CallAllocator(pool, config.reservationTtlSeconds),
);
const agents = new AgentService(pool);
const campaigns = new CampaignAdminService(pool);
const metrics = new MetricsRepository(pool);
const app = Fastify({ logger: true });

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(await loadDashboard());
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok" };
});

app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId", async (request) => {
  const configuration = await snapshots.loadConfiguration(request.params.campaignId);
  if (configuration === undefined) throw new Error("Campaign not found");
  return configuration;
});

app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/snapshot", async (request) => {
  const configuration = await snapshots.loadConfiguration(request.params.campaignId);
  if (configuration === undefined) throw new Error("Campaign not found");
  return snapshots.capture(configuration.id, configuration.provider);
});

app.post<{ Params: { campaignId: string } }>("/campaigns/:campaignId/tick", async (request) => {
  return runner.tick(request.params.campaignId);
});

app.patch<{
  Params: { campaignId: string };
  Body: { status?: string; pacingMode?: string; provider?: string };
}>("/campaigns/:campaignId", async (request) => {
  const status = request.body?.status;
  const pacingMode = request.body?.pacingMode;
  if (status !== undefined && !["ACTIVE", "PAUSED", "COMPLETED"].includes(status)) {
    throw new Error(`Unknown campaign status: ${status}`);
  }
  if (pacingMode !== undefined && !["PROGRESSIVE", "PREDICTIVE"].includes(pacingMode)) {
    throw new Error(`Unknown pacing mode: ${pacingMode}`);
  }
  return campaigns.update(request.params.campaignId, {
    ...(status === undefined ? {} : { status: status as CampaignStatus }),
    ...(pacingMode === undefined ? {} : { pacingMode: pacingMode as PacingMode }),
    ...(request.body.provider === undefined ? {} : { provider: request.body.provider }),
  });
});

app.get<{ Params: { campaignId: string } }>("/campaigns/:campaignId/metrics", async (request) => {
  return metrics.campaign(request.params.campaignId);
});

app.post<{ Params: { agentId: string }; Body: { state?: string } }>(
  "/agents/:agentId/state",
  async (request) => {
    if (typeof request.body?.state !== "string") throw new Error("A state is required");
    const state = await agents.transition(request.params.agentId, request.body.state);
    return { agentId: request.params.agentId, state };
  },
);

app.post<{ Body: Record<string, unknown> }>("/provider-events", async (request) => {
  const event = parseProviderEvent(request.body);
  return { result: await events.accept(event) };
});

app.addHook("onClose", async () => {
  await pool.end();
});

await app.listen({ host: "0.0.0.0", port: config.port });

function parseProviderEvent(body: Record<string, unknown>): ProviderEvent {
  const provider = requiredString(body.provider, "provider");
  const eventId = requiredString(body.eventId, "eventId");
  const callId = requiredString(body.callId, "callId");
  const externalCallId = requiredString(body.externalCallId, "externalCallId");
  const type = requiredString(body.type, "type");
  if (!(PROVIDER_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown provider event type: ${type}`);
  }
  return {
    provider,
    eventId,
    callId,
    externalCallId,
    type: type as ProviderEventType,
    occurredAt: typeof body.occurredAt === "string" ? new Date(body.occurredAt) : new Date(),
    payload: isRecord(body.payload) ? body.payload : {},
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

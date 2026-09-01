import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CallAllocator } from "../../src/allocation/service.js";
import { AgentService } from "../../src/agents/service.js";
import { ProgressivePacingEngine } from "../../src/pacing/progressive.js";
import { PredictivePacingEngine } from "../../src/pacing/predictive.js";
import type { CampaignSnapshot } from "../../src/pacing/types.js";
import { createPool } from "../../src/persistence/database.js";
import { createProviderA, createProviderB } from "../../src/providers/mock-provider.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { SafetyController } from "../../src/safety/controller.js";
import { SafetyDecisionStore } from "../../src/safety/decision-store.js";
import { OutboxWorker } from "../../src/workers/outbox-worker.js";
import { ProviderEventService } from "../../src/workers/provider-event-service.js";
import { RecoveryService } from "../../src/workers/recovery-service.js";
import { MetricsRepository } from "../../src/metrics/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("PostgreSQL concurrency and provider events", () => {
  let pool: Pool;
  let campaignId: string;

  beforeAll(() => {
    pool = createPool(databaseUrl as string);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE provider_events, outbox, calls, dial_permits, safety_decisions,
                borrowers, agents, campaigns RESTART IDENTITY CASCADE`,
    );
    campaignId = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, name, status, pacing_mode, provider)
       VALUES ($1, 'Integration campaign', 'ACTIVE', 'PROGRESSIVE', 'provider-a')`,
      [campaignId],
    );
    await pool.query(
      `INSERT INTO provider_health (provider)
       VALUES ('provider-a') ON CONFLICT (provider) DO UPDATE SET healthy = true`,
    );
  });

  it("allows only one worker to reserve the same available agent", async () => {
    await insertAgents(pool, campaignId, 1);
    await insertBorrowers(pool, campaignId, 2);
    const firstPermit = await issueProgressivePermit(pool, campaignId, 1);
    const secondPermit = await issueProgressivePermit(pool, campaignId, 1);
    const allocator = new CallAllocator(pool, 30);

    const results = await Promise.all([
      allocator.allocateOne(campaignId, firstPermit, "provider-a"),
      allocator.allocateOne(campaignId, secondPermit, "provider-a"),
    ]);

    expect(results.filter((result) => result.allocated)).toHaveLength(1);
    expect(
      results.filter((result) => !result.allocated).map((result) => result.reason),
    ).toEqual(["NO_AGENT"]);
    const activeCalls = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM calls
       WHERE state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED')`,
    );
    expect(activeCalls.rows[0]?.count).toBe("1");
  });

  it("consumes a dial permit at most once across concurrent workers", async () => {
    await insertAgents(pool, campaignId, 2);
    await insertBorrowers(pool, campaignId, 2);
    const permit = await issueProgressivePermit(pool, campaignId, 2);
    const allocator = new CallAllocator(pool, 30);

    const results = await Promise.all([
      allocator.allocateOne(campaignId, permit, "provider-a"),
      allocator.allocateOne(campaignId, permit, "provider-a"),
    ]);

    expect(results.filter((result) => result.allocated)).toHaveLength(1);
    expect(results.filter((result) => !result.allocated)[0]).toMatchObject({
      reason: "PERMIT_UNAVAILABLE",
    });
  });

  it("deduplicates provider events and prevents terminal-state regression", async () => {
    await insertAgents(pool, campaignId, 1);
    await insertBorrowers(pool, campaignId, 1);
    const permit = await issueProgressivePermit(pool, campaignId, 1);
    const allocator = new CallAllocator(pool, 30);
    const allocation = await allocator.allocateOne(campaignId, permit, "provider-a");
    if (!allocation.allocated) throw new Error("Expected a call allocation");

    const provider = createProviderA(
      () => 0.5,
      (_delayMs, _task) => undefined,
    );
    const worker = new OutboxWorker(
      pool,
      new ProviderRegistry([provider]),
      "integration-worker",
    );
    expect(await worker.runOnce()).toBe(true);

    const callResult = await pool.query<{ external_call_id: string }>(
      "SELECT external_call_id FROM calls WHERE id = $1",
      [allocation.call.callId],
    );
    const externalCallId = callResult.rows[0]?.external_call_id;
    if (externalCallId === undefined) throw new Error("Expected an external call id");
    const eventService = new ProviderEventService(pool);
    const answeredEvent = {
      provider: "provider-a",
      eventId: "event-answered-1",
      callId: allocation.call.callId,
      externalCallId,
      type: "ANSWERED" as const,
      occurredAt: new Date(),
      payload: {},
    };

    expect(await eventService.accept(answeredEvent)).toBe("APPLIED");
    expect(await eventService.accept(answeredEvent)).toBe("DUPLICATE");
    expect(
      await eventService.accept({
        ...answeredEvent,
        eventId: "event-completed-1",
        type: "COMPLETED",
      }),
    ).toBe("APPLIED");
    expect(
      await eventService.accept({
        ...answeredEvent,
        eventId: "event-ringing-late",
        type: "RINGING",
      }),
    ).toBe("IGNORED_TERMINAL");

    const finalCall = await pool.query<{ state: string }>(
      "SELECT state FROM calls WHERE id = $1",
      [allocation.call.callId],
    );
    expect(finalCall.rows[0]?.state).toBe("COMPLETED");
  });

  it("recovers an outbox lease after a worker crash", async () => {
    await insertAgents(pool, campaignId, 1);
    await insertBorrowers(pool, campaignId, 1);
    const permit = await issueProgressivePermit(pool, campaignId, 1);
    const allocation = await new CallAllocator(pool, 30).allocateOne(
      campaignId,
      permit,
      "provider-a",
    );
    if (!allocation.allocated) throw new Error("Expected a call allocation");

    await pool.query(
      `UPDATE outbox
       SET status = 'PROCESSING', lease_owner = 'crashed-worker',
           lease_until = now() - interval '1 second'`,
    );
    const recovery = await new RecoveryService(pool).runOnce();
    expect(recovery.resetOutboxLeases).toBe(1);

    const provider = createProviderA(() => 0.5, (_delayMs, _task) => undefined);
    const worker = new OutboxWorker(pool, new ProviderRegistry([provider]), "replacement-worker");
    expect(await worker.runOnce()).toBe(true);
    const outbox = await pool.query<{ status: string }>("SELECT status FROM outbox");
    expect(outbox.rows[0]?.status).toBe("COMPLETED");
  });

  it("releases reservations after a provider command exhausts its retries", async () => {
    await insertAgents(pool, campaignId, 1);
    await insertBorrowers(pool, campaignId, 1);
    const permit = await issueProgressivePermit(pool, campaignId, 1);
    const allocation = await new CallAllocator(pool, 30).allocateOne(
      campaignId,
      permit,
      "provider-b",
    );
    if (!allocation.allocated) throw new Error("Expected a call allocation");

    const provider = createProviderB(() => 0.5, (_delayMs, _task) => undefined);
    provider.setOutage(true);
    const worker = new OutboxWorker(
      pool,
      new ProviderRegistry([provider]),
      "outage-worker",
      15,
      1,
    );
    expect(await worker.runOnce()).toBe(true);
    const recovery = await new RecoveryService(pool).runOnce();
    expect(recovery.failedCallsReleased).toBe(1);

    const states = await pool.query<{ call_state: string; agent_state: string; borrower_state: string }>(
      `SELECT call.state AS call_state, agent.state AS agent_state, borrower.state AS borrower_state
       FROM calls AS call
       JOIN agents AS agent ON agent.id = call.agent_id
       JOIN borrowers AS borrower ON borrower.id = call.borrower_id
       WHERE call.id = $1`,
      [allocation.call.callId],
    );
    expect(states.rows[0]).toMatchObject({
      call_state: "FAILED",
      agent_state: "AVAILABLE",
      borrower_state: "READY",
    });
  });

  it("reassigns an answer if the progressive agent disappears during setup", async () => {
    await insertAgents(pool, campaignId, 2);
    await insertBorrowers(pool, campaignId, 1);
    const permit = await issueProgressivePermit(pool, campaignId, 2);
    const allocation = await new CallAllocator(pool, 30).allocateOne(
      campaignId,
      permit,
      "provider-a",
    );
    if (!allocation.allocated || allocation.call.agentId === null) {
      throw new Error("Expected a progressive call allocation");
    }

    const provider = createProviderA(() => 0.5, (_delayMs, _task) => undefined);
    await new OutboxWorker(
      pool,
      new ProviderRegistry([provider]),
      "setup-worker",
    ).runOnce();
    await new AgentService(pool).transition(allocation.call.agentId, "OFFLINE");
    const call = await pool.query<{ external_call_id: string }>(
      "SELECT external_call_id FROM calls WHERE id = $1",
      [allocation.call.callId],
    );
    const externalCallId = call.rows[0]?.external_call_id;
    if (externalCallId === undefined) throw new Error("Expected an external call id");

    expect(
      await new ProviderEventService(pool).accept({
        provider: "provider-a",
        eventId: "answer-after-agent-disappeared",
        callId: allocation.call.callId,
        externalCallId,
        type: "ANSWERED",
        occurredAt: new Date(),
        payload: {},
      }),
    ).toBe("APPLIED");
    const reassigned = await pool.query<{ agent_id: string; state: string }>(
      "SELECT agent_id, state FROM calls WHERE id = $1",
      [allocation.call.callId],
    );
    expect(reassigned.rows[0]?.agent_id).not.toBe(allocation.call.agentId);
    expect(reassigned.rows[0]?.state).toBe("ANSWERED");
  });

  it("records an abandonment if every agent disappears before a predictive answer", async () => {
    await insertAgents(pool, campaignId, 10);
    await insertBorrowers(pool, campaignId, 20);
    const snapshot = campaignSnapshot(campaignId, 10);
    const proposal = new PredictivePacingEngine().propose(snapshot);
    const decision = new SafetyController().evaluate(snapshot, proposal);
    const issued = await new SafetyDecisionStore(pool).recordAndIssuePermits(
      snapshot,
      proposal,
      decision,
    );
    const permit = issued.permitIds[0];
    if (permit === undefined) throw new Error("Expected a predictive permit");
    const allocation = await new CallAllocator(pool, 30).allocateOne(
      campaignId,
      permit,
      "provider-a",
    );
    if (!allocation.allocated) throw new Error("Expected a predictive call allocation");

    const provider = createProviderA(() => 0.5, (_delayMs, _task) => undefined);
    await new OutboxWorker(
      pool,
      new ProviderRegistry([provider]),
      "predictive-worker",
    ).runOnce();
    await pool.query(
      `UPDATE agents
       SET state = 'OFFLINE', reservation_id = NULL, reserved_until = NULL,
           state_changed_at = now()
       WHERE campaign_id = $1`,
      [campaignId],
    );
    const call = await pool.query<{ external_call_id: string }>(
      "SELECT external_call_id FROM calls WHERE id = $1",
      [allocation.call.callId],
    );
    const externalCallId = call.rows[0]?.external_call_id;
    if (externalCallId === undefined) throw new Error("Expected an external call id");

    const result = await new ProviderEventService(pool).accept({
      provider: "provider-a",
      eventId: "predictive-answer-no-agent",
      callId: allocation.call.callId,
      externalCallId,
      type: "ANSWERED",
      occurredAt: new Date(),
      payload: {},
    });
    expect(result).toBe("ABANDONED_NO_AGENT");
    const finalCall = await pool.query<{ state: string; answered_at: Date | null }>(
      "SELECT state, answered_at FROM calls WHERE id = $1",
      [allocation.call.callId],
    );
    expect(finalCall.rows[0]?.state).toBe("ABANDONED");
    expect(finalCall.rows[0]?.answered_at).toBeInstanceOf(Date);

    const metrics = await new MetricsRepository(pool).campaign(campaignId);
    expect(metrics.evaluation.prediction.sampleSize).toBe(1);
    expect(metrics.evaluation.prediction.observedAnswerRate).toBe(1);
    expect(metrics.evaluation.prediction.predictedAnswerRate).toBeCloseTo(0.2);
    expect(metrics.evaluation.prediction.calibrationErrorPercentagePoints).toBeCloseTo(80);
    expect(metrics.evaluation.prediction.brierScore).toBeCloseTo(0.64);
    expect(metrics.evaluation.operations.abandonmentRate).toBe(1);
  });
});

async function issueProgressivePermit(
  pool: Pool,
  campaignId: string,
  availableAgents: number,
): Promise<string> {
  const snapshot = campaignSnapshot(campaignId, availableAgents);
  const proposal = new ProgressivePacingEngine().propose(snapshot);
  const decision = new SafetyController().evaluate(snapshot, proposal);
  const issued = await new SafetyDecisionStore(pool).recordAndIssuePermits(
    snapshot,
    proposal,
    decision,
  );
  const permit = issued.permitIds[0];
  if (permit === undefined) throw new Error("Expected a permit");
  return permit;
}

async function insertAgents(pool: Pool, campaignId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `INSERT INTO agents (id, campaign_id, display_name, state)
       VALUES ($1, $2, $3, 'AVAILABLE')`,
      [randomUUID(), campaignId, `Agent ${index + 1}`],
    );
  }
}

async function insertBorrowers(pool: Pool, campaignId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `INSERT INTO borrowers (id, campaign_id, phone_number, priority)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), campaignId, `+1555000${index}`, count - index],
    );
  }
}

function campaignSnapshot(campaignId: string, availableAgents: number): CampaignSnapshot {
  return {
    campaignId,
    capturedAt: new Date(),
    telemetryAgeMs: 0,
    availableAgents,
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
      errorRate: 0,
      p95LatencyMs: 100,
      consecutiveFailures: 0,
    },
  };
}

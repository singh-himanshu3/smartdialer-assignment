import type { Pool } from "pg";
import type { CampaignSnapshot, PacingMode } from "../pacing/types.js";

interface CampaignRow {
  readonly id: string;
  readonly status: "ACTIVE" | "PAUSED" | "COMPLETED";
  readonly pacing_mode: PacingMode;
  readonly provider: string;
}

interface AgentAggregateRow {
  readonly available: string;
  readonly wrap_up: string;
  readonly recent_offline: string;
  readonly total: string;
}

interface CallAggregateRow {
  readonly connected: string;
  readonly ringing: string;
  readonly answered_waiting: string;
  readonly recent_attempts: string;
  readonly recent_answers: string;
  readonly average_setup_ms: string | null;
  readonly average_talk_ms: string | null;
}

interface ProviderHealthRow {
  readonly healthy: boolean;
  readonly error_rate: number;
  readonly p95_latency_ms: number;
  readonly consecutive_failures: number;
  readonly updated_at: Date;
}

interface PermitAggregateRow {
  readonly outstanding: string;
}

export interface CampaignConfiguration {
  readonly id: string;
  readonly status: "ACTIVE" | "PAUSED" | "COMPLETED";
  readonly pacingMode: PacingMode;
  readonly provider: string;
}

export class CampaignSnapshotRepository {
  constructor(private readonly pool: Pool) {}

  async loadConfiguration(campaignId: string): Promise<CampaignConfiguration | undefined> {
    const result = await this.pool.query<CampaignRow>(
      `SELECT id, status, pacing_mode, provider FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, status: row.status, pacingMode: row.pacing_mode, provider: row.provider };
  }

  async capture(campaignId: string, provider: string): Promise<CampaignSnapshot> {
    const [agentResult, callResult, permitResult, healthResult] = await Promise.all([
      this.pool.query<AgentAggregateRow>(
        `SELECT
           count(*) FILTER (WHERE state = 'AVAILABLE')::text AS available,
           count(*) FILTER (WHERE state = 'WRAP_UP')::text AS wrap_up,
           count(*) FILTER (
             WHERE state = 'OFFLINE' AND state_changed_at >= now() - interval '3 seconds'
           )::text AS recent_offline,
           count(*)::text AS total
         FROM agents WHERE campaign_id = $1`,
        [campaignId],
      ),
      this.pool.query<CallAggregateRow>(
        `SELECT
           count(*) FILTER (WHERE state = 'CONNECTED')::text AS connected,
           count(*) FILTER (WHERE state IN ('RESERVED', 'INITIATED', 'RINGING'))::text AS ringing,
           count(*) FILTER (WHERE state = 'ANSWERED')::text AS answered_waiting,
           count(*) FILTER (WHERE initiated_at >= now() - interval '15 minutes')::text AS recent_attempts,
           count(*) FILTER (
             WHERE initiated_at >= now() - interval '15 minutes' AND answered_at IS NOT NULL
           )::text AS recent_answers,
           avg(extract(epoch FROM (answered_at - initiated_at)) * 1000)
             FILTER (WHERE answered_at IS NOT NULL AND initiated_at IS NOT NULL)::text AS average_setup_ms,
           avg(extract(epoch FROM (completed_at - connected_at)) * 1000)
             FILTER (WHERE completed_at IS NOT NULL AND connected_at IS NOT NULL)::text AS average_talk_ms
         FROM calls WHERE campaign_id = $1`,
        [campaignId],
      ),
      this.pool.query<PermitAggregateRow>(
        `SELECT count(*)::text AS outstanding
         FROM dial_permits
         WHERE campaign_id = $1 AND status = 'ISSUED' AND expires_at > now()`,
        [campaignId],
      ),
      this.pool.query<ProviderHealthRow>(
        `SELECT healthy, error_rate, p95_latency_ms, consecutive_failures, updated_at
         FROM provider_health WHERE provider = $1`,
        [provider],
      ),
    ]);

    const agents = requiredRow(agentResult.rows[0], "agent aggregate");
    const calls = requiredRow(callResult.rows[0], "call aggregate");
    const permits = requiredRow(permitResult.rows[0], "permit aggregate");
    const health = healthResult.rows[0] ?? {
      healthy: false,
      error_rate: 1,
      p95_latency_ms: 0,
      consecutive_failures: 0,
      updated_at: new Date(0),
    };
    const recentAttempts = number(calls.recent_attempts);
    const recentAnswers = number(calls.recent_answers);
    const answerRateMean = (recentAnswers + 2) / (recentAttempts + 10);
    const answerRateUpperBound = Math.min(
      1,
      answerRateMean + 1.96 * Math.sqrt((answerRateMean * (1 - answerRateMean)) / (recentAttempts + 10)),
    );
    const totalAgents = number(agents.total);

    return {
      campaignId,
      capturedAt: new Date(),
      telemetryAgeMs: Math.max(0, Date.now() - new Date(health.updated_at).getTime()),
      availableAgents: number(agents.available),
      expectedAgentsFreeByAnswerHorizon: number(agents.wrap_up),
      connectedCalls: number(calls.connected),
      ringingCalls: number(calls.ringing),
      outstandingDialPermits: number(permits.outstanding),
      answeredWaitingCalls: number(calls.answered_waiting),
      recentAttempts,
      answerRateMean,
      answerRateUpperBound,
      averageSetupTimeMs: nullableNumber(calls.average_setup_ms, 5_000),
      averageTalkTimeMs: nullableNumber(calls.average_talk_ms, 120_000),
      recentAgentDropRatio: totalAgents === 0 ? 0 : number(agents.recent_offline) / totalAgents,
      provider: {
        healthy: health.healthy,
        errorRate: health.error_rate,
        p95LatencyMs: health.p95_latency_ms,
        consecutiveFailures: health.consecutive_failures,
      },
    };
  }
}

function number(value: string): number {
  return Number(value);
}

function nullableNumber(value: string | null, fallback: number): number {
  return value === null ? fallback : Number(value);
}

function requiredRow<T>(row: T | undefined, label: string): T {
  if (row === undefined) throw new Error(`Missing ${label}`);
  return row;
}

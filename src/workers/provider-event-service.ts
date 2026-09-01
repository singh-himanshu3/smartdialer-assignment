import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canTransitionCall, isTerminalCallState, type CallState } from "../domain/call.js";
import { EVENT_TO_CALL_STATE, type ProviderEvent } from "../domain/provider-event.js";
import { withTransaction } from "../persistence/database.js";

interface CallRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly borrower_id: string;
  readonly agent_id: string | null;
  readonly mode: "PROGRESSIVE" | "PREDICTIVE";
  readonly state: CallState;
}

interface IdRow {
  readonly id: string;
}

interface AgentStateRow {
  readonly state: string;
}

export type ProviderEventResult =
  | "APPLIED"
  | "DUPLICATE"
  | "IGNORED_TERMINAL"
  | "IGNORED_OUT_OF_ORDER"
  | "ABANDONED_NO_AGENT"
  | "UNKNOWN_CALL";

export class ProviderEventService {
  constructor(
    private readonly pool: Pool,
    private readonly answerReservationTtlSeconds = 10,
  ) {}

  async accept(event: ProviderEvent): Promise<ProviderEventResult> {
    return withTransaction(this.pool, async (client) => {
      const callResult = await client.query<CallRow>(
        `SELECT id, campaign_id, borrower_id, agent_id, mode, state
         FROM calls WHERE id = $1 FOR UPDATE`,
        [event.callId],
      );
      const call = callResult.rows[0];
      if (call === undefined) return "UNKNOWN_CALL";

      const inserted = await client.query<IdRow>(
        `INSERT INTO provider_events (
           id, provider, provider_event_id, call_id, external_call_id,
           event_type, occurred_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          event.provider,
          event.eventId,
          event.callId,
          event.externalCallId,
          event.type,
          event.occurredAt,
          JSON.stringify(event.payload),
        ],
      );
      const eventRecordId = inserted.rows[0]?.id;
      if (eventRecordId === undefined) return "DUPLICATE";

      if (isTerminalCallState(call.state)) {
        await this.markProcessed(client, eventRecordId, "IGNORED_TERMINAL");
        return "IGNORED_TERMINAL";
      }

      let targetState = EVENT_TO_CALL_STATE[event.type];
      if (!canTransitionCall(call.state, targetState)) {
        await this.markProcessed(client, eventRecordId, "IGNORED_OUT_OF_ORDER");
        return "IGNORED_OUT_OF_ORDER";
      }

      let agentId = call.agent_id;
      if (targetState === "ANSWERED" || targetState === "CONNECTED") {
        agentId = await this.validateAssignedAgent(client, agentId);
        if (agentId === null) {
          agentId = await this.reserveAgentForAnswer(client, call.campaign_id, call.id);
          if (agentId === null) {
            targetState = "ABANDONED";
            await client.query(
              `UPDATE campaigns
               SET safety_incidents = safety_incidents + 1, updated_at = now()
               WHERE id = $1`,
              [call.campaign_id],
            );
          }
        }
      }

      await this.updateCall(client, call, agentId, targetState, event.externalCallId);
      await this.updateRelatedState(client, call, agentId, targetState);
      const result: ProviderEventResult =
        targetState === "ABANDONED" ? "ABANDONED_NO_AGENT" : "APPLIED";
      await this.markProcessed(client, eventRecordId, result);
      return result;
    });
  }

  private async reserveAgentForAnswer(
    client: PoolClient,
    campaignId: string,
    callId: string,
  ): Promise<string | null> {
    const result = await client.query<IdRow>(
      `WITH candidate AS (
         SELECT id FROM agents
         WHERE campaign_id = $1 AND state = 'AVAILABLE'
         ORDER BY state_changed_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE agents AS agent
       SET state = 'RESERVED', reservation_id = $2,
           reserved_until = now() + ($3 * interval '1 second'),
           state_changed_at = now(), version = version + 1
       FROM candidate
       WHERE agent.id = candidate.id
       RETURNING agent.id`,
      [campaignId, callId, this.answerReservationTtlSeconds],
    );
    return result.rows[0]?.id ?? null;
  }

  private async validateAssignedAgent(
    client: PoolClient,
    agentId: string | null,
  ): Promise<string | null> {
    if (agentId === null) return null;
    const result = await client.query<AgentStateRow>(
      "SELECT state FROM agents WHERE id = $1 FOR UPDATE",
      [agentId],
    );
    return result.rows[0]?.state === "OFFLINE" ? null : agentId;
  }

  private async updateCall(
    client: PoolClient,
    call: CallRow,
    agentId: string | null,
    targetState: CallState,
    externalCallId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE calls
       SET state = $2,
           agent_id = CASE
             WHEN $2 IN ('ANSWERED', 'CONNECTED', 'ABANDONED') THEN $3
             ELSE COALESCE(agent_id, $3)
           END,
           external_call_id = COALESCE(external_call_id, $4),
           answered_at = CASE WHEN $2 IN ('ANSWERED', 'ABANDONED') THEN COALESCE(answered_at, now()) ELSE answered_at END,
           connected_at = CASE WHEN $2 = 'CONNECTED' THEN COALESCE(connected_at, now()) ELSE connected_at END,
           completed_at = CASE WHEN $2 IN ('COMPLETED', 'FAILED', 'CANCELLED', 'ABANDONED') THEN COALESCE(completed_at, now()) ELSE completed_at END,
           updated_at = now(),
           version = version + 1
       WHERE id = $1`,
      [call.id, targetState, agentId, externalCallId],
    );
  }

  private async updateRelatedState(
    client: PoolClient,
    call: CallRow,
    agentId: string | null,
    targetState: CallState,
  ): Promise<void> {
    if (agentId !== null && (targetState === "RINGING" || targetState === "ANSWERED")) {
      await client.query(
        `UPDATE agents
         SET state = 'DIALING', reservation_id = NULL, reserved_until = NULL,
             state_changed_at = now(), version = version + 1
         WHERE id = $1 AND state IN ('RESERVED', 'DIALING')`,
        [agentId],
      );
    }
    if (agentId !== null && targetState === "CONNECTED") {
      await client.query(
        `UPDATE agents
         SET state = 'CONNECTED', reservation_id = NULL, reserved_until = NULL,
             state_changed_at = now(), version = version + 1
         WHERE id = $1 AND state IN ('RESERVED', 'DIALING', 'CONNECTED')`,
        [agentId],
      );
    }
    if (agentId !== null && targetState === "COMPLETED") {
      await client.query(
        `UPDATE agents
         SET state = 'WRAP_UP', reservation_id = NULL, reserved_until = NULL,
             state_changed_at = now(), version = version + 1
         WHERE id = $1`,
        [agentId],
      );
    }
    if (agentId !== null && (targetState === "FAILED" || targetState === "CANCELLED" || targetState === "ABANDONED")) {
      await client.query(
        `UPDATE agents
         SET state = 'AVAILABLE', reservation_id = NULL, reserved_until = NULL,
             state_changed_at = now(), version = version + 1
         WHERE id = $1 AND state <> 'OFFLINE'`,
        [agentId],
      );
    }

    if (targetState === "COMPLETED") {
      await client.query(
        `UPDATE borrowers
         SET state = 'COMPLETED', reservation_id = NULL, reserved_until = NULL,
             updated_at = now(), version = version + 1
         WHERE id = $1`,
        [call.borrower_id],
      );
    } else if (targetState === "FAILED" || targetState === "CANCELLED" || targetState === "ABANDONED") {
      await client.query(
        `UPDATE borrowers
         SET state = 'READY', reservation_id = NULL, reserved_until = NULL,
             next_attempt_at = now() + interval '5 minutes',
             updated_at = now(), version = version + 1
         WHERE id = $1`,
        [call.borrower_id],
      );
    } else {
      await client.query(
        `UPDATE borrowers
         SET state = 'IN_CALL', reservation_id = NULL, reserved_until = NULL,
             updated_at = now(), version = version + 1
         WHERE id = $1 AND state = 'RESERVED'`,
        [call.borrower_id],
      );
    }
  }

  private async markProcessed(
    client: PoolClient,
    eventRecordId: string,
    result: ProviderEventResult,
  ): Promise<void> {
    await client.query(
      `UPDATE provider_events
       SET processed_at = now(), processing_result = $2
       WHERE id = $1`,
      [eventRecordId, result],
    );
  }
}

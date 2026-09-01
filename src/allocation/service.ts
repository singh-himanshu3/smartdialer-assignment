import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PacingMode } from "../pacing/types.js";
import { withTransaction } from "../persistence/database.js";

interface PermitRow {
  readonly id: string;
  readonly mode: PacingMode;
}

interface IdRow {
  readonly id: string;
}

export interface AllocatedCall {
  readonly callId: string;
  readonly borrowerId: string;
  readonly agentId: string | null;
  readonly permitId: string;
  readonly mode: PacingMode;
  readonly idempotencyKey: string;
}

export type AllocationResult =
  | { readonly allocated: true; readonly call: AllocatedCall }
  | { readonly allocated: false; readonly reason: "PERMIT_UNAVAILABLE" | "NO_AGENT" | "NO_BORROWER" };

export class CallAllocator {
  constructor(
    private readonly pool: Pool,
    private readonly reservationTtlSeconds: number,
  ) {}

  async allocateOne(
    campaignId: string,
    permitId: string,
    provider: string,
  ): Promise<AllocationResult> {
    return withTransaction<AllocationResult>(this.pool, async (client) => {
      const permit = await this.consumePermit(client, campaignId, permitId);
      if (permit === undefined) {
        return { allocated: false, reason: "PERMIT_UNAVAILABLE" } as const;
      }

      const callId = randomUUID();
      const agentId =
        permit.mode === "PROGRESSIVE"
          ? await this.reserveAgent(client, campaignId, callId)
          : null;
      if (permit.mode === "PROGRESSIVE" && agentId === null) {
        throw new AllocationRollback("NO_AGENT");
      }

      const borrowerId = await this.reserveBorrower(client, campaignId, callId);
      if (borrowerId === null) {
        throw new AllocationRollback("NO_BORROWER");
      }

      const idempotencyKey = `${campaignId}:${borrowerId}:${callId}`;
      await client.query(
        `INSERT INTO calls (
           id, campaign_id, borrower_id, agent_id, permit_id, mode,
           provider, idempotency_key, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RESERVED')`,
        [
          callId,
          campaignId,
          borrowerId,
          agentId,
          permit.id,
          permit.mode,
          provider,
          idempotencyKey,
        ],
      );

      await client.query(
        `INSERT INTO outbox (
           id, aggregate_type, aggregate_id, command_type, idempotency_key, payload
         ) VALUES ($1, 'CALL', $2, 'PLACE_CALL', $3, $4::jsonb)`,
        [
          randomUUID(),
          callId,
          idempotencyKey,
          JSON.stringify({ callId, borrowerId, provider }),
        ],
      );

      return {
        allocated: true,
        call: {
          callId,
          borrowerId,
          agentId,
          permitId: permit.id,
          mode: permit.mode,
          idempotencyKey,
        },
      };
    }).catch((error: unknown) => {
      if (error instanceof AllocationRollback) {
        return { allocated: false, reason: error.reason } as const;
      }
      throw error;
    });
  }

  async allocateBatch(
    campaignId: string,
    permitIds: readonly string[],
    provider: string,
  ): Promise<readonly AllocationResult[]> {
    return Promise.all(
      permitIds.map((permitId) => this.allocateOne(campaignId, permitId, provider)),
    );
  }

  private async consumePermit(
    client: PoolClient,
    campaignId: string,
    permitId: string,
  ): Promise<PermitRow | undefined> {
    const result = await client.query<PermitRow>(
      `UPDATE dial_permits
       SET status = 'CONSUMED', consumed_at = now()
       WHERE id = $1
         AND campaign_id = $2
         AND status = 'ISSUED'
         AND expires_at > now()
       RETURNING id, mode`,
      [permitId, campaignId],
    );
    return result.rows[0];
  }

  private async reserveAgent(
    client: PoolClient,
    campaignId: string,
    reservationId: string,
  ): Promise<string | null> {
    const result = await client.query<IdRow>(
      `WITH candidate AS (
         SELECT id
         FROM agents
         WHERE campaign_id = $1 AND state = 'AVAILABLE'
         ORDER BY state_changed_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE agents AS agent
       SET state = 'RESERVED',
           reservation_id = $2,
           reserved_until = now() + ($3 * interval '1 second'),
           state_changed_at = now(),
           version = version + 1
       FROM candidate
       WHERE agent.id = candidate.id
       RETURNING agent.id`,
      [campaignId, reservationId, this.reservationTtlSeconds],
    );
    return result.rows[0]?.id ?? null;
  }

  private async reserveBorrower(
    client: PoolClient,
    campaignId: string,
    reservationId: string,
  ): Promise<string | null> {
    const result = await client.query<IdRow>(
      `WITH candidate AS (
         SELECT id
         FROM borrowers
         WHERE campaign_id = $1
           AND state = 'READY'
           AND next_attempt_at <= now()
         ORDER BY priority DESC, next_attempt_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE borrowers AS borrower
       SET state = 'RESERVED',
           reservation_id = $2,
           reserved_until = now() + ($3 * interval '1 second'),
           updated_at = now(),
           version = version + 1
       FROM candidate
       WHERE borrower.id = candidate.id
       RETURNING borrower.id`,
      [campaignId, reservationId, this.reservationTtlSeconds],
    );
    return result.rows[0]?.id ?? null;
  }
}

class AllocationRollback extends Error {
  constructor(readonly reason: "NO_AGENT" | "NO_BORROWER") {
    super(reason);
  }
}

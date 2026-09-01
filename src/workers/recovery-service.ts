import type { Pool } from "pg";
import { withTransaction } from "../persistence/database.js";

export interface RecoverySummary {
  readonly expiredPermits: number;
  readonly releasedWrapUpAgents: number;
  readonly resetOutboxLeases: number;
  readonly failedCallsReleased: number;
}

interface FailedCallRow {
  readonly id: string;
  readonly agent_id: string | null;
  readonly borrower_id: string;
}

export class RecoveryService {
  constructor(private readonly pool: Pool) {}

  async runOnce(): Promise<RecoverySummary> {
    return withTransaction(this.pool, async (client) => {
      const permits = await client.query(
        `UPDATE dial_permits
         SET status = 'EXPIRED'
         WHERE status = 'ISSUED' AND expires_at <= now()`,
      );
      const agents = await client.query(
        `UPDATE agents
         SET state = 'AVAILABLE', state_changed_at = now(), version = version + 1
         WHERE state = 'WRAP_UP' AND state_changed_at <= now() - interval '5 seconds'`,
      );
      const outbox = await client.query(
        `UPDATE outbox
         SET status = 'PENDING', lease_owner = NULL, lease_until = NULL
         WHERE status = 'PROCESSING' AND lease_until < now()`,
      );
      const failedCalls = await client.query<FailedCallRow>(
        `SELECT call.id, call.agent_id, call.borrower_id
         FROM calls AS call
         JOIN outbox AS command
           ON command.aggregate_type = 'CALL' AND command.aggregate_id = call.id
         WHERE call.state = 'RESERVED'
           AND command.command_type = 'PLACE_CALL'
           AND command.status = 'FAILED'
         FOR UPDATE OF call`,
      );
      if (failedCalls.rows.length > 0) {
        const callIds = failedCalls.rows.map((call) => call.id);
        const agentIds = failedCalls.rows
          .map((call) => call.agent_id)
          .filter((id): id is string => id !== null);
        const borrowerIds = failedCalls.rows.map((call) => call.borrower_id);
        await client.query(
          `UPDATE calls
           SET state = 'FAILED', completed_at = now(), updated_at = now(), version = version + 1
           WHERE id = ANY($1::uuid[])`,
          [callIds],
        );
        if (agentIds.length > 0) {
          await client.query(
            `UPDATE agents
             SET state = 'AVAILABLE', reservation_id = NULL, reserved_until = NULL,
                 state_changed_at = now(), version = version + 1
             WHERE id = ANY($1::uuid[]) AND state <> 'OFFLINE'`,
            [agentIds],
          );
        }
        await client.query(
          `UPDATE borrowers
           SET state = 'READY', reservation_id = NULL, reserved_until = NULL,
               next_attempt_at = now() + interval '5 minutes',
               updated_at = now(), version = version + 1
           WHERE id = ANY($1::uuid[])`,
          [borrowerIds],
        );
      }
      return {
        expiredPermits: permits.rowCount ?? 0,
        releasedWrapUpAgents: agents.rowCount ?? 0,
        resetOutboxLeases: outbox.rowCount ?? 0,
        failedCallsReleased: failedCalls.rows.length,
      };
    });
  }
}

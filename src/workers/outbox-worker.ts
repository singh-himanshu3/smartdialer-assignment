import type { Pool } from "pg";
import { withTransaction } from "../persistence/database.js";
import type { ProviderRegistry } from "../providers/registry.js";

interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly command_type: "PLACE_CALL" | "CANCEL_CALL";
  readonly idempotency_key: string;
  readonly attempts: number;
}

interface CallCommandRow {
  readonly id: string;
  readonly state: string;
  readonly provider: string;
  readonly external_call_id: string | null;
  readonly phone_number: string;
}

export class OutboxWorker {
  constructor(
    private readonly pool: Pool,
    private readonly providers: ProviderRegistry,
    private readonly workerId: string,
    private readonly leaseSeconds = 15,
    private readonly maximumAttempts = 10,
  ) {}

  async runOnce(): Promise<boolean> {
    const command = await this.claimOne();
    if (command === undefined) return false;

    try {
      if (command.command_type === "PLACE_CALL") {
        await this.placeCall(command);
      } else {
        await this.cancelCall(command);
      }
      return true;
    } catch (error) {
      await this.reschedule(command, error);
      return true;
    }
  }

  private async claimOne(): Promise<OutboxRow | undefined> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<OutboxRow>(
        `WITH candidate AS (
           SELECT id
           FROM outbox
           WHERE (
               status = 'PENDING' AND available_at <= now()
             ) OR (
               status = 'PROCESSING' AND lease_until < now()
             )
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE outbox AS command
         SET status = 'PROCESSING',
             lease_owner = $1,
             lease_until = now() + ($2 * interval '1 second')
         FROM candidate
         WHERE command.id = candidate.id
         RETURNING command.id, command.aggregate_id, command.command_type,
                   command.idempotency_key, command.attempts`,
        [this.workerId, this.leaseSeconds],
      );
      return result.rows[0];
    });
  }

  private async placeCall(command: OutboxRow): Promise<void> {
    const callResult = await this.pool.query<CallCommandRow>(
      `SELECT call.id, call.state, call.provider, call.external_call_id, borrower.phone_number
       FROM calls AS call
       JOIN borrowers AS borrower ON borrower.id = call.borrower_id
       WHERE call.id = $1`,
      [command.aggregate_id],
    );
    const call = callResult.rows[0];
    if (call === undefined) {
      throw new Error(`Outbox references missing call ${command.aggregate_id}`);
    }
    if (isTerminal(call.state)) {
      await this.complete(command.id);
      return;
    }

    const provider = this.providers.get(call.provider);
    const placed = await provider.placeCall({
      callId: call.id,
      phoneNumber: call.phone_number,
      idempotencyKey: command.idempotency_key,
    });

    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE calls
         SET external_call_id = COALESCE(external_call_id, $2),
             state = CASE WHEN state = 'RESERVED' THEN 'INITIATED' ELSE state END,
             initiated_at = COALESCE(initiated_at, $3),
             updated_at = now(),
             version = version + 1
         WHERE id = $1`,
        [call.id, placed.externalCallId, placed.acceptedAt],
      );
      await client.query(
        `UPDATE agents
         SET state = 'DIALING', reservation_id = NULL, reserved_until = NULL,
             state_changed_at = now(), version = version + 1
         WHERE reservation_id = $1 AND state = 'RESERVED'`,
        [call.id],
      );
      await client.query(
        `UPDATE borrowers
         SET state = 'IN_CALL', reservation_id = NULL, reserved_until = NULL,
             attempt_count = attempt_count + 1, updated_at = now(), version = version + 1
         WHERE reservation_id = $1 AND state = 'RESERVED'`,
        [call.id],
      );
      await client.query(
        `UPDATE outbox
         SET status = 'COMPLETED', completed_at = now(), lease_owner = NULL, lease_until = NULL
         WHERE id = $1`,
        [command.id],
      );
      await this.persistHealth(client, provider.name, provider.health());
    });
  }

  private async cancelCall(command: OutboxRow): Promise<void> {
    const result = await this.pool.query<CallCommandRow>(
      `SELECT call.id, call.state, call.provider, call.external_call_id, borrower.phone_number
       FROM calls AS call
       JOIN borrowers AS borrower ON borrower.id = call.borrower_id
       WHERE call.id = $1`,
      [command.aggregate_id],
    );
    const call = result.rows[0];
    if (call?.external_call_id !== null && call?.external_call_id !== undefined) {
      const provider = this.providers.get(call.provider);
      await provider.cancelCall(call.external_call_id, command.idempotency_key);
    }
    await this.complete(command.id);
  }

  private async complete(commandId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox
       SET status = 'COMPLETED', completed_at = now(), lease_owner = NULL, lease_until = NULL
       WHERE id = $1`,
      [commandId],
    );
  }

  private async reschedule(command: OutboxRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const nextAttempt = command.attempts + 1;
    const delaySeconds = Math.min(60, 2 ** Math.min(nextAttempt, 6));
    await this.pool.query(
      `UPDATE outbox
       SET status = CASE WHEN $2::integer >= $3::integer THEN 'FAILED' ELSE 'PENDING' END,
           attempts = $2::integer,
           available_at = now() + ($4::integer * interval '1 second'),
           lease_owner = NULL,
           lease_until = NULL,
           last_error = $5
       WHERE id = $1`,
      [command.id, nextAttempt, this.maximumAttempts, delaySeconds, message.slice(0, 2_000)],
    );
  }

  private async persistHealth(
    client: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
    provider: string,
    health: { healthy: boolean; errorRate: number; p95LatencyMs: number; consecutiveFailures: number },
  ): Promise<void> {
    await client.query(
      `INSERT INTO provider_health (
         provider, healthy, error_rate, p95_latency_ms, consecutive_failures, updated_at
       ) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (provider) DO UPDATE SET
         healthy = EXCLUDED.healthy,
         error_rate = EXCLUDED.error_rate,
         p95_latency_ms = EXCLUDED.p95_latency_ms,
         consecutive_failures = EXCLUDED.consecutive_failures,
         updated_at = now()`,
      [
        provider,
        health.healthy,
        health.errorRate,
        health.p95LatencyMs,
        health.consecutiveFailures,
      ],
    );
  }
}

function isTerminal(state: string): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED" || state === "ABANDONED";
}

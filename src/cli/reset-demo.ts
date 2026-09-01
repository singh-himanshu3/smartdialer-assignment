import { loadConfig } from "../config.js";
import { createPool, withTransaction } from "../persistence/database.js";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";

if (!process.argv.slice(2).includes("--yes")) {
  throw new Error(
    "This replaces only the fixed demo campaign and its history. Re-run with: pnpm db:reset-demo -- --yes",
  );
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await withTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM outbox
       WHERE aggregate_type = 'call'
         AND aggregate_id IN (SELECT id FROM calls WHERE campaign_id = $1)`,
      [CAMPAIGN_ID],
    );
    await client.query(`DELETE FROM agents WHERE campaign_id = $1`, [CAMPAIGN_ID]);
    await client.query(`DELETE FROM campaigns WHERE id = $1`, [CAMPAIGN_ID]);

    await client.query(
      `INSERT INTO campaigns (id, name, status, pacing_mode, provider)
       VALUES ($1, 'Demo campaign', 'ACTIVE', 'PROGRESSIVE', 'provider-a')`,
      [CAMPAIGN_ID],
    );
    await client.query(
      `INSERT INTO agents (id, campaign_id, display_name, state)
       SELECT md5('agent-' || number::text)::uuid, $1, 'Agent ' || number, 'AVAILABLE'
       FROM generate_series(1, 20) AS number`,
      [CAMPAIGN_ID],
    );
    await client.query(
      `INSERT INTO borrowers (id, campaign_id, phone_number, priority)
       SELECT
         md5('borrower-' || number::text)::uuid,
         $1,
         '+1555' || lpad(number::text, 7, '0'),
         1000 - number
       FROM generate_series(1, 200) AS number`,
      [CAMPAIGN_ID],
    );
    await client.query(
      `UPDATE provider_health
       SET healthy = true,
           error_rate = 0,
           p95_latency_ms = 0,
           consecutive_failures = 0,
           updated_at = now()
       WHERE provider IN ('provider-a', 'provider-b')`,
    );
  });

  process.stdout.write(`Reset demo campaign ${CAMPAIGN_ID}\n`);
} finally {
  await pool.end();
}

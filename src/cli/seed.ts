import { loadConfig } from "../config.js";
import { createPool, withTransaction } from "../persistence/database.js";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO campaigns (id, name, status, pacing_mode, provider)
       VALUES ($1, 'Demo campaign', 'ACTIVE', 'PROGRESSIVE', 'provider-a')
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [CAMPAIGN_ID],
    );

    await client.query(
      `INSERT INTO agents (id, campaign_id, display_name, state)
       SELECT md5('agent-' || number::text)::uuid, $1, 'Agent ' || number, 'AVAILABLE'
       FROM generate_series(1, 20) AS number
       ON CONFLICT (id) DO NOTHING`,
      [CAMPAIGN_ID],
    );

    await client.query(
      `INSERT INTO borrowers (id, campaign_id, phone_number, priority)
       SELECT
         md5('borrower-' || number::text)::uuid,
         $1,
         '+1555' || lpad(number::text, 7, '0'),
         1000 - number
       FROM generate_series(1, 200) AS number
       ON CONFLICT (campaign_id, phone_number) DO NOTHING`,
      [CAMPAIGN_ID],
    );
  });

  process.stdout.write(`Seeded campaign ${CAMPAIGN_ID}\n`);
} finally {
  await pool.end();
}

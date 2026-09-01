import type { Pool } from "pg";

export class CampaignTickLock {
  constructor(private readonly pool: Pool) {}

  async runExclusive<T>(campaignId: string, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext('smartdialer-campaign'), hashtext($1))",
        [campaignId],
      );
      return await work();
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('smartdialer-campaign'), hashtext($1))",
        [campaignId],
      );
      client.release();
    }
  }
}

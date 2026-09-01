import type { Pool } from "pg";
import type { CampaignTickResult, CampaignRunner } from "./runner.js";

interface CampaignIdRow {
  readonly id: string;
}

export interface CampaignScheduleResult {
  readonly completed: readonly CampaignTickResult[];
  readonly failures: readonly { campaignId: string; error: string }[];
}

export class CampaignScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly runner: CampaignRunner,
  ) {}

  async runOnce(): Promise<CampaignScheduleResult> {
    const campaigns = await this.pool.query<CampaignIdRow>(
      `SELECT campaign.id
       FROM campaigns AS campaign
       WHERE campaign.status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM borrowers
           WHERE borrowers.campaign_id = campaign.id
             AND borrowers.state = 'READY'
             AND borrowers.next_attempt_at <= now()
         )
         AND EXISTS (
           SELECT 1 FROM agents
           WHERE agents.campaign_id = campaign.id
             AND agents.state IN ('AVAILABLE', 'WRAP_UP')
         )
       ORDER BY campaign.id`,
    );
    const completed: CampaignTickResult[] = [];
    const failures: { campaignId: string; error: string }[] = [];

    await Promise.all(
      campaigns.rows.map(async ({ id }) => {
        try {
          completed.push(await this.runner.tick(id));
        } catch (error) {
          failures.push({
            campaignId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    return { completed, failures };
  }
}

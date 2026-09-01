import type { Pool } from "pg";
import type { PacingMode } from "../pacing/types.js";

export type CampaignStatus = "ACTIVE" | "PAUSED" | "COMPLETED";

export interface CampaignUpdate {
  readonly status?: CampaignStatus;
  readonly pacingMode?: PacingMode;
  readonly provider?: string;
}

interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly pacing_mode: PacingMode;
  readonly provider: string;
}

export class CampaignAdminService {
  constructor(private readonly pool: Pool) {}

  async update(campaignId: string, update: CampaignUpdate): Promise<CampaignRow> {
    if (update.provider !== undefined) {
      const provider = await this.pool.query(
        "SELECT 1 FROM provider_health WHERE provider = $1",
        [update.provider],
      );
      if (provider.rowCount === 0) throw new Error(`Unknown provider: ${update.provider}`);
    }
    const result = await this.pool.query<CampaignRow>(
      `UPDATE campaigns
       SET status = COALESCE($2, status),
           pacing_mode = COALESCE($3, pacing_mode),
           provider = COALESCE($4, provider),
           updated_at = now()
       WHERE id = $1
       RETURNING id, name, status, pacing_mode, provider`,
      [campaignId, update.status ?? null, update.pacingMode ?? null, update.provider ?? null],
    );
    const campaign = result.rows[0];
    if (campaign === undefined) throw new Error(`Campaign ${campaignId} was not found.`);
    return campaign;
  }
}

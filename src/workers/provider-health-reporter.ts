import type { Pool } from "pg";
import type { ProviderRegistry } from "../providers/registry.js";

export class ProviderHealthReporter {
  constructor(
    private readonly pool: Pool,
    private readonly providers: ProviderRegistry,
  ) {}

  async report(): Promise<void> {
    for (const provider of this.providers.all()) {
      const health = provider.health();
      await this.pool.query(
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
          provider.name,
          health.healthy,
          health.errorRate,
          health.p95LatencyMs,
          health.consecutiveFailures,
        ],
      );
    }
  }
}

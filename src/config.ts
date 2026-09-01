import "dotenv/config";

export interface AppConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly workerPollMs: number;
  readonly reservationTtlSeconds: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databaseUrl:
      environment.DATABASE_URL ??
      "postgres://smartdialer:smartdialer@localhost:5433/smartdialer",
    port: positiveInteger(environment.PORT, 3000),
    workerPollMs: positiveInteger(environment.WORKER_POLL_MS, 250),
    reservationTtlSeconds: positiveInteger(environment.RESERVATION_TTL_SECONDS, 30),
  };
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer but received: ${raw}`);
  }
  return value;
}

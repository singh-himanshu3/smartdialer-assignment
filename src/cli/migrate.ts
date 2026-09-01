import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { createPool } from "../persistence/database.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationDirectory = resolve(process.cwd(), "migrations");
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of filenames) {
    const alreadyApplied = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = $1) AS exists",
      [filename],
    );
    if (alreadyApplied.rows[0]?.exists === true) continue;

    const client = await pool.connect();
    try {
      const sql = await readFile(resolve(migrationDirectory, filename), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${filename}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}

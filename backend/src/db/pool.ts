import pg from "pg";
import type { AppConfig } from "../config.js";

let pool: pg.Pool | null = null;

export function getPool(config: AppConfig): pg.Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  }
  return pool;
}

export async function withUserContext<T>(
  client: pg.PoolClient,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
  return fn();
}

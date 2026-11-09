import { Pool, type PoolClient } from "pg";

/** A request is waiting on the API, and one slow query must not hold a connection for everyone else. */
export const API_STATEMENT_TIMEOUT_MS = 15_000;
/** Nobody is waiting on the worker, and its nightly deletes can be large. This only stops a query that has truly stuck. */
export const WORKER_STATEMENT_TIMEOUT_MS = 5 * 60_000;
/** Postgres ended the query because it ran past its time limit. */
export const QUERY_CANCELED = "57014";

/** Migrations, key rotation and tests pass no limit, because their work can rightly take as long as it takes. */
export function createPool(connectionString: string, max = 10, statementTimeoutMs?: number): Pool {
  const pool = new Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ...(statementTimeoutMs ? { statement_timeout: statementTimeoutMs } : {}) });
  // An idle connection can drop at any time; that must not stop the process.
  pool.on("error", (error) => console.error(JSON.stringify({ level: "error", event: "db_pool_error", message: error.message })));
  return pool;
}

/**
 * Runs `work` in one transaction scoped to a workspace.
 * Row-level security reads this setting, so the database itself keeps workspaces apart.
 */
export async function inWorkspace<T>(pool: Pool, workspaceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

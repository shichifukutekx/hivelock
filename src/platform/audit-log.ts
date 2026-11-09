import type { Pool, PoolClient } from "pg";

/** Walking a chain rehashes every entry, so it alone may run past the API's limit on queries. The page asks for this once. */
const CHAIN_CHECK_TIMEOUT_MS = 2 * 60_000;

export interface AuditEntry {
  workspaceId?: string;
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

/** The database links each entry to the one before it, and refuses to change or remove entries. */
export async function recordAudit(db: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_events (workspace_id, actor_id, action, target_type, target_id, details, ip)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.workspaceId ?? null, entry.actorId ?? null, entry.action, entry.targetType ?? null, entry.targetId ?? null, JSON.stringify(entry.details ?? {}), entry.ip ?? null],
  );
}

/** True when no entry in a chain was changed. A null workspace is the server's own chain. */
export async function chainIntact(pool: Pool, workspaceId: string | null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${CHAIN_CHECK_TIMEOUT_MS}`);
    const { rows: [check] } = await client.query<{ broken: string | null }>("select audit_chain_break($1) as broken", [workspaceId]);
    await client.query("commit");
    return check!.broken === null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

import type { Pool } from "pg";
import { inWorkspace } from "./db.ts";
import { extensions } from "./extensions.ts";
import { STUCK_INDEXING_HOURS } from "./knowledge.ts";

/** How many saves of a workflow are kept. The Builder's History panel states this. */
export const KEEP_VERSIONS = 100;

/** Removes old runs under each workspace's own retention setting. The audit log is never touched. */
export async function runMaintenance(pool: Pool) {
  const { rows } = await pool.query<{ id: string }>("select id from organization");
  let removed = 0;
  for (const { id } of rows) {
    removed += await inWorkspace(pool, id, async (db) => {
      const { rows: [settings] } = await db.query("select run_retention_days from workspace_settings where workspace_id = $1", [id]);
      const { rowCount } = await db.query(
        "delete from runs where finished_at is not null and finished_at < now() - make_interval(days => $1)",
        [settings?.run_retention_days ?? 90],
      );
      await db.query("delete from spans where at < now() - make_interval(days => $1)", [settings?.run_retention_days ?? 90]);
      // A run keeps its own copy of the definition, so pruning never changes what a run does.
      await db.query(
        `delete from workflow_versions v using workflows w
         where w.id = v.workflow_id and v.version <= w.version - $1
           and not exists (select 1 from runs r where r.workflow_id = v.workflow_id and r.workflow_version = v.version and r.status in ('running', 'waiting'))`,
        [KEEP_VERSIONS],
      );
      // A worker that died mid-file leaves it indexing for ever. Saying so lets a person upload it again.
      await db.query(
        `update knowledge_documents set status = 'failed', error = 'Indexing did not finish. Upload the file again.', updated_at = clock_timestamp()
         where status = 'indexing' and updated_at < now() - make_interval(hours => $1)`,
        [STUCK_INDEXING_HOURS],
      );
      for (const { maintainWorkspace } of extensions()) await maintainWorkspace?.(db, id);
      return rowCount ?? 0;
    });
  }
  // Longer than the longest window, which is a day. Removing a row early would restart its count.
  await pool.query("delete from rate_limits where window_start < now() - interval '2 days'");
  for (const { maintainServer } of extensions()) await maintainServer?.(pool);
  return removed;
}

import type { Pool } from "pg";
import { inWorkspace } from "../db.ts";
import { seal, unseal } from "../secrets.ts";
import { NotStarted, PermanentError } from "./types.ts";
import { BlockedAddress } from "../net/safe-fetch.ts";

interface Effect {
  pool: Pool;
  workspaceId: string;
  runId: string;
  nodeId: string;
  masterKey: string;
}

/**
 * Runs something that changes the outside world at most once for a step.
 * The claim is saved first, so a crash leaves it behind. A retry then refuses to act,
 * because it cannot know if the first attempt got through.
 */
export async function onlyOnce<T>({ pool, workspaceId, runId, nodeId, masterKey }: Effect, action: () => Promise<T>): Promise<T> {
  const previous = await inWorkspace(pool, workspaceId, async (db) => {
    const { rowCount } = await db.query(
      "insert into run_effects (workspace_id, run_id, node_id, status) values ($1, $2, $3, 'started') on conflict do nothing",
      [workspaceId, runId, nodeId],
    );
    if (rowCount) return undefined;
    return (await db.query("select status, result from run_effects where run_id = $1 and node_id = $2", [runId, nodeId])).rows[0];
  });
  if (previous?.status === "done") return unseal(masterKey, workspaceId, previous.result) as T;
  if (previous) throw new PermanentError("This action may already have happened, so it was not repeated. Check the other system.");

  try {
    const result = await action();
    await inWorkspace(pool, workspaceId, (db) => db.query(
      "update run_effects set status = 'done', result = $3 where run_id = $1 and node_id = $2",
      [runId, nodeId, JSON.stringify(seal(masterKey, workspaceId, result ?? null))],
    ));
    return result;
  } catch (error) {
    if (error instanceof NotStarted || (error instanceof BlockedAddress && !error.afterSend)) {
      await inWorkspace(pool, workspaceId, (db) => db.query("delete from run_effects where run_id = $1 and node_id = $2", [runId, nodeId]));
      throw error;
    }
    if (error instanceof PermanentError) throw error;
    // Stops here with the real reason, instead of a retry that could only refuse.
    throw new PermanentError(`${(error as Error).message}. This action may have happened, so it was not repeated. Check the other system.`);
  }
}

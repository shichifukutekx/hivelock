import type { Pool } from "pg";
import { PermanentError } from "./connectors/types.ts";
import { inWorkspace } from "./db.ts";

export const recordTokens = (pool: Pool, workspaceId: string, tokens: number) => inWorkspace(pool, workspaceId, (client) => client.query(
  `insert into workspace_usage (workspace_id, month, tokens) values ($1, date_trunc('month', now()), $2)
   on conflict (workspace_id, month) do update set tokens = workspace_usage.tokens + excluded.tokens`,
  [workspaceId, tokens],
));

/** Stops new model work once a workspace has used its monthly allowance. */
export const assertWithinBudget = (pool: Pool, workspaceId: string) => inWorkspace(pool, workspaceId, async (client) => {
  const { rows: [row] } = await client.query(
    `select coalesce((select monthly_token_limit from workspace_settings where workspace_id = $1), 5000000) as limit,
            coalesce((select tokens from workspace_usage where workspace_id = $1 and month = date_trunc('month', now())), 0) as used`,
    [workspaceId],
  );
  if (Number(row.used) >= Number(row.limit)) throw new PermanentError("This workspace has used its monthly token allowance.");
});

export const isConfidential = (pool: Pool, workspaceId: string) => inWorkspace(pool, workspaceId, async (client) =>
  (await client.query("select confidential_mode from workspace_settings where workspace_id = $1", [workspaceId])).rows[0]?.confidential_mode ?? true);

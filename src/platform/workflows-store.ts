import type { PoolClient } from "pg";
import { recordAudit } from "./audit-log.ts";
import { parseDefinition, type WorkflowDefinition } from "./engine/definition.ts";
import { assertWorkflowRoom } from "./limits.ts";

/** The whole check on a workflow before it is saved. */
export async function checkSteps(raw: unknown, agentExists: (name: string) => Promise<boolean> | boolean) {
  const definition = parseDefinition(raw);
  for (const node of definition.nodes) {
    if (node.type === "agent" && !(await agentExists(String(node.config.agent)))) {
      throw new Error(`Step ${node.id} uses an agent that does not exist: ${node.config.agent}.`);
    }
  }
  return definition;
}

/** Saves a new workflow and its first numbered copy. New workflows are drafts until a person turns them on. */
export async function insertWorkflow(db: PoolClient, workspaceId: string, actorId: string, saved: {
  name: string; description: string; definition: WorkflowDefinition; note: string;
}) {
  await assertWorkflowRoom(db, workspaceId);
  const { rows: [row] } = await db.query(
    "insert into workflows (workspace_id, name, description, definition, created_by) values ($1, $2, $3, $4, $5) returning id",
    [workspaceId, saved.name, saved.description, JSON.stringify(saved.definition), actorId],
  );
  await db.query(
    `insert into workflow_versions (workspace_id, workflow_id, version, name, description, definition, note, saved_by) values ($1, $2, 1, $3, $4, $5, $6, $7)`,
    [workspaceId, row.id, saved.name, saved.description, JSON.stringify(saved.definition), saved.note, actorId],
  );
  await recordAudit(db, { workspaceId, actorId, action: "workflow.created", targetType: "workflow", targetId: row.id });
  return row.id as string;
}

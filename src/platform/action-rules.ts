import type { PoolClient } from "pg";

/**
 * An admin's rule for one action on one connection. With no rule an action follows its own nature:
 * reading runs, anything that may change data asks a person. A rule can only make that stricter, never looser,
 * so no setting here lets a change happen without a person.
 */
export type ActionRule = "ask" | "block";

export const BLOCKED_MESSAGE = "An admin turned this action off for this connection, in Connections.";

export async function actionRules(db: PoolClient, connectionIds: string[]) {
  const rules = new Map<string, ActionRule>();
  if (!connectionIds.length) return rules;
  const { rows } = await db.query("select connection_id, action, rule from action_rules where connection_id = any($1)", [connectionIds]);
  for (const row of rows) rules.set(`${row.connection_id}:${row.action}`, row.rule);
  return rules;
}

export const ruleFor = (rules: Map<string, ActionRule>, connectionId: string, action: string) => rules.get(`${connectionId}:${action}`);

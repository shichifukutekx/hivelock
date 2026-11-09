import "../connectors/index.ts";
import { getConnector } from "../connectors/types.ts";
import type { Blueprint, BlueprintStep, Template } from "./types.ts";

export const START = "start";
/** Fields that say where something goes. Text a model wrote must never fill these. */
export const RECIPIENT_FIELDS = new Set(["to", "cc", "channel", "channelId", "chatId", "project", "owner", "repo", "pageId", "parentId", "baseId", "table", "spreadsheetId", "range", "issueKey", "ticketId", "number", "issue", "teamId", "issueId", "id", "orderId", "objectType", "object", "path", "key", "name", "folderId", "siteId"]);

export type ConnectorStep = Extract<BlueprintStep, { type: "connector" }>;

const slotOf = (template: Template, key: string) => template.connections.find((item) => item.key === key);

/** The connector action behind a step or tool. Undefined if a template names one that does not exist. */
export function actionOf(template: Template, key: string, action: string) {
  const found = slotOf(template, key);
  return found && getConnector(found.connector)?.actions[action];
}

/** True if the step changes something outside the platform. An action that cannot be judged counts as changing. */
export function stepChanges(template: Template, step: ConnectorStep) {
  const definition = actionOf(template, step.slot, step.action);
  if (!definition) return true;
  if (typeof definition.changesData !== "function") return definition.changesData;
  const parsed = definition.params.safeParse(step.params);
  return !parsed.success || definition.changesData(parsed.data);
}

/** True if an agent's tool can change something. "Depends" counts, because the model picks the arguments. */
export function toolChanges(template: Template, key: string, action: string) {
  const definition = actionOf(template, key, action);
  return !definition || definition.changesData !== false;
}

/**
 * Steps a run can reach without a person approving anything first.
 * Edges out of an approval are removed, except a declined edge, which the engine follows without any approval.
 * Steps reachable in what is left are unguarded. This matches the engine, where any one active path starts a step.
 */
export function unguardedSteps({ steps, edges }: Blueprint) {
  const types = new Map(steps.map((step) => [step.id, step.type]));
  const reached = new Set([START]);
  const waiting = [START];
  while (waiting.length) {
    const from = waiting.pop()!;
    for (const edge of edges.filter((item) => item.from === from)) {
      if (types.get(from) === "approval" && edge.when !== "declined") continue;
      if (!reached.has(edge.to)) {
        reached.add(edge.to);
        waiting.push(edge.to);
      }
    }
  }
  return reached;
}

/** The approvals that come before a step on some path. */
export function approvalsBefore({ steps, edges }: Blueprint, id: string) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const waiting = [id];
  const found: Extract<BlueprintStep, { type: "approval" }>[] = [];
  while (waiting.length) {
    const current = waiting.pop();
    for (const edge of edges.filter((item) => item.to === current)) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      waiting.push(edge.from);
      const step = byId.get(edge.from);
      if (step?.type === "approval") found.push(step);
    }
  }
  return found;
}

/** Every outside change a template can make, and what holds it back. Shown to people before they install. */
export function outsideChanges(template: Template) {
  const list: { connector: string; action: string; label: string; guard: string; stepId?: string }[] = [];
  for (const [key, action] of template.agent?.tools ?? []) {
    if (!toolChanges(template, key, action)) continue;
    list.push({ connector: slotOf(template, key)?.connector ?? "", action, label: actionOf(template, key, action)?.label ?? action, guard: "The agent asks a person every time." });
  }
  if (template.agent?.files?.includes("save_file")) list.push({ connector: "files", action: "save_file", label: "Save a new file", guard: "The agent asks a person every time." });
  for (const step of template.workflow?.steps ?? []) {
    if (step.type !== "connector" || !stepChanges(template, step)) continue;
    const approvals = approvalsBefore(template.workflow!, step.id);
    list.push({
      connector: slotOf(template, step.slot)?.connector ?? "", action: step.action, label: step.label, stepId: step.id,
      guard: `Waits for a person at "${approvals.map((item) => item.label).join('", "')}".`,
    });
  }
  return list;
}

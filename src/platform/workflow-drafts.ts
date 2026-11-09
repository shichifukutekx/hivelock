import type { Pool } from "pg";
import { buildAgent } from "../agents/registry.ts";
import { askModel } from "../runtime.ts";
import { capabilities } from "./agent-drafts.ts";
import { agentLooks } from "./agent-looks.ts";
import { workspaceDirectory } from "./agents-store.ts";
import { parseDefinition, type WorkflowDefinition } from "./engine/definition.ts";
import { workspaceModels } from "./model-providers.ts";
import { assertWithinBudget, isConfidential, recordTokens } from "./usage.ts";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { getConnector } from "./connectors/index.ts";

const SYSTEM = `You design workflows for a business automation platform, from a plain description. People using it do not write code or SQL.
Reply with one JSON object and nothing else:
{
  "name": "short name in plain words",
  "description": "one sentence: what a person gets",
  "agent": {"use": "name of an existing agent"} or {"new": {"name": "lowercase-words-with-hyphens", "title": "Plain title", "description": "one sentence", "model": "main or fast", "instructions": "...", "connections": [{"connectionId": "...", "action": "..."}], "knowledge": false}},
  "steps": [
    {"type": "agent", "label": "short label", "prompt": "what the agent does in this step"},
    {"type": "approval", "label": "short label", "message": "what the approver is asked"},
    {"type": "connector", "label": "short label", "connectionId": "...", "action": "...", "params": {}}
  ],
  "inputs": [{"key": "lowercase_key", "label": "What a person types when they start it"}],
  "schedule": {"cron": "five-field cron", "note": "Weekdays at 08:00"} or null
}

Rules:
- Reading data is always an agent step. The agent has a read tool on the connection and writes its own query, so never put SQL or a query in a connector step, and never ask the person for one. Say in the prompt what data to find, in business words.
- Reuse an existing agent when its job and connections fit; say "use". Otherwise design a "new" one with only the connections and actions the job needs, read actions only. Its instructions say what to look for, how to present it (a short summary, then a table), and to say so plainly when data is missing.
- Use connector steps only to send or change something, such as sending an email or posting a message, with actions from the list you are given. Put an approval step directly before each one.
- In prompts, messages and params, refer to an earlier step's result as {{steps.ID.output}}, where ID is that step's position: s1 for the first step, s2 for the second, and so on. Refer to a typed input as {{input.KEY}}.
- If the person did not give an email address or channel, write [[recipient]] where it goes. Do not invent one.
- Add "inputs" only if the work needs something typed each time, such as an order number. Add a schedule only if the description asks for a time or a frequency.
- Keep it short: most workflows need two to four steps.`;

export interface WorkflowDraft {
  name: string;
  description: string;
  agent: { existing: { name: string; title: string } } | { created: Record<string, unknown> & { name: string; title?: string } };
  definition: WorkflowDefinition;
  inputs: { key: string; label: string }[];
  schedule?: { cron: string; note: string };
  /** Words the person still has to fill in, such as who receives the email. */
  blanks: string[];
}

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
const slug = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Turns a plain description into a workflow and, when none fits, a new agent for it, for a person to review.
 * Nothing is saved here. Whatever the model proposes is checked against what really exists in the workspace.
 */
export async function draftWorkflow(pool: Pool, workspaceId: string, actorId: string, description: string, masterKey: string): Promise<WorkflowDraft> {
  await assertWithinBudget(pool, workspaceId);
  const available = await capabilities(pool, workspaceId);
  const agents = (await workspaceDirectory(pool, workspaceId, actorId).list()).filter((agent) => !agent.tools.includes("create_agent") && agent.name !== "orchestrator");
  const known = agents.map((agent) => ({
    name: agent.name, title: agentLooks(agent).title, description: agent.description,
    reads: (agent.connections ?? []).map((link) => `${available.connections.find((c) => c.connectionId === link.connectionId)?.name ?? "a connection"}: ${link.action}`),
    documents: !!agent.knowledge,
  }));
  // For actions that send or change something, the draft must fill in their settings, so it is told their names.
  const listed = available.connections.map((connection) => ({
    ...connection,
    actions: connection.actions.map((item) => {
      if (!item.changesData) return item;
      const schema = getConnector(connection.connector)?.actions[item.action]?.params;
      const fields = schema ? Object.keys((z.toJSONSchema(schema, { unrepresentable: "any" }) as { properties?: object }).properties ?? {}) : [];
      return { ...item, fields };
    }),
  }));
  const prompt = `Connections in this workspace and their actions:\n${JSON.stringify(listed)}\n\nExisting agents:\n${JSON.stringify(known)}\n\nThe workflow to design:\n${description}`;
  const { text: reply, tokens } = await askModel("main", SYSTEM, prompt, { confidential: await isConfidential(pool, workspaceId) }, workspaceModels(pool, workspaceId, masterKey));
  if (tokens) await recordTokens(pool, workspaceId, tokens);
  let raw: any;
  try {
    raw = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
  } catch {
    throw new Error("The draft did not come out right. Try again, or describe the workflow in other words.");
  }
  return checkDraft(raw, available, agents.map((agent) => ({ name: agent.name, title: agentLooks(agent).title })));
}

type Available = Awaited<ReturnType<typeof capabilities>>;

/** The checks on a model's proposal. Separate from the model call, so they can be tested on their own. */
export function checkDraft(raw: any, available: Available, agents: { name: string; title: string }[]): WorkflowDraft {
  const action = (connectionId: unknown, name: unknown) => available.connections.find((c) => c.connectionId === connectionId)?.actions.find((a) => a.action === name);

  let agent: WorkflowDraft["agent"];
  const used = agents.find((item) => item.name === raw?.agent?.use);
  if (used) agent = { existing: used };
  else {
    const proposed = raw?.agent?.new ?? {};
    // A new agent only reads. Sending and changing happen in their own steps, behind an approval.
    const connections = (Array.isArray(proposed.connections) ? proposed.connections : []).filter((link: any) => {
      const found = action(link?.connectionId, link?.action);
      return found && !found.changesData;
    }).map((link: any) => ({ connectionId: link.connectionId, action: link.action }));
    let name = slug(proposed.name) || "workflow-helper";
    if (!/^[a-z]/.test(name) || name.length < 3) name = `agent-${name}`.slice(0, 40);
    while (agents.some((item) => item.name === name)) name = `${name.slice(0, 36)}-${Math.floor(Math.random() * 900 + 100)}`;
    const spec = {
      name, title: text(proposed.title, 80) || undefined, description: text(proposed.description, 300) || "Does one step of a workflow.",
      model: proposed.model === "fast" ? "fast" : "main", instructions: text(proposed.instructions, 8_000) || "Do the task you are given and present the result clearly.",
      connections, knowledge: proposed.knowledge === true,
    };
    buildAgent(spec);
    agent = { created: spec };
  }
  const agentName = "existing" in agent ? agent.existing.name : agent.created.name;

  const steps: any[] = (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, 12);
  if (!steps.length) throw new Error("The draft had no steps. Describe what should happen in a sentence or two more.");
  const nodes: WorkflowDefinition["nodes"] = [{ id: "start", type: "start", label: "Start", config: {} }];
  steps.forEach((step, index) => {
    const id = `s${index + 1}`;
    const label = text(step?.label, 120);
    if (step?.type === "approval") nodes.push({ id, type: "approval", label: label || "A person checks it", config: { message: text(step.message, 2_000) || `Approve this?\n\n{{steps.s${index}.output}}` } });
    else if (step?.type === "connector" && action(step.connectionId, step.action)) {
      nodes.push({ id, type: "connector", label: label || "Send it", config: { connectionId: step.connectionId, action: step.action, params: step.params && typeof step.params === "object" ? step.params : {} } });
    } else nodes.push({ id, type: "agent", label: label || "Do the work", config: { agent: agentName, prompt: text(step?.prompt, 20_000) || "Do the task." } });
  });
  // Anything that sends or changes data waits for a person first, even if the draft forgot to say so.
  for (let index = 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.type !== "connector" || !action(node.config.connectionId, node.config.action)?.changesData) continue;
    if (nodes[index - 1]!.type === "approval") continue;
    const before = [...nodes.slice(1, index)].reverse().find((item) => item.type === "agent");
    nodes.splice(index, 0, { id: `${node.id}_check`, type: "approval", label: "A person checks it", config: { message: before ? `Go ahead?\n\n{{steps.${before.id}.output}}` : "Go ahead?" } });
    index += 1;
  }
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id, ...(nodes[index]!.type === "approval" ? { when: "approved" } : {}) }));
  const definition = parseDefinition({ nodes, edges });

  const inputs = (Array.isArray(raw?.inputs) ? raw.inputs : []).slice(0, 8)
    .map((input: any) => ({ key: slug(input?.key).replace(/-/g, "_"), label: text(input?.label, 120) }))
    .filter((input: { key: string; label: string }) => /^[a-z][a-z0-9_]{0,39}$/.test(input.key) && input.label);
  let schedule: WorkflowDraft["schedule"];
  const cron = text(raw?.schedule?.cron, 100);
  if (cron) {
    try {
      CronExpressionParser.parse(cron);
      if (cron.split(/\s+/).length === 5) schedule = { cron, note: text(raw.schedule.note, 120) || cron };
    } catch { /* A schedule that does not parse is left for the person to add. */ }
  }
  const blanks = JSON.stringify(definition).includes("[[recipient]]") ? ["who receives it"] : [];
  return { name: text(raw?.name, 120) || "New workflow", description: text(raw?.description, 500), agent, definition, inputs, schedule, blanks };
}

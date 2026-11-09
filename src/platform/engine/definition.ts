import { z } from "zod";
import { getNodeType } from "./nodes.ts";

const MAX_NODES = 100;
const MAX_DEFINITION_BYTES = 256 * 1024;
/** The settings a person sees on a step, in the builder's words. */
const FIELD_NAMES: Record<string, string> = { agent: "the agent", prompt: "the task", message: "the question for the approver", connectionId: "the connection", action: "the action", path: "the value to check" };

const definitionSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    type: z.string(),
    /** The name shown on the canvas, ignored by the engine. */
    label: z.string().max(120).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    /** Canvas position, ignored by the engine. */
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  })).min(1).max(MAX_NODES),
  edges: z.array(z.object({ from: z.string(), to: z.string(), when: z.string().optional() })).max(MAX_NODES * 4).default([]),
});

export type WorkflowDefinition = z.infer<typeof definitionSchema>;
export type WorkflowNode = WorkflowDefinition["nodes"][number];

export const incoming = (definition: WorkflowDefinition, id: string) => definition.edges.filter((e) => e.to === id);
export const outgoing = (definition: WorkflowDefinition, id: string) => definition.edges.filter((e) => e.from === id);

/** Orders nodes so each comes after those it depends on. Returns fewer nodes than given if there is a loop. */
export function inOrder(definition: WorkflowDefinition): WorkflowNode[] {
  const waiting = new Map(definition.nodes.map((n) => [n.id, incoming(definition, n.id).length]));
  const ready = definition.nodes.filter((n) => waiting.get(n.id) === 0);
  const ordered: WorkflowNode[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const edge of outgoing(definition, node.id)) {
      const left = waiting.get(edge.to)! - 1;
      waiting.set(edge.to, left);
      if (left === 0) ready.push(definition.nodes.find((n) => n.id === edge.to)!);
    }
  }
  return ordered;
}

/** Checks a workflow before it is saved. Throws one plain sentence naming the problem. */
export function parseDefinition(raw: unknown): WorkflowDefinition {
  if (JSON.stringify(raw ?? null).length > MAX_DEFINITION_BYTES) throw new Error("The workflow is too large.");
  const parsed = definitionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`The workflow is not valid: ${parsed.error.issues[0]!.path.join(".")} ${parsed.error.issues[0]!.message}.`);
  const definition = parsed.data;

  const ids = new Set(definition.nodes.map((n) => n.id));
  if (ids.size !== definition.nodes.length) throw new Error("Two steps share an id.");
  for (const node of definition.nodes) {
    const type = getNodeType(node.type);
    if (!type) throw new Error(`Step ${node.id} has an unknown type: ${node.type}.`);
    const config = type.configSchema.safeParse(node.config);
    if (!config.success) {
      const field = String(config.error.issues[0]!.path[0] ?? "");
      throw new Error(`Step "${node.label || node.id}" is not set up correctly: ${FIELD_NAMES[field] ? `choose or fill in ${FIELD_NAMES[field]}` : `${field} ${config.error.issues[0]!.message}`}.`);
    }
  }
  for (const edge of definition.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`A connection points to a step that does not exist: ${edge.from} to ${edge.to}.`);
    const branches = getNodeType(definition.nodes.find((n) => n.id === edge.from)!.type)!.branches;
    if (edge.when !== undefined && !branches?.includes(edge.when)) throw new Error(`Step ${edge.from} has no branch called ${edge.when}.`);
  }
  const starts = definition.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) throw new Error("A workflow needs exactly one start step.");
  if (incoming(definition, starts[0]!.id).length) throw new Error("Nothing can lead into the start step.");
  if (inOrder(definition).length !== definition.nodes.length) throw new Error("The workflow has a loop. Steps must always move forward.");

  const reached = new Set([starts[0]!.id]);
  for (const node of inOrder(definition)) {
    if (reached.has(node.id)) for (const edge of outgoing(definition, node.id)) reached.add(edge.to);
  }
  const lost = definition.nodes.find((n) => !reached.has(n.id));
  if (lost) throw new Error(`Step "${lost.label || lost.id}" is not connected to the start step. Drag from a dot on another step to join it.`);
  return definition;
}

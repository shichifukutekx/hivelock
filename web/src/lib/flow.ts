// Converts between saved workflows and the canvas. Kept free of React so it can be tested alone.
export interface StepDefinition {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}
export interface EdgeDefinition { from: string; to: string; when?: string }
export interface WorkflowDefinition { nodes: StepDefinition[]; edges: EdgeDefinition[] }

export interface CanvasNode {
  id: string;
  type: "step";
  position: { x: number; y: number };
  data: { stepType: string; label: string; config: Record<string, unknown>; status?: string };
  deletable?: boolean;
}
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
  className?: string;
}

const COLUMN = 280;
const ROW = 120;

export const STEP_LABELS: Record<string, string> = {
  start: "Start", agent: "Agent", condition: "Condition", approval: "Approval", connector: "Connector",
};
/** Handles a step offers, one for each way it can continue. */
export const STEP_BRANCHES: Record<string, string[]> = { condition: ["true", "false"], approval: ["approved", "declined"] };

/** Places steps by how far they are from the start, for workflows saved without positions. */
export function layout(definition: WorkflowDefinition) {
  const depth = new Map<string, number>(definition.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < definition.nodes.length; pass += 1) {
    for (const edge of definition.edges) {
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, (depth.get(edge.from) ?? 0) + 1));
    }
  }
  const rows = new Map<number, number>();
  return new Map(definition.nodes.map((node) => {
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return [node.id, node.position ?? { x: column * COLUMN, y: row * ROW }];
  }));
}

export function toCanvas(definition: WorkflowDefinition, statuses: Record<string, string> = {}) {
  const positions = layout(definition);
  const nodes: CanvasNode[] = definition.nodes.map((node) => ({
    id: node.id,
    type: "step",
    position: positions.get(node.id)!,
    deletable: node.type !== "start",
    data: { stepType: node.type, label: node.label ?? STEP_LABELS[node.type] ?? node.type, config: node.config, status: statuses[node.id] },
  }));
  const edges: CanvasEdge[] = definition.edges.map((edge) => ({
    id: `${edge.from}-${edge.when ?? ""}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    sourceHandle: edge.when,
    label: edge.when,
    className: ["running", "waiting"].includes(statuses[edge.to] ?? "") ? "live" : undefined,
  }));
  return { nodes, edges };
}

export function toDefinition(nodes: CanvasNode[], edges: CanvasEdge[]): WorkflowDefinition {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.stepType,
      label: node.data.label,
      config: node.data.config,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    })),
    edges: edges.map((edge) => ({ from: edge.source, to: edge.target, ...(edge.sourceHandle ? { when: edge.sourceHandle } : {}) })),
  };
}

/** Makes an id that is short, readable and unused. */
export function nextStepId(type: string, existing: string[]) {
  for (let number = 1; ; number += 1) {
    const id = `${type}_${number}`;
    if (!existing.includes(id)) return id;
  }
}

/** Would joining these two steps create a loop? */
export function makesLoop(edges: { source: string; target: string }[], source: string, target: string) {
  const seen = new Set<string>();
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.source === current) stack.push(edge.target);
  }
  return false;
}

/** The placeholders a step can use: the input, plus the steps that run before it. */
export function availableValues(definition: WorkflowDefinition, nodeId: string) {
  const before = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop()!;
    for (const edge of definition.edges) {
      if (edge.to === current && !before.has(edge.from)) {
        before.add(edge.from);
        stack.push(edge.from);
      }
    }
  }
  return [
    { path: "input", label: "Run input" },
    ...definition.nodes.filter((n) => before.has(n.id) && n.type !== "start").map((n) => ({ path: `steps.${n.id}.output`, label: n.label ?? n.id })),
  ];
}

/** The run input a workflow reads, found in its placeholders and conditions, so starting one can ask in plain fields. */
export function inputFields(definition?: WorkflowDefinition): string[] {
  if (!definition) return [];
  const found = new Set<string>();
  for (const node of definition.nodes) {
    for (const [, name] of JSON.stringify(node.config ?? {}).matchAll(/(?<![\w.])input\.([A-Za-z_][\w-]*)/g)) found.add(name!);
  }
  return [...found];
}

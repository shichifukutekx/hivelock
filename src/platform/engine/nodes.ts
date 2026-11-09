import { z } from "zod";
import { runAgent } from "../../runtime.ts";
import type { AgentDirectory } from "../../agents/registry.ts";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "../../tools.ts";
import type { NetworkPolicy } from "../net/safe-fetch.ts";
import { checkAnswer, runOptions } from "../agent-setup.ts";
import { PermanentError } from "../connectors/types.ts";
import { agentGate } from "../extensions.ts";
import { readPath, render, renderForModel, type TemplateData } from "./template.ts";
import { hideDatabaseNames, namesFromToolCall } from "../answer-polish.ts";

export interface NodeContext {
  data: TemplateData;
  directory: AgentDirectory;
  confidential: boolean;
  onEvent: (event: RunEvent) => void;
  pool: Pool;
  workspaceId: string;
  runId: string;
  nodeId: string;
  network: NetworkPolicy;
  masterKey: string;
  search?: (workspaceId: string, query: string) => Promise<import("../knowledge.ts").Passage[]>;
  /** Throws if this workspace has used its monthly token allowance. */
  checkBudget: () => Promise<unknown>;
}

/** What a node did. `wait` pauses the run for a person. `branch` picks which edges continue. */
export type NodeResult = { output?: unknown; branch?: string; wait?: boolean };

export interface NodeType<C = any> {
  label: string;
  configSchema: z.ZodType<C>;
  /** Edge labels this node can choose between. */
  branches?: string[];
  run(config: C, context: NodeContext): Promise<NodeResult>;
}

/** Each workspace's own folders. No workspace can name another's, because the name is a hash of its id. */
export const workspaceRoot = (workspaceId: string) => join(process.env.WORKSPACE_DATA_DIR ?? "data/workspaces", createHash("sha256").update(workspaceId).digest("hex").slice(0, 32));

export function workspaceFolders(workspaceId: string) {
  const root = workspaceRoot(workspaceId);
  const folders = { files: join(root, "files"), documents: join(root, "documents"), rfqs: join(root, "rfqs"), output: join(root, "output") };
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  return folders;
}

const nodeTypes = new Map<string, NodeType>();

/** Adds a node type. Connectors plug in here. */
export function registerNodeType<C>(name: string, type: NodeType<C>) {
  if (nodeTypes.has(name)) throw new Error(`Node type ${name} already exists.`);
  nodeTypes.set(name, type);
}

export const getNodeType = (name: string) => nodeTypes.get(name);

export const listNodeTypes = () => [...nodeTypes].map(([name, { label, branches }]) => ({ name, label, branches }));

registerNodeType("start", {
  label: "Start",
  configSchema: z.object({}),
  run: async (_, { data }) => ({ output: data.input }),
});

registerNodeType("agent", {
  label: "Agent",
  configSchema: z.object({ agent: z.string().min(1), prompt: z.string().min(1).max(20_000) }),
  run: async ({ agent, prompt }, { data, directory, confidential, onEvent, pool, workspaceId, runId, masterKey, network, checkBudget, search }) => {
    await checkBudget();
    const definition = await directory.get(agent);
    if (!definition) throw new Error(`There is no agent named ${agent}.`);
    // Retrying will not help until a person turns it on, so the step fails at once.
    const off = await directory.turnedOff?.(agent);
    if (off) throw new PermanentError(off);
    // A changed agent waits for its tests. Retrying will not help until they pass or someone chooses to use it anyway.
    const held = await agentGate()?.held({ pool, masterKey }, workspaceId, agent);
    if (held) throw new PermanentError(held);
    // Nobody is watching a background step, so actions needing approval are refused.
    // A workflow puts an approval step before the agent instead.
    const refuse = async () => false;
    try {
      const source = { pool, workspaceId, masterKey, network, search };
      const queried = new Set<string>();
      const answer = await runAgent(definition, renderForModel(prompt, data), refuse, (event: any) => { namesFromToolCall(event, queried); onEvent?.(event); }, {
        directory,
        policy: { confidential },
        ...runOptions(source),
        folders: workspaceFolders(workspaceId),
      });
      return { output: hideDatabaseNames(await checkAnswer(source, runId, "run", agent, answer), queried) };
    } catch (error) {
      // An outside tool may already have acted, so a retry could repeat it.
      if (definition.mcp?.length || definition.connections?.length) throw new PermanentError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  },
});

/** A value that really is a number. Number("") and Number(null) are 0, which would let an empty field pass as a small amount. */
const numeric = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
};
const bothNumbers = (a: unknown, b: unknown, compare: (a: number, b: number) => boolean) => {
  const [left, right] = [numeric(a), numeric(b)];
  return left !== undefined && right !== undefined && compare(left, right);
};

const comparisons = {
  equals: (a: unknown, b: unknown) => String(a) === String(b),
  not_equals: (a: unknown, b: unknown) => a !== undefined && String(a) !== String(b),
  contains: (a: unknown, b: unknown) => (typeof a === "string" ? a : JSON.stringify(a) ?? "").includes(String(b)),
  greater_than: (a: unknown, b: unknown) => bothNumbers(a, b, (x, y) => x > y),
  less_than: (a: unknown, b: unknown) => bothNumbers(a, b, (x, y) => x < y),
  exists: (a: unknown) => a !== undefined && a !== null,
};

registerNodeType("condition", {
  label: "Condition",
  branches: ["true", "false"],
  configSchema: z.object({
    path: z.string().min(1).max(200),
    operator: z.enum(Object.keys(comparisons) as [keyof typeof comparisons]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }),
  run: async ({ path, operator, value }, { data }) => {
    const actual = readPath(data, path);
    const passed = comparisons[operator as keyof typeof comparisons](actual, value);
    return { output: { passed }, branch: String(passed) };
  },
});

registerNodeType("approval", {
  label: "Approval",
  branches: ["approved", "declined"],
  configSchema: z.object({ message: z.string().min(1).max(2_000) }),
  run: async ({ message }, { data }) => ({ output: { message: render(message, data) }, wait: true }),
});

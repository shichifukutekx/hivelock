import { rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentDefinition } from "./agents/types.ts";
import { audit } from "./audit.ts";
import { hostedMode, paths } from "./config.ts";
import { DATA_NOTICE, markAsData } from "./platform/engine/template.ts";
import { redactSecrets } from "./platform/guardrails.ts";

export interface ApprovalRequest {
  tool: string;
  args: unknown;
}

export type RunActivity =
  | { type: "started"; prompt: string }
  | { type: "model"; model?: string; tokens?: number; inputTokens?: number; outputTokens?: number; ms?: number }
  | { type: "tool_started"; tool: string; args: unknown }
  | { type: "tool_finished"; tool: string; preview: string; output: string; isError: boolean; ms: number }
  | { type: "approval_needed"; tool: string; args: unknown }
  | { type: "approval_decided"; tool: string; approved: boolean }
  | { type: "finished"; answer: string }
  | { type: "failed"; message: string };

/** One step of a run. `parentRunId` is set when another agent started this run. */
export type RunEvent = RunActivity & { runId: string; parentRunId?: string; agent: string; at: string };

export type EventListener = (event: RunEvent) => void;
export type ActivityListener = (activity: RunActivity) => void;

export interface ToolFolders {
  files: string;
  documents: string;
  rfqs: string;
  output: string;
}

export interface ToolContext {
  agent: AgentDefinition;
  runId: string;
  onActivity: ActivityListener;
  /** Where this run's file tools work. The platform gives each workspace its own folders. */
  folders?: ToolFolders;
  /** Asked once more after a person approves, because the wait can be long and the answer may no longer hold. Throw to stop the action. */
  beforeApprovedAction?: () => Promise<void>;
  /** Counts a file a tool just wrote against the workspace's storage. Throw to refuse it, and the file is removed. */
  recordWrite?: (bytes: number) => Promise<void>;
}

/** The file tools that write, and the folder each writes into, so what they save is counted like an upload. */
const WRITING_TOOLS: Record<string, keyof ToolFolders> = { save_file: "files", save_report: "output" };

interface GuardedTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** Checks the arguments and returns what a person sees when approving. Throw to refuse the call. */
  display?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  /** Decides per call, for tools where only some uses change anything. */
  needsApproval?: (args: Record<string, unknown>) => boolean;
  /** `toolCallId` stays the same if the call is run again after an approval. */
  run: (args: Record<string, unknown>, call: { toolCallId?: string }) => Promise<string>;
}

const MAX_EVENT_OUTPUT = 50_000;

const serverFile = (name: string) => fileURLToPath(new URL(`./mcp/${name}-server.ts`, import.meta.url));

/** An error can quote a service's reply or a file, so the model gets it marked as data, with credentials removed. */
const failureForModel = (message: string) => `${markAsData(redactSecrets(message).text)}\n\n${DATA_NOTICE}`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Wraps a tool in the rules every tool follows: approval if required, then events and an audit entry. */
export function guardedTool({ agent, runId, onActivity, beforeApprovedAction }: ToolContext, spec: GuardedTool): StructuredToolInterface {
  return tool(
    async (args: Record<string, unknown>, config?: { toolCall?: { id?: string } }) => {
      let shown: unknown;
      try {
        shown = spec.display ? await spec.display(args) : args;
      } catch (error) {
        return failureForModel(messageOf(error));
      }
      const asksFirst = spec.needsApproval ? spec.needsApproval(args) : agent.requiresApproval.includes(spec.name);
      if (asksFirst) {
        const request: ApprovalRequest = { tool: spec.name, args: shown };
        const approved = interrupt(request) as boolean;
        audit(runId, "approval", { tool: spec.name, approved });
        if (!approved) return "A person declined this action. Do not retry it. Tell the user it was not done.";
      }
      onActivity({ type: "tool_started", tool: spec.name, args });
      const started = performance.now();
      const finish = (output: string, isError: boolean) => {
        audit(runId, "tool_call", { tool: spec.name, args, isError, chars: output.length });
        onActivity({
          type: "tool_finished",
          tool: spec.name,
          preview: output.slice(0, 300),
          output: output.slice(0, MAX_EVENT_OUTPUT),
          isError,
          ms: Math.round(performance.now() - started),
        });
      };
      try {
        if (asksFirst) await beforeApprovedAction?.();
        const output = await spec.run(args, { toolCallId: config?.toolCall?.id });
        finish(output, false);
        return output;
      } catch (error) {
        // The reason is shown to people in the chat, so credentials are taken out first.
        finish(redactSecrets(messageOf(error)).text, true);
        return failureForModel(messageOf(error));
      }
    },
    { name: spec.name, description: spec.description, schema: spec.schema },
  );
}

/** Charges a saved file to storage. Over the limit, the file is removed again and the agent is told why. */
async function countWrite(context: ToolContext, toolName: string, output: string) {
  const folder = WRITING_TOOLS[toolName];
  const saved = output.match(/^Saved (.+)$/m)?.[1]?.trim();
  if (!folder || !saved || !context.recordWrite || !context.folders) return;
  const root = resolve(context.folders[folder]);
  const path = resolve(root, saved);
  if (!path.startsWith(root + sep)) return;
  const { size } = await stat(path);
  try {
    await context.recordWrite(size);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

/** Starts the agent's MCP server, if it has one, and exposes only the tools this agent is allowed to use. */
export async function connectTools(context: ToolContext, extraTools: StructuredToolInterface[]) {
  // Tools handed in for one run, such as reviewed MCP tools, sit alongside the agent's own list.
  const { agent } = context;
  if (!agent.server) return { tools: extraTools, close: async () => {} };
  if (hostedMode()) throw new Error("File tools are not available in the hosted version.");

  const client = new Client({ name: "agent-platform", version: "0.1.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverFile(agent.server)],
      // Passed explicitly so the LLM key never reaches the tool process.
      env: {
        FILES_DIR: context.folders?.files ?? "data/files",
        DOCUMENTS_DIR: context.folders?.documents ?? paths.documents(),
        RFQS_DIR: context.folders?.rfqs ?? paths.rfqs(),
        OUTPUT_DIR: context.folders?.output ?? paths.output(),
      },
    }),
  );

  const { tools: available } = await client.listTools();
  const tools = available
    .filter((t) => agent.tools.includes(t.name))
    .map((t) =>
      guardedTool(context, {
        name: t.name,
        description: t.description ?? t.name,
        schema: t.inputSchema as Record<string, unknown>,
        run: async (args) => {
          const result = await client.callTool({ name: t.name, arguments: args });
          const blocks = result.content as { type: string; text?: string }[];
          const output = blocks.map((b) => b.text ?? "").join("\n");
          if (result.isError) throw new Error(output);
          await countWrite(context, t.name, output);
          return output;
        },
      }),
    );

  return { tools: [...tools, ...extraTools], close: () => client.close() };
}

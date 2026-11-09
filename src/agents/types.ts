import type { ModelRole } from "../config.ts";

export interface AgentDefinition {
  name: string;
  /** One sentence shown in the UI and used by the orchestrator to choose an agent. */
  description: string;
  /** The name people see, such as "Audit preparation". The name stays the id. */
  title?: string;
  /** One or two sentences on how to use it, shown when a chat starts. */
  guide?: string;
  /** Example first messages, offered as one-click starts. */
  starters?: string[];
  /** The MCP server in src/mcp/ that provides this agent's tools. Omit for agents that only use platform tools. */
  server?: "documents" | "rfq" | "files";
  /** main: reasoning and tool use. fast: simple, high-volume work. coding: writing code. kimi: use Kimi first. */
  model: ModelRole;
  instructions: string;
  /** Tools this agent may use. Anything not listed is not available to it. */
  tools: string[];
  /** Subset of `tools` that needs a person to approve each call. */
  requiresApproval: string[];
  maxSteps: number;
  maxTokens: number;
  /** Actions on the workspace's connections. Credentials stay with the platform and never reach the model. */
  connections?: { connectionId: string; action: string }[];
  /** Reviewed tools on the workspace's MCP servers. */
  mcp?: { connectionId: string; tool: string }[];
  /** Workspace skills added to this agent's instructions. */
  skills?: string[];
  /** Lets the agent search this workspace's documents. */
  knowledge?: boolean;
  /** Lets the agent keep notes between chats, each saved only after a person approves it. */
  memory?: boolean;
  /** Set on agents made by agent-builder. */
  createdByAgent?: boolean;
}

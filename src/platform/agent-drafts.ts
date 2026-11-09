import type { Pool } from "pg";
import { buildAgent, toolCatalog } from "../agents/registry.ts";
import { askModel } from "../runtime.ts";
import { getConnector } from "./connectors/index.ts";
import { connectorEdition, connectorLocked } from "./limits.ts";
import { inWorkspace } from "./db.ts";
import { workspaceModels } from "./model-providers.ts";
import { assertWithinBudget, isConfidential, recordTokens } from "./usage.ts";

const SYSTEM = `You design AI agents for a business automation platform. Reply with one JSON object and nothing else:
{"name": "lowercase-words-with-hyphens", "description": "one sentence", "model": "main or fast or coding", "instructions": "...", "server": "files or omit it", "tools": ["only when server is files"], "connections": [{"connectionId": "...", "action": "..."}], "mcp": [{"connectionId": "...", "tool": "..."}], "knowledge": true}

Set knowledge to true when the agent must find answers in the workspace's uploaded documents, and tell it to name the file it used.

Write instructions as direct guidance to the agent: its job, the steps it follows, what to base its answers on, how to format them, and what to do when information is missing.
Only use capabilities from the list you are given, and only those the job needs. Never invent one. If something needed is missing, say so in the instructions and have the agent tell the user.
Use "main" for reasoning and tools, "fast" for simple high-volume work, and "coding" for writing code.`;

/** What this workspace's agents could be given. Lists names only, never credentials. */
export async function capabilities(pool: Pool, workspaceId: string) {
  return inWorkspace(pool, workspaceId, async (db) => {
    const connections = (await db.query("select id, connector, name from connections order by name")).rows;
    const reviewed = (await db.query("select connection_id, name, description from mcp_tools where status = 'enabled' order by name")).rows;
    const edition = await connectorEdition(db);
    return {
      connections: connections.filter((c) => c.connector !== "mcp" && !connectorLocked(edition, c.connector)).map((c) => {
        const connector = getConnector(c.connector);
        return {
          connectionId: c.id as string,
          connector: c.connector as string,
          name: c.name as string,
          service: connector?.label ?? c.connector,
          actions: Object.entries(connector?.actions ?? {}).map(([action, definition]) => ({ action, label: definition.label, changesData: definition.changesData === true || !!definition.asksFirst })),
        };
      }),
      mcp: reviewed.map((t) => ({ connectionId: t.connection_id as string, tool: t.name as string, description: t.description as string })),
      files: toolCatalog.files,
    };
  });
}

/** Turns a plain description into an agent for a person to review. Nothing is saved here. */
export async function draftAgent(pool: Pool, workspaceId: string, description: string, masterKey: string) {
  await assertWithinBudget(pool, workspaceId);
  const available = await capabilities(pool, workspaceId);
  const { text, tokens } = await askModel("main", SYSTEM, `Available capabilities:\n${JSON.stringify(available)}\n\nThe agent to design:\n${description}`, { confidential: await isConfidential(pool, workspaceId) }, workspaceModels(pool, workspaceId, masterKey));
  if (tokens) await recordTokens(pool, workspaceId, tokens);
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let draft: any;
  try {
    draft = JSON.parse(json);
  } catch {
    throw new Error("The model did not return a usable draft. Try again, or describe the agent differently.");
  }
  // The model's suggestion is only a suggestion, so anything not really available is dropped here.
  const connections = (Array.isArray(draft.connections) ? draft.connections : []).filter((c: any) =>
    available.connections.some((a) => a.connectionId === c?.connectionId && a.actions.some((x) => x.action === c?.action)));
  const mcp = (Array.isArray(draft.mcp) ? draft.mcp : []).filter((c: any) => available.mcp.some((a) => a.connectionId === c?.connectionId && a.tool === c?.tool));
  const server = draft.server === "files" ? "files" : undefined;
  const spec = {
    name: String(draft.name ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40),
    description: String(draft.description ?? "").slice(0, 300),
    model: ["main", "fast", "coding"].includes(draft.model) ? draft.model : "main",
    instructions: String(draft.instructions ?? "").slice(0, 8_000),
    server,
    knowledge: draft.knowledge === true,
    tools: server ? (Array.isArray(draft.tools) ? draft.tools : toolCatalog.files).filter((t: string) => toolCatalog.files!.includes(t)) : [],
    connections,
    mcp,
  };
  buildAgent(spec);
  return spec;
}

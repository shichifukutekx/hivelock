import type { Pool, PoolClient } from "pg";
import type { AgentDefinition } from "../agents/types.ts";
import { buildAgent, builtInAgents, specOf, type AgentDirectory } from "../agents/registry.ts";
import { hostedMode } from "../config.ts";
import { inWorkspace } from "./db.ts";
import { assertAgentRoom } from "./limits.ts";

/** A person can only attach connections from this workspace, whatever ids a request names. */
async function assertOwnConnections(db: PoolClient, request: unknown) {
  const { connections = [], mcp = [], skills = [] } = request as { connections?: { connectionId: string }[]; mcp?: { connectionId: string }[]; skills?: string[] };
  for (const skill of skills) {
    const { rowCount } = await db.query("select 1 from agent_skills where name = $1", [skill]);
    if (!rowCount) throw new Error(`There is no skill named ${skill}.`);
  }
  for (const { connectionId } of [...connections, ...mcp]) {
    const { rowCount } = await db.query("select 1 from connections where id = $1", [connectionId]);
    if (!rowCount) throw new Error("That connection does not exist in this workspace.");
  }
}

/** File tools run as a local process with the server's disk, so tenants sharing a server do not get them. */
function assertHostedTools(agent: AgentDefinition) {
  if (hostedMode() && agent.server) throw new Error("File tools are not available in the hosted version. Use document search instead.");
}

/** The last checks on a new agent and its saved row. The name must already be known to be free. */
export async function insertAgent(db: PoolClient, workspaceId: string, actorId: string, agent: AgentDefinition, request: unknown) {
  assertHostedTools(agent);
  await assertOwnConnections(db, agent);
  await assertAgentRoom(db, workspaceId);
  await db.query(
    "insert into workspace_agents (workspace_id, name, spec, created_by) values ($1, $2, $3, $4)",
    [workspaceId, agent.name, JSON.stringify(specOf(request)), actorId],
  );
}

/** What a person or a workflow sees when an agent is turned off. */
export const offMessage = (name: string, reason?: string | null) =>
  `${name} is turned off${reason ? `: ${reason}` : ""}. Someone who manages agents can turn it on again under Agents.`;

/** Each workspace sees the built-in agents plus its own. */
export function workspaceDirectory(pool: Pool, workspaceId: string, actorId: string): AgentDirectory {
  const owned = () => inWorkspace(pool, workspaceId, async (db) =>
    (await db.query<{ spec: unknown }>("select spec from workspace_agents order by name")).rows.flatMap(({ spec }) => {
      try {
        return [buildAgent(spec)];
      } catch {
        return [];
      }
    }));
  const list = async () => {
    // The platform is general purpose, so the RFQ example stays out of its agent list.
    const reserved = builtInAgents().filter((a) => a.name !== "rfq-checker" && !(hostedMode() && a.server));
    return [...reserved, ...(await owned()).filter((a) => !reserved.some((b) => b.name === a.name))];
  };
  const get = async (name: string) => (await list()).find((a) => a.name === name);
  const prepare = async (request: unknown) => {
    const agent = buildAgent(request);
    if (await get(agent.name)) throw new Error(`An agent named ${agent.name} already exists.`);
    return agent;
  };
  const turnedOff = (name: string) => inWorkspace(pool, workspaceId, async (db) => {
    const { rows: [row] } = await db.query("select reason from agent_switches where agent_name = $1", [name]);
    return row ? offMessage(name, row.reason) : undefined;
  });
  return {
    list,
    get,
    turnedOff,
    prepare,
    save: async (request) => {
      const agent = await prepare(request);
      await inWorkspace(pool, workspaceId, (db) => insertAgent(db, workspaceId, actorId, agent, request));
      return agent;
    },
    update: async (name, request) => {
      const agent = buildAgent(request);
      assertHostedTools(agent);
      const { rowCount } = await inWorkspace(pool, workspaceId, async (db) => {
        await assertOwnConnections(db, agent);
        return db.query("update workspace_agents set spec = $2 where name = $1", [name, JSON.stringify(specOf(request))]);
      });
      return rowCount ? agent : undefined;
    },
  };
}

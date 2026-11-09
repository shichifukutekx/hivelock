import { z } from "zod";
import { inWorkspace } from "../db.ts";
import { registerNodeType } from "../engine/nodes.ts";
import { connectorEdition, connectorLocked, lockedConnectorMessage } from "../limits.ts";
import { render, type TemplateData } from "../engine/template.ts";
import { onlyOnce } from "./effects.ts";
import { callReviewedTool } from "./mcp.ts";
import { loadConnection } from "./store.ts";
import { getConnector, PermanentError } from "./types.ts";
import { actionRules, BLOCKED_MESSAGE, ruleFor } from "../action-rules.ts";

const config = z.object({
  connectionId: z.uuid(),
  action: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
});

/** Fields where a filled-in value could change what is run, not just what is sent. */
export const NO_PLACEHOLDERS = new Set(["sql", "soql", "jql", "filterByFormula", "zendesk.query", "shopify.query"]);
const ENCODED = new Set(["path"]);
const DOTS = /(^|[/?#])\.\.?($|[/?#])/;

/** Fills placeholders at any depth. Whole values stay as text, so outside data cannot add new fields. */
export function fill(value: unknown, data: TemplateData, field = "", connector = ""): unknown {
  if (typeof value === "string") {
    if ((NO_PLACEHOLDERS.has(field) || NO_PLACEHOLDERS.has(`${connector}.${field}`)) && value.includes("{{")) throw new PermanentError(field === "sql" ? "Placeholders are not allowed in SQL. Use $1 and the values list." : `Placeholders are not allowed in ${field}, because outside text could change the query.`);
    if (!ENCODED.has(field)) return render(value, data);
    const filled = render(value, data, encodeURIComponent);
    // Encoding leaves dots alone, and a URL treats . and .. as moves. Checked on the whole path, because two values can meet to form one.
    if (filled !== value && DOTS.test(filled)) throw new PermanentError("A filled-in path cannot contain . or .. as a segment.");
    return filled;
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, data, "", connector));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, data, key, connector)]));
  }
  return value;
}

registerNodeType("connector", {
  label: "Connector",
  configSchema: config,
  run: async ({ connectionId, action, params }, context) => {
    const { pool, workspaceId, runId, nodeId, network, masterKey, data } = context;
    const connection = await inWorkspace(pool, workspaceId, (db) => loadConnection(db, masterKey, workspaceId, connectionId));
    if (!connection) throw new PermanentError("This connection no longer exists.");
    const edition = await connectorEdition(pool);
    if (connectorLocked(edition, connection.connector)) throw new PermanentError(lockedConnectorMessage(edition!, connection.connector));
    const connector = getConnector(connection.connector);
    const definition = connector?.actions[action];
    if (!definition) throw new PermanentError(`This connection cannot do ${action}.`);
    // A blocked action stops here. "Ask every time" is for agents: a workflow already puts an approval step before a change.
    const blocked = await inWorkspace(pool, workspaceId, async (db) => ruleFor(await actionRules(db, [connectionId]), connectionId, action) === "block");
    if (blocked) throw new PermanentError(BLOCKED_MESSAGE);

    const parsed = definition.params.safeParse(fill(params, data, "", connection.connector));
    if (!parsed.success) throw new PermanentError(`The step is not set up correctly: ${parsed.error.issues[0]!.path.join(".")} ${parsed.error.issues[0]!.message}.`);

    const changes = typeof definition.changesData === "function" ? definition.changesData(parsed.data) : definition.changesData;
    const act = (): Promise<unknown> => {
      if (connection.connector === "mcp") return callMcp(context, connectionId, connection.credentials, parsed.data as { tool: string; arguments: Record<string, unknown> });
      return definition.run(connection.credentials, parsed.data, { network, idempotencyKey: `${runId}:${nodeId}` });
    };
    const output = changes ? await onlyOnce({ pool, workspaceId, runId, nodeId, masterKey }, act) : await act();
    return { output };
  },
});

async function callMcp(context: { pool: any; workspaceId: string; network: any }, connectionId: string, credentials: unknown, { tool, arguments: args }: { tool: string; arguments: Record<string, unknown> }) {
  const { pool, workspaceId, network } = context;
  const review = await inWorkspace(pool, workspaceId, async (db) =>
    (await db.query("select name, fingerprint, status from mcp_tools where connection_id = $1 and name = $2", [connectionId, tool])).rows[0]);
  if (review?.status !== "enabled") throw new PermanentError(`The tool ${tool} has not been turned on.`);
  return callReviewedTool(credentials, network, review, args);
}

export { config as connectorConfig };

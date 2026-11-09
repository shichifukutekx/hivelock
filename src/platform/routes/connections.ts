import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import { actionRules, ruleFor } from "../action-rules.ts";
import type { ConnectorAction } from "../connectors/types.ts";
import { recordAudit } from "../audit-log.ts";
import { getConnector, listConnectors } from "../connectors/index.ts";
import { discoverTools } from "../connectors/mcp.ts";
import { loadConnection, saveCredentials } from "../connectors/store.ts";
import { inWorkspace } from "../db.ts";
import { assertConnector, connectorEdition, connectorLocked, lockedConnectorMessage } from "../limits.ts";
import type { PlatformEnv } from "../env.ts";
import type { NetworkPolicy } from "../net/safe-fetch.ts";
import type { Permission } from "../permissions.ts";
import { PAID_CONNECTOR_LABELS } from "../plans.ts";
import { plainError } from "../plain-errors.ts";

interface Deps {
  pool: Pool;
  env: PlatformEnv;
  network: NetworkPolicy;
  requirePermission: (permission: Permission) => any;
}

const uuid = z.uuid();
const body = z.object({ connector: z.string(), name: z.string().trim().min(1).max(120), credentials: z.unknown() });
const editBody = z.object({ name: z.string().trim().min(1).max(120), credentials: z.record(z.string(), z.unknown()).default({}) });

/** Settings that change only what this connection may do, not where its secrets go. Anything else needs the secrets typed again. */
const SAFE_TO_CHANGE = new Set(["allowWrites", "allowedRecipientDomains", "allowedPrefixes"]);
const secretFields = (connector: { fields: { name: string; type: string }[] }) => new Set(connector.fields.filter((field) => field.type === "password").map((field) => field.name));
const blank = (value: unknown) => value === undefined || value === null || value === "";

/** Records what a server offers. New and changed tools are off, whatever they were before. */
async function syncTools(pool: Pool, workspaceId: string, connectionId: string, tools: Awaited<ReturnType<typeof discoverTools>>) {
  return inWorkspace(pool, workspaceId, async (db) => {
    const { rows } = await db.query("select name, fingerprint from mcp_tools where connection_id = $1", [connectionId]);
    const known = new Map(rows.map((r) => [r.name, r.fingerprint]));
    let changed = 0;
    for (const tool of tools) {
      const previous = known.get(tool.name);
      known.delete(tool.name);
      if (previous === tool.fingerprint) continue;
      if (previous) changed += 1;
      await db.query(
        `insert into mcp_tools (workspace_id, connection_id, name, description, input_schema, fingerprint, changed)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (connection_id, name) do update
           set description = excluded.description, input_schema = excluded.input_schema, fingerprint = excluded.fingerprint,
               status = 'disabled', changed = excluded.changed, reviewed_by = null, reviewed_at = null`,
        [workspaceId, connectionId, tool.name, tool.description, JSON.stringify(tool.inputSchema ?? {}), tool.fingerprint, !!previous],
      );
    }
    for (const name of known.keys()) await db.query("delete from mcp_tools where connection_id = $1 and name = $2", [connectionId, name]);
    return changed;
  });
}

export function addConnectionRoutes(app: Hono<any>, { pool, env, network, requirePermission }: Deps) {
  const base = "/api/v1/workspaces/:workspaceId/connections";
  const scoped = (c: any) => c.req.param("workspaceId") as string;
  const actor = (c: any) => c.get("user").id as string;
  const missing = (c: any) => c.json({ error: "Not found." }, 404);
  const validId = async (c: any, next: () => Promise<void>) => {
    if (!uuid.safeParse(c.req.param("connectionId")).success) return missing(c);
    await next();
  };
  const load = (workspaceId: string, id: string) => inWorkspace(pool, workspaceId, (db) => loadConnection(db, env.SECRETS_MASTER_KEY, workspaceId, id));
  const networkMessage = (error: unknown) => plainError(error, "The service");

  app.get("/api/v1/connectors", async (c) => {
    const edition = await connectorEdition(pool);
    const known = listConnectors();
    return c.json({
      connectors: known.map((connector) => ({ ...connector, locked: connectorLocked(edition, connector.name) })),
      /** Named so the page can say what an upgrade adds, when this install does not have them. */
      notInstalled: Object.entries(PAID_CONNECTOR_LABELS).filter(([name]) => !known.some((item) => item.name === name)).map(([, label]) => label),
    });
  });

  app.get(base, requirePermission("connections:list"), async (c) => {
    const rows = await inWorkspace(pool, scoped(c), async (db) =>
      (await db.query("select id, connector, name, created_at, updated_at from connections order by name")).rows);
    // A saved connection of a paid type stays listed, and says why it does not run.
    const edition = await connectorEdition(pool);
    return c.json({ connections: rows.map((row) => (connectorLocked(edition, row.connector) ? { ...row, locked: true, lockedReason: lockedConnectorMessage(edition!, row.connector) } : row)) });
  });

  app.post(base, requirePermission("connections:write"), async (c) => {
    const parsed = body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a connector, name and credentials." }, 400);
    const connector = getConnector(parsed.data.connector);
    // A paid type this install does not have gets the way to upgrade, not "does not exist".
    if (!connector && Object.hasOwn(PAID_CONNECTOR_LABELS, parsed.data.connector)) await assertConnector(pool, parsed.data.connector);
    if (!connector) return c.json({ error: "That connector does not exist." }, 400);
    await assertConnector(pool, connector.name);
    const credentials = connector.credentials.safeParse(parsed.data.credentials);
    // Reports the field, never its value.
    if (!credentials.success) return c.json({ error: `Check the ${credentials.error.issues[0]!.path.join(".")} field.` }, 400);

    const workspaceId = scoped(c);
    const id = randomUUID();
    try {
      await inWorkspace(pool, workspaceId, async (db) => {
        const { ciphertext, iv, tag } = await saveCredentials(db, env.SECRETS_MASTER_KEY, workspaceId, id, credentials.data);
        await db.query(
          "insert into connections (id, workspace_id, connector, name, ciphertext, iv, tag, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)",
          [id, workspaceId, connector.name, parsed.data.name, ciphertext, iv, tag, actor(c)],
        );
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "connection.created", targetType: "connection", targetId: id, details: { connector: connector.name } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return c.json({ error: "A connection with that name already exists." }, 400);
      throw error;
    }
    return c.json({ id }, 201);
  });

  // What the edit form shows. Passwords, tokens and keys never leave the server, only whether one is saved.
  app.get(`${base}/:connectionId`, requirePermission("connections:write"), validId, async (c) => {
    const connection = await load(scoped(c), c.req.param("connectionId"));
    const connector = connection && getConnector(connection.connector);
    if (!connection || !connector) return missing(c);
    const secrets = secretFields(connector);
    const saved = connection.credentials as Record<string, unknown>;
    return c.json({
      id: connection.id, connector: connection.connector, name: connection.name,
      values: Object.fromEntries(connector.fields.filter((field) => !secrets.has(field.name) && !blank(saved[field.name])).map((field) => [field.name, saved[field.name]])),
      savedSecrets: [...secrets].filter((name) => !blank(saved[name])),
    });
  });

  // A secret left empty keeps the saved one, unless the connection now points somewhere else.
  app.put(`${base}/:connectionId`, requirePermission("connections:write"), validId, async (c) => {
    const parsed = editBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Enter a name and the connection details." }, 400);
    const workspaceId = scoped(c);
    const id = c.req.param("connectionId");
    const connection = await load(workspaceId, id);
    const connector = connection && getConnector(connection.connector);
    if (!connection || !connector) return missing(c);
    await assertConnector(pool, connector.name);
    const secrets = secretFields(connector);
    const saved = connection.credentials as Record<string, unknown>;
    const sent = parsed.data.credentials;
    const known = new Set(connector.fields.map((field) => field.name));
    const next: Record<string, unknown> = {};
    for (const name of known) {
      if (secrets.has(name)) {
        if (!blank(sent[name])) next[name] = sent[name];
        else if (!blank(saved[name])) next[name] = saved[name];
      } else if (!blank(sent[name])) next[name] = sent[name];
    }
    const moved = [...known].some((name) => !secrets.has(name) && !SAFE_TO_CHANGE.has(name) && String(next[name] ?? "") !== String(saved[name] ?? ""));
    const kept = [...secrets].filter((name) => blank(sent[name]) && !blank(saved[name]));
    if (moved && kept.length) {
      const labels = connector.fields.filter((field) => kept.includes(field.name)).map((field) => field.label.toLowerCase());
      return c.json({ error: `Enter the ${labels.join(" and ")} again, because where this connection goes has changed.`, code: "secret_needed" }, 400);
    }
    const credentials = connector.credentials.safeParse(next);
    if (!credentials.success) return c.json({ error: `Check the ${credentials.error.issues[0]!.path.join(".")} field.` }, 400);
    try {
      await inWorkspace(pool, workspaceId, async (db) => {
        const { ciphertext, iv, tag } = await saveCredentials(db, env.SECRETS_MASTER_KEY, workspaceId, id, credentials.data);
        await db.query("update connections set name = $2, ciphertext = $3, iv = $4, tag = $5, updated_at = now() where id = $1", [id, parsed.data.name, ciphertext, iv, tag]);
        // A server at a new address offers its own tools, and each needs a person's review again.
        if (moved && connector.name === "mcp") await db.query("delete from mcp_tools where connection_id = $1", [id]);
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "connection.updated", targetType: "connection", targetId: id, details: { connector: connector.name, renamed: parsed.data.name !== connection.name, moved, secretsReplaced: [...secrets].filter((name) => !blank(sent[name])) } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return c.json({ error: "A connection with that name already exists." }, 400);
      throw error;
    }
    return c.json({ saved: true });
  });

  app.delete(`${base}/:connectionId`, requirePermission("connections:write"), validId, async (c) => {
    const workspaceId = scoped(c);
    const id = c.req.param("connectionId");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("delete from connections where id = $1", [id]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: "connection.deleted", targetType: "connection", targetId: id });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  app.post(`${base}/:connectionId/test`, requirePermission("connections:write"), validId, async (c) => {
    const connection = await load(scoped(c), c.req.param("connectionId"));
    if (!connection) return missing(c);
    await assertConnector(pool, connection.connector);
    try {
      await getConnector(connection.connector)!.test(connection.credentials, { network, idempotencyKey: "test" });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: networkMessage(error) });
    }
  });

  app.get(`${base}/:connectionId/tools`, requirePermission("connections:list"), validId, async (c) => {
    const rows = await inWorkspace(pool, scoped(c), async (db) =>
      (await db.query("select name, description, input_schema, fingerprint, status, changed, reviewed_by, reviewed_at from mcp_tools where connection_id = $1 order by name", [c.req.param("connectionId")])).rows);
    return c.json({ tools: rows });
  });

  app.post(`${base}/:connectionId/tools/refresh`, requirePermission("connections:write"), validId, async (c) => {
    const workspaceId = scoped(c);
    const connection = await load(workspaceId, c.req.param("connectionId"));
    if (connection?.connector !== "mcp") return missing(c);
    try {
      const tools = await discoverTools(connection.credentials, network);
      const changed = await syncTools(pool, workspaceId, connection.id, tools);
      await inWorkspace(pool, workspaceId, (db) => recordAudit(db, { workspaceId, actorId: actor(c), action: "mcp.tools_refreshed", targetType: "connection", targetId: connection.id, details: { tools: tools.length, changed } }));
      return c.json({ tools: tools.length, changed });
    } catch (error) {
      return c.json({ error: networkMessage(error) }, 400);
    }
  });

  app.put(`${base}/:connectionId/tools/:tool`, requirePermission("connections:write"), validId, async (c) => {
    // Turning a tool on names the version the person read, so a definition that changed meanwhile is never switched on unseen.
    const parsed = z.object({ enabled: z.boolean(), fingerprint: z.string().min(1).max(200).optional() })
      .refine((body) => !body.enabled || !!body.fingerprint).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose on or off, and read the tool before turning it on." }, 400);
    const workspaceId = scoped(c);
    const tool = c.req.param("tool");
    const id = c.req.param("connectionId");
    const updated = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [found] } = await db.query("select fingerprint from mcp_tools where connection_id = $1 and name = $2 for update", [id, tool]);
      if (!found) return "missing";
      if (parsed.data.enabled && found.fingerprint !== parsed.data.fingerprint) return "changed";
      await db.query(
        `update mcp_tools set status = $3, changed = false, reviewed_by = $4, reviewed_at = now() where connection_id = $1 and name = $2`,
        [id, tool, parsed.data.enabled ? "enabled" : "disabled", actor(c)],
      );
      await recordAudit(db, { workspaceId, actorId: actor(c), action: parsed.data.enabled ? "mcp.tool_enabled" : "mcp.tool_disabled", targetType: "connection", targetId: id, details: { tool } });
      return "saved";
    });
    if (updated === "missing") return missing(c);
    if (updated === "changed") return c.json({ error: "This tool changed since the page loaded. Read it again, then turn it on." }, 409);
    return c.json({ enabled: parsed.data.enabled });
  });

  // What each action on a connection does, and the rule an admin set for it. MCP tools have their own on and off switch.
  app.get(`${base}/:connectionId/actions`, requirePermission("connections:list"), validId, async (c) => {
    const id = c.req.param("connectionId");
    const found = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: [row] } = await db.query("select connector from connections where id = $1", [id]);
      return row && { connector: row.connector as string, rules: await actionRules(db, [id]) };
    });
    const connector = found && getConnector(found.connector);
    if (!connector || found.connector === "mcp") return missing(c);
    const actions = Object.entries(connector.actions as Record<string, ConnectorAction>).map(([name, action]) => ({
      name, label: action.label,
      changes: action.asksFirst || action.changesData === true ? "always" : typeof action.changesData === "function" ? "sometimes" : "never",
      rule: ruleFor(found.rules, id, name) ?? "default",
    }));
    return c.json({ actions });
  });

  app.put(`${base}/:connectionId/actions/:action`, requirePermission("connections:write"), validId, async (c) => {
    const parsed = z.object({ rule: z.enum(["default", "ask", "block"]) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Choose the usual rule, ask every time, or off." }, 400);
    const workspaceId = scoped(c);
    const id = c.req.param("connectionId");
    const action = c.req.param("action");
    const saved = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [row] } = await db.query("select connector from connections where id = $1", [id]);
      if (!row || row.connector === "mcp" || !getConnector(row.connector)?.actions[action]) return false;
      if (parsed.data.rule === "default") await db.query("delete from action_rules where connection_id = $1 and action = $2", [id, action]);
      else await db.query(
        `insert into action_rules (workspace_id, connection_id, action, rule, set_by) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, connection_id, action) do update set rule = excluded.rule, set_by = excluded.set_by, set_at = now()`,
        [workspaceId, id, action, parsed.data.rule, actor(c)],
      );
      await recordAudit(db, { workspaceId, actorId: actor(c), action: "connection.action_rule", targetType: "connection", targetId: id, details: { action, rule: parsed.data.rule } });
      return true;
    });
    return saved ? c.json(parsed.data) : missing(c);
  });
}

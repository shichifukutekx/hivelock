import { randomBytes, randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Hono } from "hono";
import type { PgBoss } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { buildAgent, builtInAgents } from "../../agents/registry.ts";
import { agentLooks } from "../agent-looks.ts";
import { workspaceDirectory } from "../agents-store.ts";
import { recordAudit } from "../audit-log.ts";
import { inWorkspace } from "../db.ts";
import type { PlatformEnv } from "../env.ts";
import { assertMayReadMail, loadConnection } from "../connectors/store.ts";
import type { WorkflowDefinition } from "../engine/definition.ts";
import { agentGate, triggerKind, triggerKinds, type GateOptions } from "../extensions.ts";
import { TRIGGER_QUEUE, type Engine } from "../engine/engine.ts";
import { listNodeTypes } from "../engine/nodes.ts";
import { assertFeature, hasFeature, oldVersionRefused } from "../limits.ts";
import { can, type Permission } from "../permissions.ts";
import { serverModels } from "../model-providers.ts";
import { COMMUNITY_READABLE_VERSIONS } from "../plans.ts";
import { addChoice, addRange, addSearch, conditions, orderBy, readPage } from "../paging.ts";
import { allow, LIMITS } from "../rate-limit.ts";
import { KEEP_VERSIONS } from "../maintenance.ts";
import { encryptSecret, unseal, unsealText } from "../secrets.ts";
import { checkSteps, insertWorkflow } from "../workflows-store.ts";
import { webhookSecretName } from "./webhooks.ts";
import { draftWorkflow } from "../workflow-drafts.ts";
import { triggerFilter } from "../trigger-filter.ts";

interface Deps {
  pool: Pool;
  engine: Engine;
  boss: PgBoss;
  env: PlatformEnv;
  requirePermission: (permission: Permission, options?: GateOptions) => any;
}

const uuid = z.uuid();
const workflowBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1_000).default(""),
  definition: z.unknown(),
  note: z.string().trim().max(500).default(""),
});
const triggerBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cron: z.string().min(9).max(100), timezone: z.string().default("UTC") }),
  z.object({ kind: z.literal("webhook") }),
]);
/** Each kind's own pg-boss queue, for the kinds that run on a timer. A kind this install does not have has no timers here to stop. */
const timedQueue = (kind?: string) => (kind === "schedule" ? TRIGGER_QUEUE : triggerKind(kind)?.queue);
const VERSION_LIST = 200;
const RUN_STATUSES = ["running", "waiting", "succeeded", "failed", "cancelled"];
const RUN_TRIGGERS = ["manual", "schedule", "webhook", "email"];
const WORKFLOW_STATES = ["live", "draft"];

/** A save and its numbered copy share one transaction, so neither can exist without the other. */
export async function saveVersion(db: PoolClient, workspaceId: string, workflowId: string, actorId: string, saved: {
  name: string; description: string; definition: WorkflowDefinition; note: string; restoredFrom?: number;
}) {
  // The previous version of the app may have saved during an upgrade, and it wrote no copy.
  await db.query(
    `insert into workflow_versions (workspace_id, workflow_id, version, name, description, definition, note, saved_at)
     select workspace_id, id, version, name, description, definition, 'Saved during an upgrade.', updated_at from workflows where id = $1
     on conflict do nothing`,
    [workflowId],
  );
  const { rows: [row] } = await db.query(
    `update workflows set name = $2, description = $3, definition = $4, version = version + 1, updated_at = now()
     where id = $1 returning version`,
    [workflowId, saved.name, saved.description, JSON.stringify(saved.definition)],
  );
  if (!row) return undefined;
  await db.query(
    `insert into workflow_versions (workspace_id, workflow_id, version, name, description, definition, note, restored_from, saved_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [workspaceId, workflowId, row.version, saved.name, saved.description, JSON.stringify(saved.definition), saved.note, saved.restoredFrom ?? null, actorId],
  );
  return row.version as number;
}

const validTimezone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const validCron = (cron: string, timezone: string) => {
  if (cron.trim().split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(cron, { tz: timezone });
    return true;
  } catch {
    return false;
  }
};

const readBody = (c: any) => c.req.json().catch(() => null);

/** The check on anything saved as a workflow, including an older version brought back. */
export async function checkWorkflowDefinition(pool: Pool, role: string, workspaceId: string, actorId: string, raw: unknown) {
  const directory = workspaceDirectory(pool, workspaceId, actorId);
  const definition = await checkSteps(raw, async (name) => !!(await directory.get(name)));
  if (!can(role, "connections:write")) {
    const links = [];
    for (const node of definition.nodes) {
      if (node.type === "connector") links.push({ connectionId: String(node.config.connectionId), action: String(node.config.action) });
      if (node.type === "agent") links.push(...((await directory.get(String(node.config.agent)))?.connections ?? []));
    }
    await assertMayReadMail(pool, workspaceId, links);
  }
  return definition;
}

/** Workflow, run, trigger, agent and settings routes for one workspace. */
export function addWorkflowRoutes(app: Hono<any>, { pool, engine, boss, env, requirePermission }: Deps) {
  const base = "/api/v1/workspaces/:workspaceId";
  const scoped = (c: any) => c.req.param("workspaceId") as string;
  const actor = (c: any) => c.get("user").id as string;
  const bad = (c: any, message: string) => c.json({ error: message }, 400);
  const missing = (c: any) => c.json({ error: "Not found." }, 404);
  /** Passes on the checks' own sentences. Anything from the database stays hidden and goes to the error handler. */
  const refused = (c: any, error: unknown) => {
    if (typeof (error as { code?: unknown }).code === "string") throw error;
    return bad(c, (error as Error).message);
  };

  const may = (c: any, permission: Permission) => can(c.get("role"), permission);
  /** One bad row must not take the whole list down, so an error that cannot be opened is left out. */
  const openError = (c: any, text: string | null) => {
    try {
      return unsealText(env.SECRETS_MASTER_KEY, scoped(c), text) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** A malformed id is simply not found, rather than a database error. */
  const validIds = async (c: any, next: () => Promise<void>) => {
    for (const name of ["workflowId", "runId", "triggerId"]) {
      const value = c.req.param(name);
      if (value !== undefined && !uuid.safeParse(value).success) return missing(c);
    }
    if (!/^\d{1,9}$/.test(c.req.param("version") ?? "1")) return missing(c);
    await next();
  };

  const checkDefinition = (c: any, workspaceId: string, actorId: string, raw: unknown) => checkWorkflowDefinition(pool, c.get("role"), workspaceId, actorId, raw);

  app.get("/api/v1/node-types", (c) => c.json({ nodeTypes: listNodeTypes() }));

  app.get(`${base}/settings`, requirePermission("content:read"), async (c) => {
    const { row, used } = await inWorkspace(pool, scoped(c), async (db) => ({
      row: (await db.query("select confidential_mode, monthly_token_limit, run_retention_days, redact_personal_data from workspace_settings where workspace_id = $1", [scoped(c)])).rows[0],
      used: (await db.query("select tokens from workspace_usage where month = date_trunc('month', now())")).rows[0]?.tokens ?? 0,
    }));
    return c.json({
      confidentialMode: row?.confidential_mode ?? true,
      monthlyTokenLimit: Number(row?.monthly_token_limit ?? 5_000_000),
      runRetentionDays: row?.run_retention_days ?? 90,
      redactPersonalData: row?.redact_personal_data ?? false,
      tokensUsedThisMonth: Number(used),
    });
  });

  app.put(`${base}/settings`, requirePermission("members:manage"), async (c) => {
    const body = z.object({
      confidentialMode: z.boolean().optional(),
      redactPersonalData: z.boolean().optional(),
      monthlyTokenLimit: z.number().int().min(0).max(1_000_000_000_000).optional(),
      runRetentionDays: z.number().int().min(1).max(3650).optional(),
    }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Check the settings values.");
    const workspaceId = scoped(c);
    const { confidentialMode, monthlyTokenLimit, runRetentionDays, redactPersonalData } = body.data;
    await inWorkspace(pool, workspaceId, async (db) => {
      await db.query(
        `insert into workspace_settings (workspace_id, confidential_mode, monthly_token_limit, run_retention_days, redact_personal_data)
         values ($1, coalesce($2, true), coalesce($3, 5000000), coalesce($4, 90), coalesce($5, false))
         on conflict (workspace_id) do update set
           confidential_mode = coalesce($2, workspace_settings.confidential_mode),
           monthly_token_limit = coalesce($3, workspace_settings.monthly_token_limit),
           run_retention_days = coalesce($4, workspace_settings.run_retention_days),
           redact_personal_data = coalesce($5, workspace_settings.redact_personal_data),
           updated_at = now()`,
        [workspaceId, confidentialMode ?? null, monthlyTokenLimit ?? null, runRetentionDays ?? null, redactPersonalData ?? null],
      );
      if (confidentialMode !== undefined) await recordAudit(db, { workspaceId, actorId: actor(c), action: "settings.confidential_mode", details: { on: confidentialMode } });
      if (monthlyTokenLimit !== undefined || runRetentionDays !== undefined) await recordAudit(db, { workspaceId, actorId: actor(c), action: "settings.limits", details: { monthlyTokenLimit, runRetentionDays } });
    });
    return c.json(body.data);
  });

  // One agent's off switch. Anyone who may approve work can stop an agent at once; turning it on again needs agents:write.
  app.put(`${base}/agents/:name/switch`, requirePermission("runs:approve"), async (c) => {
    const body = z.object({ on: z.boolean(), reason: z.string().trim().max(200).optional() }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Choose on or off, with a reason under 200 characters.");
    if (body.data.on && !may(c, "agents:write")) return c.json({ error: "Only someone who manages agents can turn one on again." }, 403);
    const name = c.req.param("name");
    if (!(await workspaceDirectory(pool, scoped(c), actor(c)).get(name))) return missing(c);
    const workspaceId = scoped(c);
    await inWorkspace(pool, workspaceId, async (db) => {
      if (body.data.on) await db.query("delete from agent_switches where agent_name = $1", [name]);
      else await db.query(
        `insert into agent_switches (workspace_id, agent_name, reason, turned_off_by) values ($1, $2, $3, $4)
         on conflict (workspace_id, agent_name) do update set reason = excluded.reason, turned_off_by = excluded.turned_off_by, turned_off_at = now()`,
        [workspaceId, name, body.data.reason || null, actor(c)],
      );
      await recordAudit(db, { workspaceId, actorId: actor(c), action: body.data.on ? "agent.turned_on" : "agent.turned_off", targetType: "agent", targetId: name, details: body.data.reason ? { reason: body.data.reason } : undefined });
    });
    return c.json({ on: body.data.on });
  });

  app.get(`${base}/agents`, requirePermission("content:read"), async (c) => {
    const agents = await workspaceDirectory(pool, scoped(c), actor(c)).list();
    const reserved = builtInAgents().map((a) => a.name);
    const switchedOff = new Map((await inWorkspace(pool, scoped(c), (db) => db.query("select agent_name, reason, turned_off_at from agent_switches"))).rows.map((row) => [row.agent_name, row]));
    const gates = await agentGate()?.states({ pool, masterKey: env.SECRETS_MASTER_KEY }, scoped(c));
    // Which workflows each agent really does a step in, so a person can go from one to the other.
    const usedBy = new Map<string, { id: string; name: string }[]>();
    for (const row of (await inWorkspace(pool, scoped(c), (db) => db.query("select id, name, definition from workflows order by name"))).rows) {
      for (const node of row.definition?.nodes ?? []) {
        if (node.type !== "agent" || typeof node.config?.agent !== "string") continue;
        const list = usedBy.get(node.config.agent) ?? [];
        if (!list.some((item) => item.id === row.id)) list.push({ id: row.id, name: row.name });
        usedBy.set(node.config.agent, list);
      }
    }
    return c.json({
      // An agent that makes agents is offered only to people who may make them.
      agents: agents.filter((agent) => may(c, "agents:write") || !agent.tools.includes("create_agent")).map((agent) => ({
        name: agent.name, description: agent.description, model: agent.model, tools: agent.tools, requiresApproval: agent.requiresApproval, builtIn: reserved.includes(agent.name),
        ...agentLooks(agent), workflows: usedBy.get(agent.name) ?? [], off: switchedOff.get(agent.name) ?? null, gate: gates?.get(agent.name) ?? null, knowledge: !!agent.knowledge, files: agent.server === "files", connected: (agent.connections?.length ?? 0) + (agent.mcp?.length ?? 0) > 0,
      })),
    });
  });

  app.post(`${base}/agents`, requirePermission("agents:write"), async (c) => {
    const workspaceId = scoped(c);
    const request = await readBody(c);
    try {
      if (!may(c, "connections:write")) await assertMayReadMail(pool, workspaceId, (request as { connections?: unknown })?.connections);
      const agent = await workspaceDirectory(pool, workspaceId, actor(c)).save(request);
      await inWorkspace(pool, workspaceId, (db) => recordAudit(db, { workspaceId, actorId: actor(c), action: "agent.created", targetType: "agent", targetId: agent.name, details: { tools: agent.tools } }));
      const { name, tools, requiresApproval } = buildAgent(request);
      return c.json({ name, tools, requiresApproval }, 201);
    } catch (error) {
      return refused(c, error);
    }
  });

  app.delete(`${base}/agents/:name`, requirePermission("agents:write"), async (c) => {
    const workspaceId = scoped(c);
    const name = c.req.param("name");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("delete from workspace_agents where name = $1", [name]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: "agent.deleted", targetType: "agent", targetId: name });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  app.get(`${base}/workflows`, requirePermission("content:read"), async (c) => {
    const query = (name: string) => c.req.query(name);
    const { limit, offset } = readPage(query, 200);
    const where = conditions();
    addSearch(where, "concat_ws(' ', w.name, w.description)", query("q"));
    addChoice(where, "(case when w.enabled then 'live' else 'draft' end)", query("status"), WORKFLOW_STATES);
    const order = orderBy(query, { name: "lower(w.name)", status: "w.enabled", version: "w.version", changed: "w.updated_at" }, "w.updated_at desc", "w.id");
    const found = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: [{ total }] } = await db.query(`select count(*)::int as total from workflows w ${where.where()}`, where.values);
      const { rows } = await db.query(
        `select w.id, w.name, w.description, w.version, w.enabled, w.updated_at, last.id as last_run_id, last.status as last_run_status, last.created_at as last_run_at
         from workflows w
         left join lateral (select r.id, r.status, r.created_at from runs r where r.workflow_id = w.id order by r.created_at desc limit 1) last on true
         ${where.where()} ${order} limit ${where.value(limit)} offset ${where.value(offset)}`,
        where.values,
      );
      return { workflows: rows, total };
    });
    return c.json(found);
  });

  app.post(`${base}/workflows`, requirePermission("workflows:write"), async (c) => {
    const body = workflowBody.safeParse(await readBody(c));
    if (!body.success) return bad(c, "Enter a workflow name and definition.");
    const workspaceId = scoped(c);
    try {
      const definition = await checkDefinition(c, workspaceId, actor(c), body.data.definition);
      const id = await inWorkspace(pool, workspaceId, (db) => insertWorkflow(db, workspaceId, actor(c), { ...body.data, definition }));
      return c.json({ id }, 201);
    } catch (error) {
      return refused(c, error);
    }
  });

  // A workflow from plain words. The draft is only shown; nothing is saved until a person creates it below.
  app.post(`${base}/workflows/draft`, requirePermission("workflows:write"), async (c) => {
    const body = z.object({ description: z.string().trim().min(10).max(4_000) }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Describe the workflow in a sentence or two.");
    if (!(await allow(pool, `run-start:${scoped(c)}`, LIMITS.runStart))) return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    try {
      return c.json({ draft: await draftWorkflow(pool, scoped(c), actor(c), body.data.description, env.SECRETS_MASTER_KEY) });
    } catch (error) {
      return refused(c, error);
    }
  });

  // Everything in a draft came back from the browser, so it is checked again here as if typed by hand.
  app.post(`${base}/workflows/from-draft`, requirePermission("workflows:write"), async (c) => {
    const body = z.object({
      name: z.string().trim().min(1).max(120),
      description: z.string().max(500).default(""),
      definition: z.unknown(),
      agent: z.record(z.string(), z.unknown()).optional(),
      recipient: z.email().max(200).optional(),
      schedule: z.object({ cron: z.string().min(9).max(100), timezone: z.string().max(64) }).optional(),
    }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Check the workflow, and the email address if there is one.");
    const workspaceId = scoped(c);
    const { name, description, agent, recipient, schedule } = body.data;
    if (agent && !may(c, "agents:write")) return c.json({ error: "Your role does not allow creating agents." }, 403);
    if (schedule && (!validTimezone(schedule.timezone) || !validCron(schedule.cron, schedule.timezone))) return bad(c, "That schedule is not valid.");
    let raw = JSON.stringify(body.data.definition ?? null);
    if (raw.includes("[[recipient]]")) {
      if (!recipient) return bad(c, "Enter who should receive it.");
      raw = raw.replaceAll("[[recipient]]", recipient);
    }
    let made: string | undefined;
    try {
      if (agent) {
        if (!may(c, "connections:write")) await assertMayReadMail(pool, workspaceId, (agent as { connections?: unknown }).connections);
        made = (await workspaceDirectory(pool, workspaceId, actor(c)).save(agent)).name;
        await inWorkspace(pool, workspaceId, (db) => recordAudit(db, { workspaceId, actorId: actor(c), action: "agent.created", targetType: "agent", targetId: made!, details: { from: "workflow draft" } }));
      }
      const definition = await checkDefinition(c, workspaceId, actor(c), JSON.parse(raw));
      const id = await inWorkspace(pool, workspaceId, async (db) => {
        const workflowId = await insertWorkflow(db, workspaceId, actor(c), { name, description, definition, note: "Drafted from a description." });
        if (schedule) {
          const { rows: [{ id: triggerId }] } = await db.query<{ id: string }>("select gen_random_uuid() as id");
          await db.query("insert into triggers (id, workspace_id, workflow_id, kind, cron, timezone, created_by) values ($1, $2, $3, 'schedule', $4, $5, $6)", [triggerId, workspaceId, workflowId, schedule.cron, schedule.timezone, actor(c)]);
          await boss.schedule(TRIGGER_QUEUE, schedule.cron, { workspaceId, triggerId }, { tz: schedule.timezone, key: triggerId });
          await recordAudit(db, { workspaceId, actorId: actor(c), action: "trigger.created", targetType: "trigger", targetId: triggerId, details: { kind: "schedule", workflowId } });
        }
        return workflowId;
      });
      return c.json({ id, agent: made }, 201);
    } catch (error) {
      // A workflow that could not be saved leaves no agent behind for it.
      if (made) await inWorkspace(pool, workspaceId, (db) => db.query("delete from workspace_agents where name = $1", [made])).catch(() => {});
      return refused(c, error);
    }
  });

  app.get(`${base}/workflows/:workflowId`, requirePermission("content:read"), validIds, async (c) => {
    const row = await inWorkspace(pool, scoped(c), async (db) =>
      (await db.query("select * from workflows where id = $1", [c.req.param("workflowId")])).rows[0]);
    return row ? c.json({ workflow: row }) : missing(c);
  });

  app.put(`${base}/workflows/:workflowId`, requirePermission("workflows:write"), validIds, async (c) => {
    const body = workflowBody.safeParse(await readBody(c));
    if (!body.success) return bad(c, "Enter a workflow name and definition.");
    const workspaceId = scoped(c);
    try {
      const definition = await checkDefinition(c, workspaceId, actor(c), body.data.definition);
      const version = await inWorkspace(pool, workspaceId, async (db) => {
        const saved = await saveVersion(db, workspaceId, c.req.param("workflowId"), actor(c), { ...body.data, definition });
        if (saved) await recordAudit(db, { workspaceId, actorId: actor(c), action: "workflow.updated", targetType: "workflow", targetId: c.req.param("workflowId"), details: { version: saved } });
        return saved;
      });
      return version ? c.json({ version }) : missing(c);
    } catch (error) {
      return refused(c, error);
    }
  });

  app.get(`${base}/workflows/:workflowId/versions`, requirePermission("content:read"), validIds, async (c) => {
    const id = c.req.param("workflowId");
    const all = await hasFeature(pool, scoped(c), "versionHistory");
    const found = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: [workflow] } = await db.query("select version from workflows where id = $1", [id]);
      if (!workflow) return undefined;
      // Definitions can be large, so the list leaves them out.
      const { rows } = await db.query(
        `select v.version, v.name, v.note, v.restored_from, v.saved_at, v.saved_by, u.name as saved_by_name,
                coalesce(jsonb_array_length(v.definition -> 'nodes'), 0) as steps
         from workflow_versions v left join "user" u on u.id = v.saved_by
         where v.workflow_id = $1 order by v.version desc limit $2`,
        [id, all ? VERSION_LIST : COMMUNITY_READABLE_VERSIONS],
      );
      return { current: workflow.version, versions: rows };
    });
    // Older versions stay stored, so a licence key brings them back.
    return found ? c.json({ ...found, keep: all ? KEEP_VERSIONS : COMMUNITY_READABLE_VERSIONS, locked: !all }) : missing(c);
  });

  app.get(`${base}/workflows/:workflowId/versions/:version`, requirePermission("content:read"), validIds, async (c) => {
    const all = await hasFeature(pool, scoped(c), "versionHistory");
    const { row, recent } = await inWorkspace(pool, scoped(c), async (db) => ({
      row: (await db.query("select version, name, description, definition, note, restored_from, saved_at from workflow_versions where workflow_id = $1 and version = $2", [c.req.param("workflowId"), c.req.param("version")])).rows[0],
      recent: all ? [] : (await db.query("select version from workflow_versions where workflow_id = $1 order by version desc limit $2", [c.req.param("workflowId"), COMMUNITY_READABLE_VERSIONS])).rows.map((item) => item.version as number),
    }));
    if (row && !all && !recent.includes(row.version)) throw oldVersionRefused();
    return row ? c.json({ version: row }) : missing(c);
  });

  app.delete(`${base}/workflows/:workflowId`, requirePermission("workflows:write"), validIds, async (c) => {
    const workspaceId = scoped(c);
    const id = c.req.param("workflowId");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows } = await db.query("select id, kind from triggers where workflow_id = $1 and kind <> 'webhook'", [id]);
      for (const trigger of rows) {
        const queue = timedQueue(trigger.kind);
        if (queue) await boss.unschedule(queue, trigger.id);
      }
      const { rowCount } = await db.query("delete from workflows where id = $1", [id]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: "workflow.deleted", targetType: "workflow", targetId: id });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  app.post(`${base}/workflows/:workflowId/enabled`, requirePermission("workflows:write"), validIds, async (c) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Choose whether the workflow is on.");
    const workspaceId = scoped(c);
    const id = c.req.param("workflowId");
    const changed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [before] } = await db.query("select enabled from workflows where id = $1 for update", [id]);
      const { rowCount } = await db.query("update workflows set enabled = $2, updated_at = now() where id = $1", [id, body.data.enabled]);
      if (before && !before.enabled && body.data.enabled) for (const item of triggerKinds()) await item.workflowEnabled?.(db, id);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: body.data.enabled ? "workflow.enabled" : "workflow.disabled", targetType: "workflow", targetId: id });
      return rowCount;
    });
    return changed ? c.json(body.data) : missing(c);
  });

  app.post(`${base}/workflows/:workflowId/runs`, requirePermission("runs:start"), validIds, async (c) => {
    if (!(await allow(pool, `run-start:${scoped(c)}`, LIMITS.runStart))) return c.json({ error: "Too many runs started. Try again in a minute." }, 429, { "retry-after": "60" });
    const body = await readBody(c);
    const runId = await engine.startRun({
      workspaceId: scoped(c), workflowId: c.req.param("workflowId"), input: body?.input ?? {},
      triggerKind: "manual", actorId: actor(c), requireEnabled: false,
    });
    return runId ? c.json({ runId }, 202) : missing(c);
  });

  app.get(`${base}/workflows/:workflowId/triggers`, requirePermission("content:read"), validIds, async (c) => {
    const id = c.req.param("workflowId");
    const rows = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: found } = await db.query(`select t.id, t.kind, t.cron, t.timezone, t.enabled, f.filter, coalesce(f.skipped_count, 0) as skipped_count, f.last_skipped_at, t.created_at
         from triggers t left join trigger_filters f on f.trigger_id = t.id where t.workflow_id = $1 order by t.created_at`, [id]);
      const details = await Promise.all(triggerKinds().map((item) => item.details?.(db, id)));
      return found.map((row) => Object.assign({}, row, ...details.map((map) => map?.get(row.id))));
    });
    return c.json({ triggers: rows });
  });

  app.post(`${base}/workflows/:workflowId/triggers`, requirePermission("workflows:write"), validIds, async (c) => {
    const sent = await readBody(c);
    const workspaceId = scoped(c);
    const added = triggerKind(sent?.kind);
    // A kind this install does not have is a paid one, and the refusal says so.
    if (sent?.kind === "email" && !added) await assertFeature(pool, workspaceId, "emailTriggers");
    const body = (added?.schema ?? triggerBody).safeParse(sent) as z.ZodSafeParseResult<any>;
    if (!body.success) return bad(c, "Choose a schedule, a webhook or a mailbox, and check its settings.");
    if (body.data.kind === "schedule" && !validTimezone(body.data.timezone)) return bad(c, "That time zone is not recognised.");
    if (body.data.kind === "schedule" && !validCron(body.data.cron, body.data.timezone)) return bad(c, "That schedule is not valid.");
    if (added?.manage && !may(c, added.manage.permission)) return c.json({ error: added.manage.refused }, 403);
    if (added) await assertFeature(pool, workspaceId, added.feature);
    const workflowId = c.req.param("workflowId");
    const trigger = body.data;
    try {
      const created = await inWorkspace(pool, workspaceId, async (db) => {
        const { rowCount } = await db.query("select 1 from workflows where id = $1", [workflowId]);
        if (!rowCount) return undefined;
        const { rows: [{ id }] } = await db.query<{ id: string }>("select gen_random_uuid() as id");
        let signingSecret: string | undefined;
        if (added) {
          await added.create(db, { id, workspaceId, workflowId, actorId: actor(c), body: trigger, env, boss });
        } else if (trigger.kind === "webhook") {
          signingSecret = randomBytes(32).toString("hex");
          const { ciphertext, iv, tag } = encryptSecret(env.SECRETS_MASTER_KEY, workspaceId, webhookSecretName(id), signingSecret);
          await db.query(
            `insert into triggers (id, workspace_id, workflow_id, kind, secret_ciphertext, secret_iv, secret_tag, created_by)
             values ($1, $2, $3, 'webhook', $4, $5, $6, $7)`,
            [id, workspaceId, workflowId, ciphertext, iv, tag, actor(c)],
          );
        } else {
          await db.query(
            "insert into triggers (id, workspace_id, workflow_id, kind, cron, timezone, created_by) values ($1, $2, $3, 'schedule', $4, $5, $6)",
            [id, workspaceId, workflowId, trigger.cron, trigger.timezone, actor(c)],
          );
          await boss.schedule(TRIGGER_QUEUE, trigger.cron, { workspaceId, triggerId: id }, { tz: trigger.timezone, key: id });
        }
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "trigger.created", targetType: "trigger", targetId: id, details: { kind: trigger.kind, workflowId } });
        return { id, signingSecret };
      });
      if (!created) return missing(c);
      // The signing secret is shown once, here, and stored encrypted.
      return c.json({ id: created.id, kind: trigger.kind, url: trigger.kind === "webhook" ? `${env.PUBLIC_URL}/hooks/${created.id}` : undefined, signingSecret: created.signingSecret }, 201);
    } catch (error) {
      return refused(c, error);
    }
  });

  // Only a schedule has settings worth changing. A webhook's address and secret stay as they were given out.
  app.put(`${base}/triggers/:triggerId`, requirePermission("workflows:write"), validIds, async (c) => {
    const body = z.object({ cron: z.string().trim().min(9).max(100), timezone: z.string().trim().min(1).max(64) }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Choose a schedule and a time zone.");
    if (!validTimezone(body.data.timezone)) return bad(c, "That time zone is not recognised.");
    if (!validCron(body.data.cron, body.data.timezone)) return bad(c, "That schedule is not valid.");
    const workspaceId = scoped(c);
    const id = c.req.param("triggerId");
    try {
      const updated = await inWorkspace(pool, workspaceId, async (db) => {
        const { rows: [row] } = await db.query("update triggers set cron = $2, timezone = $3 where id = $1 and kind = 'schedule' returning id", [id, body.data.cron, body.data.timezone]);
        if (!row) return false;
        await boss.unschedule(TRIGGER_QUEUE, id);
        await boss.schedule(TRIGGER_QUEUE, body.data.cron, { workspaceId, triggerId: id }, { tz: body.data.timezone, key: id });
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "trigger.updated", targetType: "trigger", targetId: id, details: { cron: body.data.cron, timezone: body.data.timezone } });
        return true;
      });
      return updated ? c.json({ saved: true }) : missing(c);
    } catch (error) {
      return refused(c, error);
    }
  });

  // A filter on what a trigger receives. Schedules send nothing to filter, so they cannot have one. null removes it.
  app.put(`${base}/triggers/:triggerId/filter`, requirePermission("workflows:write"), validIds, async (c) => {
    const sent = await readBody(c);
    const body = sent?.filter === null ? { success: true as const, data: null } : triggerFilter.safeParse(sent?.filter);
    if (!body.success) return bad(c, "Each condition needs a field, a check and, for most checks, a value. Up to 10 conditions.");
    const workspaceId = scoped(c);
    const id = c.req.param("triggerId");
    const saved = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [row] } = await db.query("select id from triggers where id = $1 and kind <> 'schedule'", [id]);
      if (!row) return undefined;
      if (body.data === null) await db.query("delete from trigger_filters where trigger_id = $1", [id]);
      else await db.query(
        `insert into trigger_filters (trigger_id, workspace_id, filter, updated_by) values ($1, $2, $3, $4)
         on conflict (trigger_id) do update set filter = excluded.filter, skipped_count = 0, last_skipped_at = null, updated_by = excluded.updated_by, updated_at = now()`,
        [id, workspaceId, JSON.stringify(body.data), actor(c)],
      );
      if (row) await recordAudit(db, { workspaceId, actorId: actor(c), action: "trigger.filter_saved", targetType: "trigger", targetId: id, details: { conditions: body.data?.conditions.length ?? 0 } });
      return row;
    });
    return saved ? c.json({ saved: true, filter: body.data }) : missing(c);
  });

  app.delete(`${base}/triggers/:triggerId`, requirePermission("workflows:write"), validIds, async (c) => {
    const workspaceId = scoped(c);
    const id = c.req.param("triggerId");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [found] } = await db.query("select kind from triggers where id = $1", [id]);
      const rule = triggerKind(found?.kind)?.manage;
      if (rule && !may(c, rule.permission)) return { refused: rule.refused };
      const { rows: [row] } = await db.query("delete from triggers where id = $1 returning kind", [id]);
      const queue = timedQueue(row?.kind);
      if (queue) await boss.unschedule(queue, id);
      if (row) await recordAudit(db, { workspaceId, actorId: actor(c), action: "trigger.deleted", targetType: "trigger", targetId: id });
      return row;
    });
    if (removed?.refused) return c.json({ error: removed.refused }, 403);
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  app.get(`${base}/pause`, requirePermission("content:read"), async (c) => {
    const pause = await inWorkspace(pool, scoped(c), async (db) => (await db.query("select paused_at, pause_reason from workspace_settings where workspace_id = $1", [scoped(c)])).rows[0]);
    return c.json({ paused: !!pause?.paused_at, pausedAt: pause?.paused_at ?? null, reason: pause?.pause_reason ?? null });
  });

  // Anyone who can approve can stop everything, as stopping is the safe direction. Starting again takes more.
  // These only stop work or let held work carry on, and an unpaid workspace must still be able to stop what it started.
  const whileReadOnly = { readOnlyRoute: true };
  const setPause = async (c: any, paused: boolean, reason: string | null) => {
    const workspaceId = scoped(c);
    const changed = await inWorkspace(pool, workspaceId, async (db) => {
      await db.query("insert into workspace_settings (workspace_id) values ($1) on conflict do nothing", [workspaceId]);
      const { rowCount } = await db.query(
        `update workspace_settings set paused_at = case when $2 then now() end, paused_by = case when $2 then $3 end, pause_reason = $4
         where workspace_id = $1 and (paused_at is not null) <> $2`,
        [workspaceId, paused, actor(c), reason],
      );
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: paused ? "workspace.paused" : "workspace.resumed", targetType: "workspace", targetId: workspaceId, details: reason ? { reason } : undefined });
      return !!rowCount;
    });
    return c.json({ paused, changed });
  };
  app.post(`${base}/pause`, requirePermission("runs:approve", whileReadOnly), async (c) => {
    const body = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "Keep the reason under 200 characters." }, 400);
    return setPause(c, true, body.data.reason || null);
  });
  app.post(`${base}/resume`, requirePermission("members:manage", whileReadOnly), (c) => setPause(c, false, null));

  app.get(`${base}/overview`, requirePermission("content:read"), async (c) => {
    const overview = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: [counts] } = await db.query(`
        select (select count(*)::int from workflows) as workflows,
               (select count(*)::int from workflows where enabled) as live_workflows,
               (select count(*)::int from connections) as connections,
               (select count(*)::int from runs where status in ('running', 'waiting')) as active_runs,
               (select count(*)::int from run_steps where status = 'waiting') as waiting_approvals,
               (select count(*)::int from runs where status = 'succeeded' and created_at > now() - interval '7 days') as succeeded_week,
               (select count(*)::int from runs where status = 'failed' and created_at > now() - interval '7 days') as failed_week,
               (select count(*)::int from agent_approvals where status = 'pending') as waiting_chats`);
      const { rows: daily } = await db.query(`
        select to_char(day, 'YYYY-MM-DD') as day,
               count(r.id) filter (where r.status = 'succeeded')::int as succeeded,
               count(r.id) filter (where r.status = 'failed')::int as failed
        from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') as day
        left join runs r on r.created_at >= day and r.created_at < day + interval '1 day'
        group by day order by day`);
      const { rows: recent } = await db.query("select id, workflow_name, trigger_kind, status, created_at, finished_at from runs order by created_at desc limit 8");
      // What is left to do on the first day, for the people who can do it. What exists says nothing about its contents.
      const setup = !may(c, "workflows:write") ? undefined : (await db.query(`
        select exists (select 1 from model_providers where enabled) as providers,
               exists (select 1 from model_providers m where m.enabled and (m.confidential_allowed or not coalesce((select s.confidential_mode from workspace_settings s), true))) as usable,
               exists (select 1 from connections) as connections,
               exists (select 1 from workspace_agents) or exists (select 1 from workflows) as work,
               exists (select 1 from runs) or exists (select 1 from agent_sessions) as ran`)).rows[0];
      const { providers, usable, ...rest } = setup ?? {};
      return { counts, daily, recent, setup: setup && { ...rest, models: usable || (!providers && serverModels()), modelNotCleared: providers && !usable } };
    });
    return c.json(overview);
  });

  app.get(`${base}/approvals`, requirePermission("content:read"), async (c) => {
    const { limit, offset } = readPage((name) => c.req.query(name), 100);
    const found = await inWorkspace(pool, scoped(c), async (db) => ({
      total: (await db.query("select count(*)::int as total from run_steps where status = 'waiting' and node_type = 'approval'")).rows[0].total as number,
      approvals: (await db.query(`
        select s.run_id, s.node_id, s.output, s.started_at, r.workflow_name, r.input, r.trigger_kind
        from run_steps s join runs r on r.id = s.run_id
        where s.status = 'waiting' and s.node_type = 'approval'
        order by s.started_at, s.id limit $1 offset $2`, [limit, offset])).rows,
      // Decided in the chat, where the arguments are shown, so these leave them out.
      chats: (await db.query(`
        select a.id, a.tool, a.created_at, s.id as session_id, s.agent_name, s.title
        from agent_approvals a join agent_sessions s on s.id = a.session_id
        where a.status = 'pending' order by a.created_at limit 50`)).rows,
    }));
    return c.json({ ...found, approvals: unseal(env.SECRETS_MASTER_KEY, scoped(c), found.approvals) });
  });

  app.get(`${base}/runs`, requirePermission("content:read"), async (c) => {
    const query = (name: string) => c.req.query(name);
    const { limit, offset } = readPage(query, 100);
    const where = conditions();
    // Names only: inputs, outputs and step errors are sealed, and the database cannot read them.
    addSearch(where, "r.workflow_name", query("q"));
    addChoice(where, "r.status", query("status"), RUN_STATUSES);
    addChoice(where, "r.trigger_kind", query("trigger"), RUN_TRIGGERS);
    addRange(where, "r.created_at", query("startedFrom"), query("startedTo"));
    if (uuid.safeParse(query("workflow")).success) where.add(`r.workflow_id = ${where.value(query("workflow"))}`);
    const order = orderBy(query, {
      workflow: "lower(r.workflow_name)", status: "r.status", trigger: "r.trigger_kind", started: "r.created_at", took: "(r.finished_at - r.created_at)",
    }, "r.created_at desc", "r.id");
    const { rows, total } = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: [{ total }] } = await db.query(`select count(*)::int as total from runs r ${where.where()}`, where.values);
      // The page is chosen first, so the joins below run for these rows alone and not for every run in the workspace.
      const { rows } = await db.query(
        `select r.*, used.cost_usd, used.tokens, failed.error as step_error
         from (
           select r.id, r.workflow_id, r.workflow_name, r.workflow_version, r.trigger_kind, r.status, r.error, r.confidential, r.created_at, r.finished_at, r.retried_as
           from runs r ${where.where()} ${order} limit ${where.value(limit)} offset ${where.value(offset)}
         ) r
         left join lateral (select sum(s.cost_usd) as cost_usd, coalesce(sum(s.input_tokens + s.output_tokens), 0)::bigint as tokens from spans s where s.trace_id = r.id) used on true
         left join lateral (select s.error from run_steps s where s.run_id = r.id and s.status = 'failed' order by s.finished_at desc nulls last limit 1) failed on r.status = 'failed'
         ${order}`,
        where.values,
      );
      return { rows, total };
    });
    // Whoever can read this list can open each run and read this same error, so it is opened for them here.
    const runs = rows.map(({ step_error, ...run }) => ({ ...run, failure: openError(c, step_error) ?? run.error }));
    return c.json({ runs, total });
  });

  app.get(`${base}/runs/:runId`, requirePermission("content:read"), validIds, async (c) => {
    const id = c.req.param("runId");
    const found = await inWorkspace(pool, scoped(c), async (db) => {
      const { rows: [run] } = await db.query("select * from runs where id = $1", [id]);
      if (!run) return undefined;
      const steps = (await db.query("select node_id, node_type, status, attempt, branch, output, error, decided_by, started_at, finished_at from run_steps where run_id = $1 order by started_at nulls last", [id])).rows;
      const events = (await db.query("select node_id, event, at from run_events where run_id = $1 order by id limit 1000", [id])).rows;
      const { rows: [used] } = await db.query("select sum(cost_usd) as cost_usd, coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens from spans where trace_id = $1", [id]);
      return { run, steps, events, used };
    });
    if (!found) return missing(c);
    // The definition is what a person typed, not sealed data, so a value shaped like a sealed one stays as it is.
    const { definition, ...run } = found.run;
    const opened = unseal(env.SECRETS_MASTER_KEY, scoped(c), { ...found, run });
    opened.run.definition = definition;
    for (const step of opened.steps) step.error = unsealText(env.SECRETS_MASTER_KEY, scoped(c), step.error);
    return c.json(opened);
  });

  /** What running this again would do. The source row is locked when the caller goes on to claim it. */
  const retryPlan = async (db: PoolClient, id: string, lock = false) => {
    const { rows: [run] } = await db.query(`select workflow_id, workflow_version, status, definition, retried_as from runs where id = $1 ${lock ? "for update" : ""}`, [id]);
    if (!run) return undefined;
    const { rows: effects } = await db.query("select node_id, status from run_effects where run_id = $1 order by created_at, node_id", [id]);
    const { rows: [workflow] } = await db.query("select version from workflows where id = $1", [run.workflow_id]);
    const label = (nodeId: string) => (run.definition as WorkflowDefinition).nodes.find((node) => node.id === nodeId)?.label || nodeId;
    return {
      status: run.status as string,
      retriedAs: run.retried_as as string | null,
      // A failed run is usually fixed in the Builder and then run again, so the workflow as saved now is what runs. Both versions are stated wherever this is offered.
      fromVersion: run.workflow_version as number,
      version: (workflow?.version ?? null) as number | null,
      // "started" means it was begun and never reported back, so it may or may not have happened.
      effects: effects.map(({ node_id: nodeId, status }) => ({ nodeId, label: label(nodeId), finished: status === "done" })),
    };
  };
  const retryRefusal = (plan: NonNullable<Awaited<ReturnType<typeof retryPlan>>>, repeatEffects: boolean) => {
    if (plan.status !== "failed" && plan.status !== "cancelled") return { error: "Only a failed or cancelled run can be run again." };
    if (plan.retriedAs) return { error: "This run has already been run again.", code: "already_retried", retriedAs: plan.retriedAs };
    if (plan.effects.length && !repeatEffects) return { error: "This run already changed something outside this app. Running it again repeats those actions.", code: "effects_would_repeat", effects: plan.effects };
    return undefined;
  };

  // What the page shows before asking.
  app.get(`${base}/runs/:runId/retry`, requirePermission("runs:start"), validIds, async (c) => {
    const plan = await inWorkspace(pool, scoped(c), (db) => retryPlan(db, c.req.param("runId")));
    return plan ? c.json(plan) : missing(c);
  });

  // A new run of the same input, once per run. It uses the workflow as saved now, and the failed run stays as it was.
  app.post(`${base}/runs/:runId/retry`, requirePermission("runs:start"), validIds, async (c) => {
    const workspaceId = scoped(c);
    const body = z.object({ repeatEffects: z.boolean().default(false) }).safeParse((await readBody(c)) ?? {});
    if (!body.success) return bad(c, "Say whether to repeat this run's actions.");
    const { repeatEffects } = body.data;
    if (!(await allow(pool, `run-start:${workspaceId}`, LIMITS.runStart))) return c.json({ error: "Too many runs started. Try again in a minute." }, 429, { "retry-after": "60" });
    const id = c.req.param("runId");
    const { rows: [run] } = await inWorkspace(pool, workspaceId, (db) => db.query("select workflow_id, input, confidential from runs where id = $1", [id]));
    if (!run) return missing(c);
    const newRunId = randomUUID();
    let refusal: ReturnType<typeof retryRefusal>;
    const runId = run.workflow_id && await engine.startRun({
      workspaceId, workflowId: run.workflow_id, input: unseal(env.SECRETS_MASTER_KEY, workspaceId, run.input), triggerKind: "manual", actorId: actor(c), requireEnabled: false,
      runId: newRunId, keepConfidential: run.confidential,
      // Asked again here, holding the source row, so of two at once only one starts, and an action a late step recorded still counts.
      claim: async (db) => {
        const plan = (await retryPlan(db, id, true))!;
        refusal = retryRefusal(plan, repeatEffects);
        if (refusal) return false;
        await db.query("update runs set retried_as = $2 where id = $1", [id, newRunId]);
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "run.retried", targetType: "run", targetId: newRunId, details: { from: id, fromVersion: plan.fromVersion, version: plan.version, repeatEffects: plan.effects.length > 0, effects: plan.effects.map(({ nodeId }) => nodeId) } });
        return true;
      },
    });
    if (refusal) return c.json(refusal, 409);
    if (!runId) return c.json({ error: "This run's workflow was deleted, so it cannot run again." }, 409);
    return c.json({ runId }, 202);
  });

  app.post(`${base}/runs/:runId/cancel`, requirePermission("runs:start", whileReadOnly), validIds, async (c) =>
    (await engine.cancel(scoped(c), c.req.param("runId"), actor(c))) ? c.json({ cancelled: true }) : c.json({ error: "This run has already ended." }, 409));

  app.post(`${base}/runs/:runId/steps/:nodeId/decision`, requirePermission("runs:approve"), validIds, async (c) => {
    const body = z.object({ approved: z.boolean() }).safeParse(await readBody(c));
    if (!body.success) return bad(c, "Choose approve or decline.");
    const done = await engine.decide(scoped(c), c.req.param("runId"), c.req.param("nodeId"), body.data.approved, actor(c));
    return done ? c.json({ decided: true }) : c.json({ error: "Nothing is waiting for this decision." }, 409);
  });
}

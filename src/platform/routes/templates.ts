import type { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import { recordAudit } from "../audit-log.ts";
import { inWorkspace } from "../db.ts";
import { hostedMode } from "../../config.ts";
import { getConnector, MAIL_READ_REFUSED } from "../connectors/types.ts";
import { assertConnector, connectorEdition, connectorLabel, connectorLocked, hasFeature } from "../limits.ts";
import { can, type Permission } from "../permissions.ts";
import type { Edition } from "../plans.ts";
import { allow, LIMITS } from "../rate-limit.ts";
import { outsideChanges, stepChanges } from "../templates/analysis.ts";
import { customEdit, customRowId, customTemplate, editProblem, MAX_CUSTOM_TEMPLATES, type CustomRow } from "../templates/custom.ts";
import { getTemplate, templates } from "../templates/index.ts";
import { installTemplate } from "../templates/install.ts";
import { CATEGORIES, type Template } from "../templates/types.ts";

interface Deps {
  pool: Pool;
  requirePermission: (permission: Permission) => any;
}

const installBody = z.object({
  answers: z.record(z.string(), z.unknown()).default({}),
  connections: z.record(z.string(), z.string().max(64)).default({}),
});

const needed = (template: Template): Permission[] => [...(template.agent ? ["agents:write" as const] : []), ...(template.workflow ? ["workflows:write" as const] : [])];

/** Connector steps and agent tools alike. */
function readsMailbox(template: Template) {
  const uses = (key: string, action: string) => !!getConnector(template.connections.find((slot) => slot.key === key)?.connector ?? "")?.actions[action]?.readsMail;
  return (template.agent?.tools ?? []).some(([key, action]) => uses(key, action))
    || (template.workflow?.steps ?? []).some((step) => step.type === "connector" && uses(step.slot, step.action));
}

const paidConnectors = (template: Template, edition: Edition | undefined) => [...new Set(template.connections.map((item) => item.connector))].filter((name) => connectorLocked(edition, name));

const summary = (template: Template, edition?: Edition) => ({
  id: template.id, name: template.name, outcome: template.outcome, category: template.category, categoryLabel: CATEGORIES[template.category],
  role: template.role, difficulty: template.difficulty, runKind: template.run.kind,
  builds: template.agent && template.workflow ? "agent and workflow" : template.workflow ? "workflow" : "agent",
  connectors: [...new Set(template.connections.map((item) => item.connector))].map((name) => ({ name, label: connectorLabel(name) })),
  approvalCount: outsideChanges(template).length,
  usesFileTools: !!template.agent?.files?.length,
  custom: template.custom,
  /** Paid connectors it needs that this edition leaves out. Always empty in hosted mode. */
  needsUpgrade: paidConnectors(template, edition).map(connectorLabel),
});

/** What a person reads before installing. Worked out from the definitions, so it cannot drift from what runs. */
const detail = (template: Template, edition?: Edition) => ({
  ...summary(template, edition),
  description: template.description,
  run: template.run,
  questions: template.questions,
  connections: template.connections.map(({ key, connector, purpose }) => ({ key, connector, label: connectorLabel(connector), purpose })),
  changes: outsideChanges(template).map(({ connector, label, guard }) => ({ connector: connector === "files" ? "Workspace files" : connectorLabel(connector), label, guard })),
  agent: template.agent && { name: template.agent.name, description: template.agent.description, instructions: template.agent.instructions, usesDocuments: !!template.agent.knowledge },
  steps: template.workflow?.steps.map((step) => ({
    id: step.id, type: step.type, label: step.label,
    changes: step.type === "connector" && stepChanges(template, step),
    connector: step.type === "connector" ? connectorLabel(template.connections.find((item) => item.key === step.slot)?.connector ?? "") : undefined,
  })),
  /** The words a person may change in their own copy. */
  editable: {
    prompts: (template.workflow?.steps ?? []).flatMap((step) => (step.type === "agent" ? [{ id: step.id, label: step.label, prompt: step.prompt }] : [])),
  },
});

export function addTemplateRoutes(app: Hono<any>, { pool, requirePermission }: Deps) {
  const base = "/api/v1/workspaces/:workspaceId/templates";
  const scoped = (c: any) => c.req.param("workspaceId") as string;
  const COLUMNS = "id, base_template_id, name, outcome, description, instructions, prompts, cron";
  const fromRow = (row: CustomRow) => {
    const original = getTemplate(row.base_template_id);
    return original && customTemplate(original, row);
  };
  const saved = (workspaceId: string) => inWorkspace(pool, workspaceId, async (db) => (await db.query<CustomRow>(`select ${COLUMNS} from workspace_templates order by name`)).rows);
  /** A template in the code, or this workspace's own copy of one. Row security keeps other workspaces' copies out. */
  const find = async (workspaceId: string, templateId: string) => {
    const rowId = customRowId(templateId);
    if (!rowId) return getTemplate(templateId);
    const row = await inWorkspace(pool, workspaceId, async (db) => (await db.query<CustomRow>(`select ${COLUMNS} from workspace_templates where id = $1`, [rowId])).rows[0]);
    return row && fromRow(row);
  };
  const maySave = (c: any, template: Template) => !needed(template).some((permission) => !can(c.get("role"), permission));
  const readEdit = async (c: any, original: Template) => {
    const body = customEdit.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const field = body.error.issues[0]?.path[0];
      const words: Record<string, string> = {
        name: "Use a name of 3 to 80 characters.", outcome: "Describe what a person gets in one line of 20 to 160 characters.", description: "Describe what it does in 20 to 1,000 characters.",
        instructions: "Agent instructions must be 200 to 6,000 characters.", prompts: "A step's prompt cannot be empty.",
      };
      return { problem: words[String(field)] ?? "Check the template." };
    }
    if (templates.some((template) => template.name.toLowerCase() === body.data.name.toLowerCase())) return { problem: "A standard template already has that name." };
    const problem = editProblem(original, body.data);
    return problem ? { problem } : { edit: body.data };
  };
  const nameTaken = (error: unknown) => (error as { code?: string }).code === "23505";

  app.get(base, requirePermission("content:read"), async (c) => {
    const edition = await connectorEdition(pool);
    const own = (await saved(scoped(c))).flatMap((row) => fromRow(row) ?? []);
    return c.json({
      categories: Object.entries(CATEGORIES).map(([id, label]) => ({ id, label })),
      roles: [...new Set([...own, ...templates].map((template) => template.role))].sort(),
      templates: [...own, ...templates].map((template) => summary(template, edition)),
    });
  });

  // Each saved copy starts from a template in the code, and a copy of a copy starts from that same original.
  app.post(`${base}/:templateId/customise`, requirePermission("content:read"), async (c: any) => {
    const template = await find(scoped(c), c.req.param("templateId"));
    if (!template) return c.json({ error: "Not found." }, 404);
    if (!maySave(c, template)) return c.json({ error: "Your role does not allow this." }, 403);
    const original = getTemplate(template.custom?.baseId ?? template.id)!;
    const { edit, problem } = await readEdit(c, original);
    if (!edit) return c.json({ error: problem }, 400);
    try {
      const id = await inWorkspace(pool, scoped(c), async (db) => {
        const { rows: [{ count }] } = await db.query<{ count: number }>("select count(*)::int from workspace_templates");
        if (count! >= MAX_CUSTOM_TEMPLATES) throw new Error("This workspace has too many saved templates. Delete one first.");
        const { rows: [row] } = await db.query<{ id: string }>(
          "insert into workspace_templates (workspace_id, base_template_id, name, outcome, description, instructions, prompts, cron, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
          [scoped(c), original.id, edit.name, edit.outcome, edit.description, edit.instructions ?? null, JSON.stringify(edit.prompts), edit.cron ?? null, c.get("user").id],
        );
        await recordAudit(db, { workspaceId: scoped(c), actorId: c.get("user").id, action: "template.saved", targetType: "template", targetId: row!.id, details: { from: original.id } });
        return row!.id;
      });
      return c.json({ id: `custom-${id}` }, 201);
    } catch (error) {
      if (nameTaken(error)) return c.json({ error: "You already have a template with that name." }, 409);
      if (typeof (error as { code?: unknown }).code === "string") throw error;
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.put(`${base}/:templateId`, requirePermission("content:read"), async (c: any) => {
    const rowId = customRowId(c.req.param("templateId"));
    const template = rowId && await find(scoped(c), c.req.param("templateId"));
    if (!template) return c.json({ error: "Not found." }, 404);
    if (!maySave(c, template)) return c.json({ error: "Your role does not allow this." }, 403);
    const { edit, problem } = await readEdit(c, getTemplate(template.custom!.baseId)!);
    if (!edit) return c.json({ error: problem }, 400);
    try {
      await inWorkspace(pool, scoped(c), async (db) => {
        await db.query(
          "update workspace_templates set name = $2, outcome = $3, description = $4, instructions = $5, prompts = $6, cron = $7, updated_at = now() where id = $1",
          [rowId, edit.name, edit.outcome, edit.description, edit.instructions ?? null, JSON.stringify(edit.prompts), edit.cron ?? null],
        );
        await recordAudit(db, { workspaceId: scoped(c), actorId: c.get("user").id, action: "template.updated", targetType: "template", targetId: rowId, details: {} });
      });
      return c.json({ saved: true });
    } catch (error) {
      if (nameTaken(error)) return c.json({ error: "You already have a template with that name." }, 409);
      throw error;
    }
  });

  app.delete(`${base}/:templateId`, requirePermission("content:read"), async (c: any) => {
    const rowId = customRowId(c.req.param("templateId"));
    const template = rowId && await find(scoped(c), c.req.param("templateId"));
    if (!template) return c.json({ error: "Not found." }, 404);
    if (!maySave(c, template)) return c.json({ error: "Your role does not allow this." }, 403);
    await inWorkspace(pool, scoped(c), async (db) => {
      await db.query("delete from workspace_templates where id = $1", [rowId]);
      await recordAudit(db, { workspaceId: scoped(c), actorId: c.get("user").id, action: "template.deleted", targetType: "template", targetId: rowId!, details: {} });
    });
    return c.json({ deleted: true });
  });

  app.get(`${base}/:templateId`, requirePermission("content:read"), async (c) => {
    const template = await find(scoped(c), c.req.param("templateId"));
    if (!template) return c.json({ error: "Not found." }, 404);
    // Such a template still installs, but its mailbox trigger cannot be added, so the screen says so first.
    const mailTriggerLocked = template.run.kind === "email" && !(await hasFeature(pool, scoped(c), "emailTriggers"));
    return c.json({ template: { ...detail(template, await connectorEdition(pool)), mailTriggerLocked } });
  });

  // Each template needs its own rights, so membership is checked first and the rest here.
  app.post(`${base}/:templateId/install`, requirePermission("content:read"), async (c: any) => {
    const template = await find(scoped(c), c.req.param("templateId"));
    if (!template) return c.json({ error: "Not found." }, 404);
    if (needed(template).some((permission) => !can(c.get("role"), permission))) return c.json({ error: "Your role does not allow this." }, 403);
    if (readsMailbox(template) && !can(c.get("role"), "connections:write")) return c.json({ error: MAIL_READ_REFUSED }, 403);
    if (hostedMode() && template.agent?.files?.length) return c.json({ error: "This template uses file tools, which the hosted version does not offer." }, 400);
    for (const { connector } of template.connections) await assertConnector(pool, connector);
    const body = installBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Check the setup answers." }, 400);
    if (!(await allow(pool, `template-install:${scoped(c)}`, LIMITS.templateInstall))) return c.json({ error: "Too many installs. Try again in a minute." }, 429, { "retry-after": "60" });
    try {
      return c.json(await installTemplate(pool, scoped(c), c.get("user").id, template, body.data), 201);
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === "string") throw error;
      return c.json({ error: (error as Error).message }, 400);
    }
  });
}

import type { Hono } from "hono";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { recordAudit } from "../audit-log.ts";
import { inWorkspace } from "../db.ts";
import type { PlatformEnv } from "../env.ts";
import type { Permission } from "../permissions.ts";
import { addChoice, addSearch, conditions, orderBy, readPage } from "../paging.ts";
import { unseal } from "../secrets.ts";
import { MAX_NOTES, NOTE_LENGTH, sealedNote } from "../company-memory.ts";
import { metricsAllowed, metricsText } from "./health.ts";

interface Deps {
  pool: Pool;
  env: PlatformEnv;
  boss?: PgBoss;
  requirePermission: (permission: Permission) => any;
}

/** Agents and models a workspace has used. Far more than one has, and the page says so if this is ever reached. */
const GROUP_LIMIT = 500;

export function addObservabilityRoutes(app: Hono<any>, { pool, env, boss, requirePermission }: Deps) {
  const base = "/api/v1/workspaces/:workspaceId";
  const scoped = (c: any) => c.req.param("workspaceId") as string;
  const actor = (c: any) => c.get("user").id as string;
  const uuid = z.uuid();
  const slug = z.string().regex(/^[a-z][a-z0-9-]{2,39}$/);
  const missing = (c: any) => c.json({ error: "Not found." }, 404);

  app.get("/metrics", async (c) => {
    if (!metricsAllowed(env.METRICS_TOKEN, c.req.header("authorization"))) return missing(c);
    return c.text(await metricsText(pool, boss), 200, { "content-type": "text/plain; version=0.0.4" });
  });

  app.get(`${base}/observability`, requirePermission("content:read"), async (c) => {
    const days = z.coerce.number().int().min(1).max(90).catch(7).parse(c.req.query("days"));
    const report = await inWorkspace(pool, scoped(c), async (db) => {
      const window = "at > now() - make_interval(days => $1)";
      const { rows: [totals] } = await db.query(`
        select count(*) filter (where kind = 'model')::int as model_calls,
               count(*) filter (where kind = 'model' and status = 'error')::int as model_errors,
               count(*) filter (where kind = 'tool')::int as tool_calls,
               count(*) filter (where kind = 'tool' and status = 'error')::int as tool_errors,
               count(*) filter (where kind = 'tool' and status = 'refused')::int as tool_refused,
               count(*) filter (where kind = 'guardrail')::int as guardrail_hits,
               count(*) filter (where kind = 'tool' and risk >= 0.7)::int as risky_calls,
               coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens,
               sum(cost_usd) as cost_usd,
               count(*) filter (where kind = 'model' and cost_usd is null)::int as unpriced_calls,
               percentile_disc(0.5) within group (order by duration_ms) filter (where kind = 'model') as model_p50,
               percentile_disc(0.95) within group (order by duration_ms) filter (where kind = 'model') as model_p95
        from spans where ${window}`, [days]);
      const { rows: daily } = await db.query(`
        select to_char(day, 'YYYY-MM-DD') as day, coalesce(sum(s.input_tokens + s.output_tokens), 0)::bigint as tokens, count(s.id) filter (where s.status = 'error')::int as errors
        from generate_series(date_trunc('day', now()) - make_interval(days => $1 - 1), date_trunc('day', now()), interval '1 day') as day
        left join spans s on s.at >= day and s.at < day + interval '1 day'
        group by day order by day`, [days]);
      const { rows: agents } = await db.query(`
        select agent, count(*) filter (where kind = 'model')::int as model_calls, count(*) filter (where kind = 'tool')::int as tool_calls,
               count(*) filter (where status = 'error')::int as errors, coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens, sum(cost_usd) as cost_usd,
               percentile_disc(0.95) within group (order by duration_ms) filter (where kind = 'model') as model_p95
        from spans where ${window} and agent is not null group by agent order by tokens desc limit ${GROUP_LIMIT}`, [days]);
      const { rows: models } = await db.query(`
        select name, count(*)::int as calls, count(*) filter (where status = 'error')::int as errors, coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens, sum(cost_usd) as cost_usd,
               percentile_disc(0.5) within group (order by duration_ms) as p50, percentile_disc(0.95) within group (order by duration_ms) as p95
        from spans where ${window} and kind = 'model' group by name order by calls desc limit ${GROUP_LIMIT}`, [days]);
      const { rows: risky } = await db.query(`
        select trace_id, trace_kind, name, agent, status, risk, at from spans where ${window} and kind = 'tool' and (risk >= 0.7 or status <> 'ok') order by at desc limit 20`, [days]);
      return { days, totals, daily, agents, models, risky, groupLimit: GROUP_LIMIT };
    });
    return c.json(report);
  });

  // The calls behind "Tool calls to look at". Measurements only, like the rest of this report.
  app.get(`${base}/observability/calls`, requirePermission("content:read"), async (c) => {
    const query = (name: string) => c.req.query(name);
    const days = z.coerce.number().int().min(1).max(90).catch(7).parse(query("days"));
    const { limit, offset } = readPage(query, 25);
    const where = conditions();
    where.add(`at > now() - make_interval(days => ${where.value(days)})`);
    where.add("kind = 'tool' and (risk >= 0.7 or status <> 'ok')");
    addSearch(where, "concat_ws(' ', name, agent)", query("q"));
    addChoice(where, "status", query("result"), ["ok", "error", "refused"]);
    const order = orderBy(query, { when: "at", risk: "risk", tool: "name", agent: "agent", result: "status" }, "at desc", "id");
    const found = await inWorkspace(pool, scoped(c), async (db) => ({
      total: (await db.query(`select count(*)::int as total from spans ${where.where()}`, where.values)).rows[0].total as number,
      calls: (await db.query(`select id, trace_id, trace_kind, name, agent, status, risk, at from spans ${where.where()} ${order} limit ${where.value(limit)} offset ${where.value(offset)}`, where.values)).rows,
    }));
    return c.json(found);
  });

  app.get(`${base}/traces/:traceId`, requirePermission("content:read"), async (c) => {
    if (!uuid.safeParse(c.req.param("traceId")).success) return missing(c);
    const id = c.req.param("traceId");
    const { limit, offset } = readPage((name) => c.req.query(name), 1000, 1000);
    const found = await inWorkspace(pool, scoped(c), async (db) => ({
      // Over the whole trace, so a long one does not read as short.
      summary: (await db.query(`select count(*)::int as steps, coalesce(sum(input_tokens + output_tokens), 0)::bigint as tokens, sum(cost_usd) as cost_usd, min(at - make_interval(secs => coalesce(duration_ms, 0) / 1000.0)) as started, max(at) as finished from spans where trace_id = $1`, [id])).rows[0],
      spans: (await db.query("select id, trace_kind, kind, name, agent, status, duration_ms, input_tokens, output_tokens, cost_usd, risk, at from spans where trace_id = $1 order by id limit $2 offset $3", [id, limit, offset])).rows,
    }));
    return c.json(found);
  });

  app.get(`${base}/skills`, requirePermission("content:read"), async (c) => {
    const rows = await inWorkspace(pool, scoped(c), async (db) => (await db.query("select name, description, instructions, created_at from agent_skills order by name")).rows);
    return c.json({ skills: rows });
  });

  app.put(`${base}/skills/:name`, requirePermission("agents:write"), async (c) => {
    const name = slug.safeParse(c.req.param("name"));
    const body = z.object({ description: z.string().trim().min(1).max(300), instructions: z.string().trim().min(1).max(8_000) }).safeParse(await c.req.json().catch(() => null));
    if (!name.success || !body.success) return c.json({ error: "Enter a name in lowercase words, a description and instructions." }, 400);
    const workspaceId = scoped(c);
    await inWorkspace(pool, workspaceId, async (db) => {
      await db.query(
        `insert into agent_skills (workspace_id, name, description, instructions, created_by) values ($1, $2, $3, $4, $5)
         on conflict (workspace_id, name) do update set description = excluded.description, instructions = excluded.instructions`,
        [workspaceId, name.data, body.data.description, body.data.instructions, actor(c)],
      );
      await recordAudit(db, { workspaceId, actorId: actor(c), action: "skill.saved", targetType: "skill", targetId: name.data });
    });
    return c.json({ name: name.data });
  });

  app.delete(`${base}/skills/:name`, requirePermission("agents:write"), async (c) => {
    const workspaceId = scoped(c);
    const name = c.req.param("name");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("delete from agent_skills where name = $1", [name]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: "skill.deleted", targetType: "skill", targetId: name });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  app.get(`${base}/agents/:name/memories`, requirePermission("content:read"), async (c) => {
    const { limit, offset } = readPage((name) => c.req.query(name), 200);
    const { rows, total } = await inWorkspace(pool, scoped(c), async (db) => ({
      total: (await db.query("select count(*)::int as total from agent_memories where agent_name = $1", [c.req.param("name")])).rows[0].total as number,
      rows: (await db.query("select id, content, created_at from agent_memories where agent_name = $1 order by created_at desc, id limit $2 offset $3", [c.req.param("name"), limit, offset])).rows,
    }));
    return c.json({ memories: unseal(env.SECRETS_MASTER_KEY, scoped(c), rows), total });
  });

  app.delete(`${base}/agents/:name/memories/:memoryId`, requirePermission("agents:write"), async (c) => {
    if (!uuid.safeParse(c.req.param("memoryId")).success) return missing(c);
    const workspaceId = scoped(c);
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("delete from agent_memories where id = $1 and agent_name = $2", [c.req.param("memoryId"), c.req.param("name")]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: "memory.deleted", targetType: "agent", targetId: c.req.param("name") });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  // Company memory: notes every agent reads. Suggestions from agents are listed too, and do nothing until accepted.
  const noteText = z.object({ content: z.string().trim().min(5).max(NOTE_LENGTH) });
  const noteRefused = "Write the note in 5 to 1,000 characters.";

  app.get(`${base}/company-notes`, requirePermission("content:read"), async (c) => {
    const rows = await inWorkspace(pool, scoped(c), async (db) => (await db.query(
      "select id, content, status, suggested_by_agent, created_by, created_at, updated_at from company_notes order by status desc, created_at, id",
    )).rows);
    return c.json({ notes: unseal(env.SECRETS_MASTER_KEY, scoped(c), rows), limit: MAX_NOTES });
  });

  app.post(`${base}/company-notes`, requirePermission("agents:write"), async (c) => {
    const body = noteText.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: noteRefused }, 400);
    const workspaceId = scoped(c);
    const created = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [{ total }] } = await db.query("select count(*)::int as total from company_notes where status = 'active'");
      if (total >= MAX_NOTES) return undefined;
      const { rows: [row] } = await db.query(
        "insert into company_notes (workspace_id, content, created_by) values ($1, $2, $3) returning id",
        [workspaceId, sealedNote(env.SECRETS_MASTER_KEY, workspaceId, body.data.content), actor(c)],
      );
      await recordAudit(db, { workspaceId, actorId: actor(c), action: "company_note.added", targetType: "company_note", targetId: row.id });
      return row;
    });
    return created ? c.json({ id: created.id }, 201) : c.json({ error: `Company memory holds up to ${MAX_NOTES} notes. Remove one first.` }, 409);
  });

  // Saving a suggestion, edited or not, accepts it.
  app.put(`${base}/company-notes/:noteId`, requirePermission("agents:write"), async (c) => {
    if (!uuid.safeParse(c.req.param("noteId")).success) return missing(c);
    const body = noteText.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: noteRefused }, 400);
    const workspaceId = scoped(c);
    const saved = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [before] } = await db.query("select status from company_notes where id = $1", [c.req.param("noteId")]);
      if (!before) return undefined;
      if (before.status === "suggested") {
        const { rows: [{ total }] } = await db.query("select count(*)::int as total from company_notes where status = 'active'");
        if (total >= MAX_NOTES) return { full: true };
      }
      await db.query(
        "update company_notes set content = $2, status = 'active', created_by = coalesce(created_by, $3), updated_at = now() where id = $1",
        [c.req.param("noteId"), sealedNote(env.SECRETS_MASTER_KEY, workspaceId, body.data.content), actor(c)],
      );
      const action = before.status === "suggested" ? "company_note.accepted" : "company_note.updated";
      await recordAudit(db, { workspaceId, actorId: actor(c), action, targetType: "company_note", targetId: c.req.param("noteId") });
      return { full: false };
    });
    if (!saved) return missing(c);
    return saved.full ? c.json({ error: `Company memory holds up to ${MAX_NOTES} notes. Remove one first.` }, 409) : c.json({ saved: true });
  });

  app.delete(`${base}/company-notes/:noteId`, requirePermission("agents:write"), async (c) => {
    if (!uuid.safeParse(c.req.param("noteId")).success) return missing(c);
    const workspaceId = scoped(c);
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [row] } = await db.query("delete from company_notes where id = $1 returning status", [c.req.param("noteId")]);
      if (row) await recordAudit(db, { workspaceId, actorId: actor(c), action: row.status === "suggested" ? "company_note.declined" : "company_note.removed", targetType: "company_note", targetId: c.req.param("noteId") });
      return row;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });
}

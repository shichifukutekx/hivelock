import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import { checkModel } from "../../check-models.ts";
import { modelChain } from "../../config.ts";
import { recordAudit } from "../audit-log.ts";
import { inWorkspace } from "../db.ts";
import type { PlatformEnv } from "../env.ts";
import { completeProvider, discoverModels, explainConnection, guardedModelFetch, keyOf, modelNetwork, PROVIDER_PRESETS, providerBody, providerRow, sealKey, serverModels, targetOf } from "../model-providers.ts";
import type { Permission } from "../permissions.ts";
import { plainError, serviceProblem } from "../plain-errors.ts";

interface Deps {
  pool: Pool;
  env: PlatformEnv;
  requirePermission: (permission: Permission) => any;
}

const uuid = z.uuid();

/** What the screen sees. The key itself never leaves the server. */
const shown = (row: any) => ({
  id: row.id, name: row.name, preset: row.preset, baseUrl: row.base_url, hasKey: !!row.key_ciphertext, models: row.models,
  extraBody: row.extra_body, enabled: row.enabled, confidentialAllowed: row.confidential_allowed, priority: row.priority,
  inputPrice: row.input_price === null ? null : Number(row.input_price), outputPrice: row.output_price === null ? null : Number(row.output_price),
});

export function addModelRoutes(app: Hono<any>, { pool, env, requirePermission }: Deps) {
  const base = "/api/v1/workspaces/:workspaceId/model-providers";
  const scoped = (c: any) => c.req.param("workspaceId") as string;
  const actor = (c: any) => c.get("user").id as string;
  const missing = (c: any) => c.json({ error: "Not found." }, 404);
  const validId = async (c: any, next: () => Promise<void>) => {
    if (!uuid.safeParse(c.req.param("providerId")).success) return missing(c);
    await next();
  };
  const unique = (c: any, error: unknown) => {
    if ((error as { code?: string }).code === "23505") return c.json({ error: "A provider with that name already exists." }, 400);
    throw error;
  };

  app.get(base, requirePermission("connections:list"), async (c) => {
    const rows = await inWorkspace(pool, scoped(c), async (db) => (await db.query("select * from model_providers order by priority, created_at")).rows);
    return c.json({
      presets: env.HOSTED_MODE ? PROVIDER_PRESETS.filter((preset) => !preset.local) : PROVIDER_PRESETS,
      providers: rows.map(shown),
      usingServerDefaults: rows.length === 0 && serverModels(),
      anyAddress: modelNetwork().anyAddress,
    });
  });

  app.post(base, requirePermission("connections:write"), async (c) => {
    const parsed = providerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `Check the ${parsed.error.issues[0]!.path.join(".")} field.` }, 400);
    const workspaceId = scoped(c);
    const id = randomUUID();
    const filled = await completeProvider(parsed.data, parsed.data.apiKey).catch((error: Error) => error);
    if (filled instanceof Error) return c.json({ error: filled.message }, 400);
    const { name, preset, baseUrl, apiKey, models, extraBody, enabled, confidentialAllowed, inputPrice, outputPrice } = filled;
    const key = apiKey ? sealKey(env.SECRETS_MASTER_KEY, workspaceId, id, apiKey) : undefined;
    try {
      await inWorkspace(pool, workspaceId, async (db) => {
        const { rows: [order] } = await db.query("select coalesce(max(priority), 0) + 10 as next from model_providers");
        await db.query(
          `insert into model_providers (id, workspace_id, name, preset, base_url, key_ciphertext, key_iv, key_tag, models, extra_body, enabled, confidential_allowed, priority, input_price, output_price, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [id, workspaceId, name, preset, baseUrl, key?.ciphertext ?? null, key?.iv ?? null, key?.tag ?? null, JSON.stringify(models), JSON.stringify(extraBody), enabled, confidentialAllowed, order.next, inputPrice ?? null, outputPrice ?? null, actor(c)],
        );
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "model_provider.created", targetType: "model_provider", targetId: id, details: { name, baseUrl, confidentialAllowed } });
      });
    } catch (error) {
      return unique(c, error);
    }
    return c.json({ id }, 201);
  });

  app.put(`${base}/:providerId`, requirePermission("connections:write"), validId, async (c) => {
    const parsed = providerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `Check the ${parsed.error.issues[0]!.path.join(".")} field.` }, 400);
    const workspaceId = scoped(c);
    const id = c.req.param("providerId");
    const { preset, baseUrl, apiKey, extraBody, enabled, confidentialAllowed, inputPrice, outputPrice } = parsed.data;
    const before = await inWorkspace(pool, workspaceId, (db) => providerRow(db, id));
    if (!before) return missing(c);
    const savedKey = before.base_url === baseUrl && before.key_ciphertext ? keyOf(env.SECRETS_MASTER_KEY, workspaceId, before) : undefined;
    const filled = await completeProvider(parsed.data, apiKey ?? savedKey).catch((error: Error) => error);
    if (filled instanceof Error) return c.json({ error: filled.message }, 400);
    const { name, models } = filled;
    try {
      const outcome = await inWorkspace(pool, workspaceId, async (db) => {
        const current = await providerRow(db, id);
        if (!current) return "missing";
        // A saved key only ever goes to the address it was saved for, so a new address needs the key entered again.
        if (current.base_url !== baseUrl && current.key_ciphertext && !apiKey) return "needs-key";
        const key = apiKey ? sealKey(env.SECRETS_MASTER_KEY, workspaceId, id, apiKey) : undefined;
        await db.query(
          `update model_providers set name = $2, preset = $3, base_url = $4, models = $5, extra_body = $6, enabled = $7, confidential_allowed = $8,
             input_price = $9, output_price = $10, updated_at = now(),
             key_ciphertext = coalesce($11, key_ciphertext), key_iv = coalesce($12, key_iv), key_tag = coalesce($13, key_tag)
           where id = $1`,
          [id, name, preset, baseUrl, JSON.stringify(models), JSON.stringify(extraBody), enabled, confidentialAllowed, inputPrice ?? null, outputPrice ?? null, key?.ciphertext ?? null, key?.iv ?? null, key?.tag ?? null],
        );
        await recordAudit(db, { workspaceId, actorId: actor(c), action: "model_provider.updated", targetType: "model_provider", targetId: id, details: { name, baseUrl, enabled, confidentialAllowed, keyChanged: !!apiKey } });
        return "saved";
      });
      if (outcome === "missing") return missing(c);
      if (outcome === "needs-key") return c.json({ error: "Enter the API key again, because the address changed." }, 400);
      return c.json({ id });
    } catch (error) {
      return unique(c, error);
    }
  });

  app.delete(`${base}/:providerId`, requirePermission("connections:write"), validId, async (c) => {
    const workspaceId = scoped(c);
    const id = c.req.param("providerId");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("delete from model_providers where id = $1", [id]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: actor(c), action: "model_provider.deleted", targetType: "model_provider", targetId: id });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : missing(c);
  });

  app.post(`${base}/order`, requirePermission("connections:write"), async (c) => {
    const body = z.object({ ids: z.array(uuid).min(1).max(50) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose an order." }, 400);
    const workspaceId = scoped(c);
    await inWorkspace(pool, workspaceId, async (db) => {
      for (const [index, id] of body.data.ids.entries()) await db.query("update model_providers set priority = $2 where id = $1", [id, (index + 1) * 10]);
      await recordAudit(db, { workspaceId, actorId: actor(c), action: "model_provider.reordered" });
    });
    return c.json({ saved: true });
  });

  app.post(`${base}/discover`, requirePermission("connections:write"), async (c) => {
    const body = z.object({ baseUrl: z.url(), apiKey: z.string().max(4_000).optional(), providerId: uuid.optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter the server address." }, 400);
    const workspaceId = scoped(c);
    try {
      let apiKey = body.data.apiKey;
      if (!apiKey && body.data.providerId) {
        const row = await inWorkspace(pool, workspaceId, (db) => providerRow(db, body.data.providerId!));
        // A saved key is only sent to the address it belongs to.
        if (row && row.base_url === body.data.baseUrl) apiKey = targetOf(env.SECRETS_MASTER_KEY, workspaceId, row, "main").apiKey;
      }
      return c.json({ models: await discoverModels(body.data.baseUrl, apiKey) });
    } catch (error) {
      return c.json({ error: explainConnection(error) }, 400);
    }
  });

  app.post(`${base}/:providerId/test`, requirePermission("connections:write"), validId, async (c) => {
    const workspaceId = scoped(c);
    const row = await inWorkspace(pool, workspaceId, (db) => providerRow(db, c.req.param("providerId")));
    if (!row) return missing(c);
    const roles = (["main", "fast", "coding"] as const).filter((role) => row.models[role]);
    const results = [];
    for (const role of roles) {
      const { status, seconds, detail } = await checkModel(targetOf(env.SECRETS_MASTER_KEY, workspaceId, row, role));
      results.push({ role, model: row.models[role], status, seconds, detail: detail && plainError(new Error(detail), "The AI provider").replaceAll(/Bearer \S+/g, "Bearer [removed]") });
    }
    if (row.models.embedding) {
      const started = Date.now();
      const seconds = () => Math.round((Date.now() - started) / 100) / 10;
      try {
        const response = await guardedModelFetch(row.base_url)(`${row.base_url.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${keyOf(env.SECRETS_MASTER_KEY, workspaceId, row)}` },
          body: JSON.stringify({ model: row.models.embedding, input: ["test"] }),
        });
        if (!response.ok) throw new Error(serviceProblem("The AI provider", response.status));
        const body = await response.json() as { data?: { embedding?: number[] }[] };
        if (!body.data?.[0]?.embedding?.length) throw new Error("The server returned no embedding.");
        results.push({ role: "embedding", model: row.models.embedding, status: "embeddings work", seconds: seconds() });
      } catch (error) {
        results.push({ role: "embedding", model: row.models.embedding, status: "error", seconds: seconds(), detail: explainConnection(error) });
      }
    }
    return c.json({ results });
  });

  // Moves keys from the server's settings file into encrypted settings, once.
  app.post(`${base}/import-env`, requirePermission("workspace:delete"), async (c) => {
    // These would be the server's own keys, handed to one customer.
    if (env.HOSTED_MODE) return missing(c);
    const workspaceId = scoped(c);
    const targets = (() => {
      try {
        return { full: modelChain("main"), fast: process.env.LLM_MODEL_FAST?.trim(), coding: process.env.LLM_MODEL_CODING?.trim() };
      } catch {
        return undefined;
      }
    })();
    if (!targets) return c.json({ error: "The server has no complete model settings to import." }, 400);
    const created = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("select 1 from model_providers");
      if (rowCount) return 0;
      let priority = 10;
      for (const target of targets.full) {
        const id = randomUUID();
        const isNvidia = target.provider === "nvidia";
        const models = { main: target.model, ...(isNvidia ? { fast: targets.fast, coding: targets.coding } : {}) };
        const key = sealKey(env.SECRETS_MASTER_KEY, workspaceId, id, target.apiKey);
        const name = `${isNvidia ? "NVIDIA" : "Kimi"} ${priority / 10}`;
        await db.query(
          `insert into model_providers (id, workspace_id, name, preset, base_url, key_ciphertext, key_iv, key_tag, models, extra_body, confidential_allowed, priority, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          // Clearing a provider is a person's decision about its data terms, so an import never makes it.
          [id, workspaceId, name, target.provider, target.baseUrl, key.ciphertext, key.iv, key.tag, JSON.stringify(models), JSON.stringify(target.extraBody), false, priority, actor(c)],
        );
        priority += 10;
      }
      await recordAudit(db, { workspaceId, actorId: actor(c), action: "model_provider.imported", details: { count: targets.full.length } });
      return targets.full.length;
    });
    return created ? c.json({ imported: created }, 201) : c.json({ error: "This workspace already has providers." }, 400);
  });
}

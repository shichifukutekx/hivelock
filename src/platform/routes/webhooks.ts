import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Pool } from "pg";
import { z } from "zod";
import { inWorkspace } from "../db.ts";
import type { PlatformEnv } from "../env.ts";
import type { Engine } from "../engine/engine.ts";
import { allow, LIMITS } from "../rate-limit.ts";
import { decryptSecret } from "../secrets.ts";
import { passesFilter } from "../trigger-filter.ts";

const MAX_AGE_SECONDS = 300;
const MAX_BODY = 1024 * 1024;
const triggerId = z.uuid();

export const webhookSecretName = (id: string) => `webhook:${id}`;

export const signWebhook = (secret: string, timestamp: string, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

function matches(expected: string, given: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Webhooks have no signed-in user, so every call must prove it holds the trigger's secret. */
export function addWebhookRoute(app: Hono<any>, { pool, engine, env }: { pool: Pool; engine: Engine; env: PlatformEnv }) {
  // Every refusal looks the same, so a caller cannot probe which triggers exist.
  const refused = (c: any) => c.json({ error: "Not accepted." }, 401);

  app.post("/hooks/:triggerId", bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: "Request is too large." }, 413) }), async (c) => {
    const address = c.req.header("x-real-ip") ?? "direct";
    if (!(await allow(pool, `hook-address:${address}`, LIMITS.webhookAddress))) return c.json({ error: "Too many requests." }, 429, { "retry-after": "60" });
    const id = triggerId.safeParse(c.req.param("triggerId"));
    const timestamp = c.req.header("x-webhook-timestamp") ?? "";
    const signature = c.req.header("x-webhook-signature") ?? "";
    const body = await c.req.text();
    if (!id.success || !/^\d{10}$/.test(timestamp)) return refused(c);
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) return refused(c);

    const { rows: [trigger] } = await pool.query("select * from webhook_trigger($1)", [id.data]);
    if (!trigger?.enabled) return refused(c);
    const secret = decryptSecret(env.SECRETS_MASTER_KEY, trigger.workspace_id, webhookSecretName(id.data), {
      ciphertext: trigger.secret_ciphertext, iv: trigger.secret_iv, tag: trigger.secret_tag,
    });
    if (!matches(signWebhook(secret, timestamp, body), signature)) return refused(c);

    if (!(await allow(pool, `hook-trigger:${id.data}`, LIMITS.webhookTrigger))) return c.json({ error: "Too many requests." }, 429, { "retry-after": "60" });

    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return c.json({ error: "The body must be JSON." }, 400);
    }

    // The filter runs in code, before any run or model, and a delivery it drops is only counted.
    const skipped = await inWorkspace(pool, trigger.workspace_id, async (db) => {
      const { rows: [row] } = await db.query("select filter from trigger_filters where trigger_id = $1", [id.data]);
      if (passesFilter(row?.filter, input)) return false;
      await db.query("update trigger_filters set skipped_count = skipped_count + 1, last_skipped_at = now() where trigger_id = $1", [id.data]);
      return true;
    });
    if (skipped) return c.json({ skipped: true, reason: "The trigger's filter did not match, so no run started." }, 202);

    // Claimed with the run, so a delivery refused for a pause or a limit is not used up, and sending it again works.
    const runId = await engine.startRun({
      workspaceId: trigger.workspace_id, workflowId: trigger.workflow_id, input, triggerKind: "webhook", triggerId: id.data,
      claim: async (db) => {
        await db.query("delete from webhook_deliveries where trigger_id = $1 and received_at < now() - interval '1 hour'", [id.data]);
        const { rowCount } = await db.query(
          "insert into webhook_deliveries (workspace_id, trigger_id, signature) values ($1, $2, $3) on conflict do nothing",
          [trigger.workspace_id, id.data, signature],
        );
        return rowCount === 1;
      },
    });
    return runId ? c.json({ runId }, 202) : refused(c);
  });
}

import type { Hono } from "hono";
import type { Pool } from "pg";
import { isPlatformAdmin, type Auth, type Person } from "../auth.ts";
import { chainIntact, recordAudit } from "../audit-log.ts";
import { networkPolicy, type PlatformEnv } from "../env.ts";
import { editionOf } from "../edition.ts";
import { editionUsage } from "../limits.ts";
import { createMailer, environmentMail, explainMailError, mailBody, mailSource, readMailSettings, saveMailSettings } from "../mailer.ts";
import { instant, orderDirection, readPage, searchTerms } from "../paging.ts";
import { can, type Permission } from "../permissions.ts";
import { COMMUNITY_READABLE_VERSIONS, FEATURE_NAMES, SALES_EMAIL } from "../plans.ts";
import { productName } from "../extensions.ts";

interface Deps {
  pool: Pool;
  env: PlatformEnv;
  auth: Auth;
  requirePermission: (permission: Permission) => any;
}

/** What the screen sees. The password itself never leaves the server. */
const shown = (row: Record<string, any>) => ({
  host: row.host, port: row.port, security: row.security, username: row.username, hasPassword: !!row.password_ciphertext,
  fromAddress: row.from_address, fromName: row.from_name, updatedAt: row.updated_at,
});

/** Everything recorded outside any workspace falls under one of these. */
const SERVER_AUDIT_AREAS = ["auth", "platform", "privacy"];

/** Settings for the whole server, so they belong to the platform's administrator alone. */
export function addPlatformRoutes(app: Hono<any>, { pool, env, auth, requirePermission }: Deps) {
  const base = "/api/v1/platform/mail";
  const mail = createMailer(pool, env);
  const person = (c: any) => c.get("user") as Person;
  const ip = (c: any) => c.req.raw.headers.get("x-real-ip") ?? undefined;

  // Anyone else cannot tell that these routes exist.
  const adminOnly = async (c: any, next: () => Promise<void>) => {
    if (!isPlatformAdmin(env, person(c))) return c.json({ error: "Not found." }, 404);
    await next();
  };

  app.get(base, adminOnly, async (c) => {
    const saved = await readMailSettings(pool);
    const source = await mailSource(pool, env);
    const verificationOn = !!auth.options.emailAndPassword?.requireEmailVerification;
    return c.json({
      source,
      settings: saved ? shown(saved) : null,
      environmentConfigured: environmentMail(env),
      verificationOn,
      restartNeeded: source !== "none" && !verificationOn,
      allowedLocalHosts: networkPolicy(env).allowedPrivateHosts,
    });
  });

  app.put(base, adminOnly, async (c) => {
    const parsed = mailBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: `Check the ${parsed.error.issues[0]!.path.join(".")} field.` }, 400);
    const { password, ...settings } = parsed.data;
    const user = person(c);
    const db = await pool.connect();
    try {
      await db.query("begin");
      const saved = await saveMailSettings(db, env, parsed.data, user.id);
      if (saved) await recordAudit(db, { actorId: user.id, action: "platform.mail_changed", targetType: "platform_settings", targetId: "mail", details: { ...settings, passwordChanged: !!password }, ip: ip(c) });
      await db.query("commit");
      if (!saved) return c.json({ error: "Enter the password again, because the server changed." }, 400);
      return c.json({ saved: true });
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  });

  // Goes only to the address of the person asking, so this cannot be used to send mail to anyone else.
  app.post(`${base}/test`, adminOnly, async (c) => {
    const user = person(c);
    const source = await mailSource(pool, env);
    try {
      await mail({ to: user.email, subject: `${await productName(pool)} test email`, text: `Your ${await productName(pool)} server can send mail.` });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "mail_test_failed", code: (error as { code?: string }).code }));
      await recordAudit(pool, { actorId: user.id, action: "platform.mail_test_failed", targetType: "platform_settings", targetId: "mail", ip: ip(c) });
      return c.json({ error: explainMailError(error) }, 400);
    }
    await recordAudit(pool, { actorId: user.id, action: "platform.mail_test_sent", targetType: "platform_settings", targetId: "mail", details: { source }, ip: ip(c) });
    return c.json({ sent: true, to: user.email, source });
  });

  // Row security hides these entries from every workspace, so only this function can read them.
  app.get("/api/v1/platform/audit", adminOnly, async (c) => {
    const query = (name: string) => c.req.query(name);
    const { limit, offset } = readPage(query, 25);
    const areas = query("action")?.split(",").filter((area) => SERVER_AUDIT_AREAS.includes(area)) ?? null;
    const { rows: [page] } = await pool.query<{ page: { total: number; events: unknown[] } }>(
      "select platform_audit_page($1, $2, $3, $4, $5, $6, $7) as page",
      [searchTerms(query("q")), areas, instant(query("whenFrom")) ?? null, instant(query("whenTo")) ?? null, orderDirection(query) === "desc", limit, offset],
    );
    const { rows: [head] } = await pool.query("select seq, hash from audit_chain_head(null)");
    if (query("verify") === "false") return c.json({ ...page!.page, head: head ?? null });
    return c.json({ ...page!.page, chainIntact: await chainIntact(pool, null), head: head ?? null });
  });

  // Hosted mode has plans instead of editions, and reads no key.
  if (env.HOSTED_MODE) return;

  /** Everyone in a workspace sees this. It holds what a key says, never the key. Who holds the licence, and what the whole server uses, is for those who manage people. */
  app.get("/api/v1/workspaces/:workspaceId/edition", requirePermission("content:read"), async (c: any) => {
    const { id, name, limits, notice, license } = await editionOf(pool);
    const manages = can(c.get("role"), "members:manage");
    const { workspaces, people, ...ownUsage } = await editionUsage(pool, c.req.param("workspaceId"));
    return c.json({
      id, name, notice,
      license: manages || !license ? license : { expiresAt: license.expiresAt, graceUntil: license.graceUntil, inGrace: license.inGrace, seats: license.seats },
      limits: { workspaces: limits.workspaces, people: limits.people, agents: limits.agents, workflows: limits.workflows, storageBytes: limits.storageBytes },
      connectors: limits.connectors, readableVersions: COMMUNITY_READABLE_VERSIONS,
      lockedFeatures: limits.lockedFeatures.map((feature) => ({ id: feature, name: FEATURE_NAMES[feature] })),
      usage: manages ? { workspaces, people, ...ownUsage } : ownUsage,
      contact: SALES_EMAIL,
    });
  });
}

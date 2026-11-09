import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { routePath } from "hono/route";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Pool } from "pg";
import { z } from "zod";
import { chainIntact, recordAudit } from "./audit-log.ts";
import { assertMaySignUp, isPlatformAdmin, mayCreateWorkspaces, plainPath, signupCookie, TWO_FACTOR_CLOSED_PATHS, type Auth, type Person } from "./auth.ts";
import { inWorkspace, QUERY_CANCELED } from "./db.ts";
import { networkPolicy, type PlatformEnv } from "./env.ts";
import type { PgBoss } from "pg-boss";
import { TooManyRuns, type Engine } from "./engine/engine.ts";
import { MailReadRefused } from "./connectors/types.ts";
import { extensions, hostedPolicy, type GateOptions, type RouteContext } from "./extensions.ts";
import { assertActive, assertPeopleRoom, assertFeature, assertWorkspaceRoom, PEOPLE_LOCK, PlanLimit, WorkspacePaused } from "./limits.ts";
import { can, type Permission } from "./permissions.ts";
import type { PaidFeature } from "./plans.ts";
import type { AgentChat } from "./agent-chat.ts";
import { reportError } from "./error-reporting.ts";
import { log, withLogFields } from "./log.ts";
import { mailSource } from "./mailer.ts";
import { httpLatency, httpRequests, requestEnded, requestStarted } from "./metrics.ts";
import { addModelRoutes } from "./routes/models.ts";
import { addHealthRoutes } from "./routes/health.ts";
import { addObservabilityRoutes } from "./routes/observability.ts";
import { addPlatformRoutes } from "./routes/platform.ts";
import { addAgentRoutes } from "./routes/agents.ts";
import type { Knowledge } from "./knowledge.ts";
import type { LiveHub } from "./live.ts";
import { addConnectionRoutes } from "./routes/connections.ts";
import { addWebhookRoute } from "./routes/webhooks.ts";
import { addTemplateRoutes } from "./routes/templates.ts";
import { addWorkflowRoutes } from "./routes/workflows.ts";
import { addChoice, addRange, addSearch, conditions, orderDirection, readPage } from "./paging.ts";
import { allow, LIMITS } from "./rate-limit.ts";
import { putSecret } from "./secrets.ts";

type SessionUser = Person & { name: string; twoFactorEnabled?: boolean | null; sessionId: string; activeOrganizationId?: string | null };
type Vars = { Variables: { user: SessionUser; role: string; requestId: string } };

const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD_BODY = 21 * 1024 * 1024;
/** Each invitation sends mail under this server's name, so one workspace cannot send without limit. */
const AUDIT_AREAS = ["agent", "billing", "channel", "chat", "connection", "file", "mcp", "member", "memory", "model_provider", "operator", "privacy", "run", "secret", "settings", "skill", "sso", "step", "support", "template", "trigger", "workflow", "workspace"];
const INVITATION_LIMIT = { limit: 100, windowSeconds: 24 * 60 * 60 };
const TWO_FACTOR_REPLACE_LIMIT = { limit: 5, windowSeconds: 15 * 60 };
const OPEN_AUTH_ROUTES = new Set([
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/get-session",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/verify-email",
  "/api/auth/send-verification-email",
]);
const isClosedTwoFactorRoute = (path: string) => TWO_FACTOR_CLOSED_PATHS.some((closed) => plainPath(path) === `/api/auth${closed}`);
/** A person's own business, not a workspace's. A session scoped to one workspace cannot use these. */
const ORGANIZATION_ACCOUNT_ROUTES = new Set(["create", "accept-invitation", "reject-invitation", "get-invitation", "list", "list-user-invitations", "check-slug"]);
/** These can only work by sending mail. */
/** The routes that add someone on a self-hosted server, where the edition sets the limit. */
const PEOPLE_ROUTES: Record<string, "invite" | "join"> = { "/api/auth/organization/invite-member": "invite", "/api/auth/organization/accept-invitation": "join" };
const MAIL_AUTH_ROUTES = new Set(["/api/auth/request-password-reset", "/api/auth/send-verification-email"]);
const SENSITIVE_AUTH_ROUTES: Record<string, string> = {
  "/api/auth/change-password": "auth.password_changed",
  "/api/auth/reset-password": "auth.password_reset",
  "/api/auth/change-email": "auth.email_changed",
};
/** Password-reset links carry a token in the path. */
const isOpenAuthRoute = (path: string) => OPEN_AUTH_ROUTES.has(path) || /^\/api\/auth\/reset-password\/[\w-]+$/.test(path);
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const secretBody = z.object({ value: z.string().min(1).max(16_384) });

const refuse = (status: 401 | 403 | 404, message: string, code?: string): never => {
  throw new HTTPException(status, { res: Response.json({ error: message, code }, { status }) });
};

export interface AppDeps {
  pool: Pool;
  auth: Auth;
  env: PlatformEnv;
  /** Present once the job queue is running. Without it the app serves only the foundation routes. */
  workflows?: RouteContext["workflows"];
  /** Passed to extensions as they are. Tests replace outside services through this. */
  extensionOptions?: Record<string, unknown>;
  /** How often an open stream checks its viewer may still watch. Shortened in tests. */
  streamCheckMs?: number;
  /** True once this process has been told to stop, so /ready turns traffic away first. */
  stopping?: () => boolean;
}

/** Only a value this server or its proxy could have made, because it goes into every log line. */
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** Refused with the plain sentence that says what to do. The extension answers instead wherever it is installed. */
const PAID_ROUTES = [
  { method: "GET", path: "/workflows/:workflowId/versions/compare", feature: "versionHistory", permission: "content:read" },
  { method: "POST", path: "/workflows/:workflowId/versions/:version/restore", feature: "versionHistory", permission: "workflows:write" },
  { method: "GET", path: "/agents/:name/evals", feature: "evals", permission: "content:read" },
  { method: "POST", path: "/agents/:name/evals/cases", feature: "evals", permission: "agents:write" },
  { method: "POST", path: "/agents/:name/evals/run", feature: "evals", permission: "agents:write" },
  { method: "POST", path: "/agents/:name/release/override", feature: "evals", permission: "members:manage" },
  { method: "GET", path: "/channels", feature: "whatsapp", permission: "connections:list" },
  { method: "POST", path: "/channels", feature: "whatsapp", permission: "connections:write" },
  { method: "GET", path: "/sso", feature: "sso", permission: "sso:manage" },
  { method: "PUT", path: "/sso", feature: "sso", permission: "sso:manage" },
] as const satisfies { method: string; path: string; feature: PaidFeature; permission: Permission }[];

export function createApp({ pool, auth, env, workflows, extensionOptions = {}, streamCheckMs, stopping }: AppDeps) {
  // A hosted server without its rules would mix customers. loadEnv refuses this too, and this holds for anything that builds an app another way.
  if (env.HOSTED_MODE) hostedPolicy();
  const app = new Hono<Vars>();
  const additions = extensions();
  const authAdditions = additions.flatMap(({ auth: added }) => (added ? [added] : []));
  const clientIp = (request: Request) => request.headers.get("x-real-ip") ?? undefined;

  app.use("*", async (c, next) => {
    const sent = c.req.header("x-request-id");
    const requestId = sent && REQUEST_ID.test(sent) ? sent : randomUUID();
    const started = Date.now();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    requestStarted();
    try {
      await withLogFields({ requestId }, next);
    } finally {
      requestEnded();
    }
    // The route's pattern, never the address itself, because each label value is kept forever. This is the last one that ran: the web app's catch-all matches every path.
    const route = routePath(c);
    const labels = { method: c.req.method, route };
    httpRequests.inc({ ...labels, status: `${Math.floor(c.res.status / 100)}xx` });
    httpLatency.observe(labels, (Date.now() - started) / 1_000);
    // Paths and status only: bodies and headers can hold passwords and secrets.
    log("info", "request", { requestId, method: c.req.method, path: c.req.path.replace(/(\/reset-password\/)[^/]+/, "$1[token]"), status: c.res.status, ms: Date.now() - started });
  });
  app.use("*", secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'self'"], imgSrc: ["'self'", "data:"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"] }, strictTransportSecurity: env.PUBLIC_URL.startsWith("https://") ? "max-age=31536000; includeSubDomains" : false }));
  // A NUL cannot reach Postgres, so a search holding one would end as a 500. Nothing valid contains it, and a raw one never gets past the HTTP parser.
  app.use("*", async (c, next) => (c.req.url.includes("%00") ? c.json({ error: "This address holds a character that is not allowed." }, 400) : next()));
  app.use("/api/*", csrf({ origin: env.PUBLIC_URL }));
  const tooLarge = (c: any) => c.json({ error: "Request is too large." }, 413);
  // Uploads arrive as base64, which is a third larger than the 15 MB file limit.
  const uploadLimit = bodyLimit({ maxSize: MAX_UPLOAD_BODY, onError: tooLarge });
  const normalLimit = bodyLimit({ maxSize: MAX_BODY, onError: tooLarge });
  app.use("/api/*", (c, next) => (c.req.method === "POST" && /^\/api\/v1\/workspaces\/[^/]+\/files$/.test(c.req.path) ? uploadLimit(c, next) : normalLimit(c, next)));
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  addHealthRoutes(app, { pool, boss: workflows?.boss, live: workflows?.live, stopping });
  // Read before sign-in, to choose the words on the sign-up page.
  app.get("/api/public-config", (c) => c.json({ hosted: env.HOSTED_MODE }));

  const session = async (headers: Headers) => {
    const found = await auth.api.getSession({ headers }) as { user?: any; session?: any } | null;
    if (!found?.user) return undefined;
    const user: SessionUser = { ...found.user, sessionId: found.session?.id ?? "", activeOrganizationId: found.session?.activeOrganizationId };
    for (const added of authAdditions) if (added.session && !(await added.session(found, user, pool))) return undefined;
    return user;
  };

  const optedOut = async (userId: string) => (await pool.query("select 1 from two_factor_opt_outs where user_id = $1", [userId])).rowCount === 1;

  const signedIn = async (c: { req: { raw: Request } }) => {
    const user = await session(c.req.raw.headers);
    if (!user) return refuse(401, "Sign in first.");
    // An outside identity provider handles the second step, but only for a session it opened. Password sign-in by the same person still needs it.
    // A person who chose to turn it off for their own account signs in with their password alone.
    if (!user.twoFactorEnabled && !user.externalIdentity && !(await optedOut(user.id))) return refuse(403, "Turn on two-step verification first.", "two_factor_required");
    return user;
  };

  const gates = additions.flatMap(({ gates: make }) => make?.(pool) ?? []);
  /** What stops this person reaching a workspace, whatever their role. */
  const gateRefusal = async (user: SessionUser, workspaceId: string, options: GateOptions = {}) => {
    if (user.scopedWorkspaceId && user.scopedWorkspaceId !== workspaceId) return refuse(404, "Not found.");
    for (const gate of gates) await gate.check(user, workspaceId, options);
  };

  /** Organization routes bypass requirePermission, so they pass the same gate here. The library's choice among these values differs by route, so each one must pass. */
  const guardOrganizationRoute = async (user: SessionUser, path: string, url: string, sent: Record<string, unknown>) => {
    const name = path.slice("/api/auth/organization/".length);
    if (ORGANIZATION_ACCOUNT_ROUTES.has(name)) {
      if (user.scopedWorkspaceId) refuse(403, "This session only reaches one workspace.");
      return;
    }
    const query = new URL(url).searchParams;
    const given = (...values: unknown[]) => values.filter((value): value is string => typeof value === "string" && value !== "");
    const named = new Set(given(sent.organizationId, query.get("organizationId"), user.activeOrganizationId));
    for (const slug of given(sent.organizationSlug, query.get("organizationSlug"))) {
      const { rows: [row] } = await pool.query<{ id: string }>("select id from organization where slug = $1", [slug]);
      if (row) named.add(row.id);
    }
    for (const invitationId of given(sent.invitationId, query.get("invitationId"))) {
      const { rows: [row] } = await pool.query<{ organizationId: string }>(`select "organizationId" from invitation where id = $1`, [invitationId]);
      if (row) named.add(row.organizationId);
    }
    if (!named.size) {
      if (user.scopedWorkspaceId) refuse(403, "This session only reaches one workspace.");
      return;
    }
    for (const workspaceId of named) await gateRefusal(user, workspaceId);
  };

  /** Counts only people who may invite, so anyone else cannot use up a workspace's allowance. */
  const invitationsLeft = async (user: SessionUser, sent: Record<string, unknown>) => {
    const workspaceId = (typeof sent.organizationId === "string" && sent.organizationId) || user.activeOrganizationId;
    if (!workspaceId) return true;
    const { rows: [member] } = await pool.query<{ role: string }>(`select role from member where "organizationId" = $1 and "userId" = $2`, [workspaceId, user.id]);
    return !can(member?.role, "members:manage") || allow(pool, `invitations:${workspaceId}`, INVITATION_LIMIT);
  };

  /** The check on how many workspaces a person owns and the insert are separate steps, so one person's creations run one at a time. Nothing waits, which keeps a burst from filling the pool. */
  const oneAtATime = async (key: string, work: () => Promise<Response>) => {
    const client = await pool.connect();
    try {
      const { rows: [{ locked }] } = await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [key]);
      if (!locked) return undefined;
      try {
        return await work();
      } finally {
        await client.query("select pg_advisory_unlock(hashtext($1))", [key]);
      }
    } finally {
      client.release();
    }
  };

  app.all("/api/auth/*", async (c) => {
    if (isClosedTwoFactorRoute(c.req.path)) return c.json({ message: "Two-step verification cannot be turned off or read back. If you lost your authenticator, replace it with a backup code." }, 403);
    for (const added of authAdditions) {
      const answered = await added.request?.(c, { pool, env, auth });
      if (answered) return answered;
    }
    // Only named routes work before two-step verification. Anything else, however it is spelled, needs it.
    const person = isOpenAuthRoute(c.req.path) ? undefined : await signedIn(c);
    // Asked before any account is looked up, so the answer is the same for every address.
    if (MAIL_AUTH_ROUTES.has(c.req.path) && (await mailSource(pool, env)) === "none") {
      return c.json({ message: "Mail is not set up yet, so this cannot be done by email. Please ask your administrator." }, 400);
    }

    const sentBody = c.req.method === "POST" ? await c.req.raw.clone().json().catch(() => ({})) : {};
    if (person) {
      if (c.req.path.startsWith("/api/auth/organization/")) await guardOrganizationRoute(person, c.req.path, c.req.url, sentBody);
      // Passwords, two-step settings and the like need a session this person opened themselves.
      else if (person.scopedWorkspaceId) return refuse(403, "This session only reaches one workspace.");
    }
    if (c.req.path === "/api/auth/sign-up/email") {
      try {
        await assertMaySignUp(pool, env, String(sentBody.email ?? ""), typeof sentBody.invitationId === "string" ? sentBody.invitationId : undefined);
      } catch {
        return c.json({ message: env.HOSTED_MODE ? "Sign-up is not available for this address." : "Sign-up is by invitation only." }, 403);
      }
    }
    // "Remember this device" is not offered: every sign-in needs the second step.
    if (c.req.path.startsWith("/api/auth/two-factor/verify") && sentBody.trustDevice) return c.json({ message: "This option is not available." }, 400);
    const enrolling = c.req.path === "/api/auth/two-factor/verify-totp" ? await session(c.req.raw.headers).catch(() => undefined) : undefined;

    // Compared in the plain form, so another spelling of the same address cannot slip past a limit.
    const route = plainPath(c.req.path);
    if (person && route === "/api/auth/organization/invite-member" && !(await invitationsLeft(person, sentBody))) {
      return c.json({ message: "This workspace has sent as many invitations as it can today. Try again tomorrow." }, 429);
    }
    const creating = person && route === "/api/auth/organization/create";
    const adding = person && !env.HOSTED_MODE && PEOPLE_ROUTES[route];
    if (adding) {
      // Held while the library writes, so two at once cannot both take the last place.
      const email = adding === "invite" ? String(sentBody.email ?? "") : person.email;
      const added = await oneAtATime(PEOPLE_LOCK, async () => {
        await assertPeopleRoom(pool, { email, joining: adding === "join" });
        return auth.handler(c.req.raw);
      });
      return added ?? c.json({ message: "Someone else is adding a person. Try again in a moment." }, 429);
    }
    const response = creating
      ? await oneAtATime(`workspace-create:${person.id}`, async () => {
        await assertWorkspaceRoom(pool);
        return auth.handler(c.req.raw);
      })
      : await auth.handler(c.req.raw);
    if (!response) return c.json({ message: "A workspace is already being created. Try again in a moment." }, 429);
    // The database stops a seat the plan does not have, and only a race reaches it, because the hook below answers first.
    if (response.status >= 500 && /\/organization\/(invite-member|accept-invitation|add-member)$/.test(c.req.path) && env.HOSTED_MODE) {
      return c.json({ message: "This could not be saved. The plan may have no free seats.", code: "plan_limit" }, 402);
    }

    // Sessions opened before two-step verification must not gain from it, so only the enrolling one survives.
    if (enrolling && !enrolling.twoFactorEnabled && response.ok) {
      await pool.query("delete from two_factor_opt_outs where user_id = $1", [enrolling.id]);
      await pool.query(
        `delete from session where "userId" = $1 and id <> (select id from session where "userId" = $1 order by "createdAt" desc limit 1)`,
        [enrolling.id],
      );
    }
    if (c.req.path === "/api/auth/sign-in/email" && response.status >= 400 && response.status !== 429) {
      await recordAudit(pool, { action: "auth.sign_in_failed", ip: clientIp(c.req.raw) });
    }
    const sensitive = SENSITIVE_AUTH_ROUTES[c.req.path];
    if (sensitive && response.ok) {
      const user = await session(c.req.raw.headers).catch(() => undefined);
      await recordAudit(pool, { action: sensitive, actorId: user?.id, ip: clientIp(c.req.raw) });
    }
    if (c.req.path === "/api/auth/sign-up/email" && response.ok) {
      const created = await response.clone().json().catch(() => null) as { user?: { id?: string } } | null;
      if (created?.user?.id) {
        const marked = new Response(response.body, response);
        marked.headers.append("set-cookie", signupCookie(env, created.user.id));
        return marked;
      }
    }
    return response;
  });

  app.use("/api/v1/*", async (c, next) => {
    const user = await signedIn(c);
    if (!(await allow(pool, `user:${user.id}`, LIMITS.user))) return c.json({ error: "Too many requests. Try again in a minute." }, 429, { "retry-after": "60" });
    c.set("user", user);
    await next();
  });

  /** Needed even while the workspace is read-only: reading, paying, and leaving. */
  const OPEN_WHEN_READ_ONLY: Permission[] = ["content:read", "billing:manage", "workspace:delete"];

  const membership = async (workspaceId: string, user: SessionUser) => (await pool.query<{ role: string }>(
    `select role from member where "organizationId" = $1 and "userId" = $2`, [workspaceId, user.id],
  )).rows;

  const stillAllowed = async (request: Request, workspaceId: string, permission: Permission) => {
    try {
      const user = await signedIn({ req: { raw: request } });
      const [row] = await membership(workspaceId, user);
      if (!row) return false;
      await gateRefusal(user, workspaceId);
      return can(row.role, permission);
    } catch {
      return false;
    }
  };

  const requirePermission = (permission: Permission, options: GateOptions = {}) =>
    async (c: any, next: () => Promise<void>) => {
      const workspaceId = c.req.param("workspaceId");
      const user = c.get("user") as SessionUser;
      const rows = await membership(workspaceId, user);
      // Someone outside a workspace cannot tell whether it exists.
      if (!rows[0]) return refuse(404, "Not found.");
      await gateRefusal(user, workspaceId, options);
      if (!can(rows[0].role, permission)) return refuse(403, "Your role does not allow this.");
      if (env.HOSTED_MODE && c.req.method !== "GET" && !options.readOnlyRoute && !OPEN_WHEN_READ_ONLY.includes(permission)) await inWorkspace(pool, workspaceId, (db) => assertActive(db, workspaceId));
      c.set("role", rows[0].role);
      await next();
    };

  app.get("/api/v1/me", async (c) => {
    const user = c.get("user");
    const { id, email, name } = user;
    const { rows } = await pool.query(
      `select o.id, o.name, o.slug, m.role from member m join organization o on o.id = m."organizationId"
       where m."userId" = $1 and ($2::text is null or o.id = $2) order by o.name`,
      [id, user.scopedWorkspaceId ?? null],
    );
    const workspaces = (await Promise.all(rows.map(async (workspace) => {
      let entry = workspace;
      for (const gate of gates) {
        const extra = gate.listing ? await gate.listing(user, workspace.id) : {};
        if (!extra) return undefined;
        entry = { ...entry, ...extra };
      }
      return entry;
    }))).filter(Boolean);
    const added = await Promise.all(additions.map(({ meFields }) => meFields?.({ pool, env }, user)));
    return c.json({ user: { id, email, name }, workspaces, hosted: env.HOSTED_MODE, singleSignOn: !!user.externalIdentity, canCreateWorkspaces: await mayCreateWorkspaces(pool, env, user), isPlatformAdmin: isPlatformAdmin(env, user), ...Object.assign({}, ...added) });
  });

  /** Whether this person signs in with a second step. It is on unless they turned it off themselves. */
  app.get("/api/v1/me/two-factor", async (c) => {
    const user = c.get("user");
    return c.json({ enabled: !!user.twoFactorEnabled, optedOut: !user.twoFactorEnabled && (await optedOut(user.id)), singleSignOn: !!user.externalIdentity });
  });

  // Turning it off takes the password, so a session left open on a shared screen cannot do it. Other sessions end.
  app.post("/api/v1/me/two-factor/off", async (c) => {
    const user = c.get("user");
    if (user.scopedWorkspaceId) return c.json({ error: "This session only reaches one workspace." }, 403);
    if (user.externalIdentity) return c.json({ error: "Your sign-in is handled by your company's single sign-on." }, 400);
    const body = z.object({ password: z.string().min(1).max(128) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter your password." }, 400);
    if (!(await allow(pool, `two-factor-replace:${user.id}`, TWO_FACTOR_REPLACE_LIMIT))) return c.json({ error: "Too many attempts. Try again later." }, 429);
    try {
      await auth.api.verifyPassword({ body: { password: body.data.password }, headers: c.req.raw.headers });
    } catch {
      return c.json({ error: "That password is not right." }, 403);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into two_factor_opt_outs (user_id) values ($1) on conflict do nothing", [user.id]);
      await client.query(`delete from "twoFactor" where "userId" = $1`, [user.id]);
      await client.query(`update "user" set "twoFactorEnabled" = false where id = $1`, [user.id]);
      await client.query(`delete from session where "userId" = $1 and id <> $2`, [user.id, user.sessionId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await recordAudit(pool, { action: "auth.two_factor_turned_off", actorId: user.id, ip: clientIp(c.req.raw) });
    return c.json({ enabled: false });
  });

  /** The way back from a lost authenticator. An unused backup code is the second step it stands in for, so a password alone cannot do this. */
  app.post("/api/v1/me/two-factor/replace", async (c) => {
    const user = c.get("user");
    if (user.scopedWorkspaceId) return c.json({ error: "This session only reaches one workspace." }, 403);
    const body = z.object({ password: z.string().min(1).max(128), backupCode: z.string().trim().min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter your password and a backup code." }, 400);
    if (!(await allow(pool, `two-factor-replace:${user.id}`, TWO_FACTOR_REPLACE_LIMIT))) return c.json({ error: "Too many attempts. Try again later." }, 429);
    const { headers } = c.req.raw;
    try {
      await auth.api.verifyPassword({ body: { password: body.data.password }, headers });
      await auth.api.verifyBackupCode({ body: { code: body.data.backupCode, disableSession: true }, headers });
    } catch {
      return c.json({ error: "That password or backup code is not right." }, 403);
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from "twoFactor" where "userId" = $1`, [user.id]);
      await client.query(`update "user" set "twoFactorEnabled" = false where id = $1`, [user.id]);
      await client.query(`delete from session where "userId" = $1 and id <> $2`, [user.id, user.sessionId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await recordAudit(pool, { action: "auth.two_factor_replaced", actorId: user.id, ip: clientIp(c.req.raw) });
    return c.json({ replaced: true });
  });

  app.get("/api/v1/workspaces/:workspaceId/secrets", requirePermission("secrets:list"), async (c) => {
    const rows = await inWorkspace(pool, c.req.param("workspaceId"), async (db) =>
      (await db.query("select name, created_at, updated_at from secrets order by name")).rows);
    return c.json({ secrets: rows });
  });

  app.put("/api/v1/workspaces/:workspaceId/secrets/:name", requirePermission("secrets:write"), async (c) => {
    const name = secretName.safeParse(c.req.param("name"));
    const body = secretBody.safeParse(await c.req.json().catch(() => null));
    if (!name.success) return c.json({ error: "Secret names use capitals, numbers and underscores." }, 400);
    if (!body.success) return c.json({ error: "Enter a value up to 16 KB." }, 400);
    const workspaceId = c.req.param("workspaceId");
    await inWorkspace(pool, workspaceId, async (db) => {
      await putSecret(db, env.SECRETS_MASTER_KEY, workspaceId, name.data, body.data.value, c.get("user").id);
      await recordAudit(db, { workspaceId, actorId: c.get("user").id, action: "secret.saved", targetType: "secret", targetId: name.data, ip: clientIp(c.req.raw) });
    });
    return c.json({ name: name.data });
  });

  app.delete("/api/v1/workspaces/:workspaceId/secrets/:name", requirePermission("secrets:write"), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const name = c.req.param("name");
    const removed = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query("delete from secrets where name = $1", [name]);
      if (rowCount) await recordAudit(db, { workspaceId, actorId: c.get("user").id, action: "secret.deleted", targetType: "secret", targetId: name, ip: clientIp(c.req.raw) });
      return rowCount;
    });
    return removed ? c.json({ deleted: true }) : c.json({ error: "Not found." }, 404);
  });

  app.get("/api/v1/workspaces/:workspaceId/audit", requirePermission("audit:read"), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const query = (name: string) => c.req.query(name);
    const { limit, offset } = readPage(query, 200);
    const where = conditions();
    // Only what the list shows, so a search cannot find what a row hides, such as details or an actor's email beside their name.
    addSearch(where, `concat_ws(' ', replace(a.action, '.', ' '), coalesce(u.name, u.email), a.target_type, a.target_id)`, query("q"));
    addChoice(where, "split_part(a.action, '.', 1)", query("action"), AUDIT_AREAS);
    addRange(where, "a.at", query("whenFrom"), query("whenTo"));
    const direction = orderDirection(query);
    const { events, total } = await inWorkspace(pool, workspaceId, async (db) => ({
      total: (await db.query(`select count(*)::int as total from audit_events a left join "user" u on u.id = a.actor_id ${where.where()}`, where.values)).rows[0].total as number,
      events: (await db.query(
        `select a.id, a.actor_id, coalesce(u.name, u.email) as actor_name, a.action, a.target_type, a.target_id, a.details, a.at
         from audit_events a left join "user" u on u.id = a.actor_id ${where.where()} order by a.id ${direction} limit ${where.value(limit)} offset ${where.value(offset)}`,
        where.values,
      )).rows,
    }));
    const { rows: [head] } = await pool.query("select seq, hash from audit_chain_head($1)", [workspaceId]);
    // Walking the chain rehashes every entry, so turning a page can skip it. The page asks once, on its own.
    if (query("verify") === "false") return c.json({ events, total, head: head ?? null });
    return c.json({ events, total, chainIntact: await chainIntact(pool, workspaceId), head: head ?? null });
  });

  addPlatformRoutes(app, { pool, env, auth, requirePermission });
  // Before the core's own, so a specific path such as versions/compare wins over a general one such as versions/:version.
  for (const { routes } of additions) routes?.({ app, pool, env, auth, network: networkPolicy(env), workflows, requirePermission, stillAllowed, options: extensionOptions });
  // Whatever is still not answered is a paid feature this install does not have, and the answer says how to get it.
  for (const { method, path, feature, permission } of PAID_ROUTES) {
    app.on(method, `/api/v1/workspaces/:workspaceId${path}`, requirePermission(permission), async (c) => {
      await assertFeature(pool, c.req.param("workspaceId")!, feature);
      return c.json({ error: "Not found." }, 404);
    });
  }

  if (workflows) {
    addWorkflowRoutes(app, { pool, env, ...workflows, requirePermission });
    addWebhookRoute(app, { pool, env, engine: workflows.engine });
    addConnectionRoutes(app, { pool, env, network: networkPolicy(env), requirePermission });
    addTemplateRoutes(app, { pool, requirePermission });
    addModelRoutes(app, { pool, env, requirePermission });
    if (workflows.chat) {
      addAgentRoutes(app, { pool, env, chat: workflows.chat, boss: workflows.boss, knowledge: workflows.knowledge, live: workflows.live, requirePermission, stillAllowed, streamCheckMs });
    }
    addObservabilityRoutes(app, { pool, env, boss: workflows.boss, requirePermission });
  }

  // The web app is built into web/dist, so the page and the API share one address.
  if (existsSync("web/dist/index.html")) {
    app.use("/assets/*", serveStatic({ root: "web/dist" }));
    const reserved = additions.flatMap(({ reservedPaths }) => reservedPaths ?? []);
    app.get("*", (c) => (c.req.path.startsWith("/api/") || c.req.path.startsWith("/hooks/") || reserved.some((path) => path.test(c.req.path)) ? c.json({ error: "Not found." }, 404) : c.html(readFileSync("web/dist/index.html", "utf8"))));
  }

  app.notFound((c) => c.json({ error: "Not found." }, 404));
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof TooManyRuns) return c.json({ error: error.message }, 429);
    if (error instanceof WorkspacePaused) return c.json({ error: error.message, code: error.code }, 409);
    if (error instanceof PlanLimit) return c.json({ error: error.message, code: error.code }, 402);
    if (error instanceof MailReadRefused) return c.json({ error: error.message, code: error.code }, 403);
    if ((error as { code?: string }).code === QUERY_CANCELED) {
      log("error", "query_timed_out", { requestId: c.get("requestId"), path: c.req.path });
      return c.json({ error: "This took too long. Try again, or narrow what you asked for.", requestId: c.get("requestId") }, 503);
    }
    log("error", "request_failed", { requestId: c.get("requestId"), message: error.message });
    reportError(error, { requestId: c.get("requestId"), route: routePath(c) });
    return c.json({ error: "Something went wrong.", requestId: c.get("requestId") }, 500);
  });

  return app;
}

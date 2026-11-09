import "./licensed.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import nodemailer from "nodemailer";
import pg from "pg";
import { SMTPServer } from "smtp-server";
import { createApp } from "../src/platform/app.ts";
import { createAuth } from "../src/platform/auth.ts";
import { recordAudit } from "../src/platform/audit-log.ts";
import { createPool, inWorkspace } from "../src/platform/db.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { createMailer, MAIL_PASSWORD_NAME, MAIL_SCOPE, MailNotConfigured, mailSource, readMailSettings } from "../src/platform/mailer.ts";
import { migrate } from "../src/platform/migrate.ts";
import { smtpOptions } from "../src/platform/net/smtp.ts";
import { decryptSecret } from "../src/platform/secrets.ts";

const DB = "agent_platform_test_mail_settings";
const ORIGIN = "http://localhost:4320";
const ADMIN = "founder@example.test";
const PASSWORD = "first long password here";
const OTHER_PASSWORD = "other long password here";
const SMTP_PASSWORD = "smtp-password-canary";
const base = "/api/v1/platform/mail";

interface Received { from?: string; to: string[]; text: string }
interface Mailbox { server: SMTPServer; port: number; received: Received[]; logins: { user: string; pass: string }[] }

let env: PlatformEnv;
let pool: pg.Pool;
let admin: pg.Pool;
let app: ReturnType<typeof createApp>;
let box: Mailbox;
let ip = 0;

function mailbox(options: { needsLogin?: boolean } = {}): Promise<Mailbox> {
  const state: Mailbox = { server: undefined as never, port: 0, received: [], logins: [] };
  state.server = new SMTPServer({
    disabledCommands: options.needsLogin ? ["STARTTLS"] : ["STARTTLS", "AUTH"],
    allowInsecureAuth: true,
    authOptional: !options.needsLogin,
    onAuth: (auth, _, done) => {
      state.logins.push({ user: auth.username!, pass: auth.password! });
      if (auth.password === SMTP_PASSWORD) return done(null, { user: auth.username });
      done(Object.assign(new Error(`535 bad login, you sent ${auth.password}`), { responseCode: 535 }));
    },
    onData: (stream, session, done) => {
      let text = "";
      stream.on("data", (chunk) => (text += chunk));
      stream.on("end", () => {
        state.received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined, to: session.envelope.rcptTo.map((r) => r.address), text });
        done();
      });
    },
  });
  return new Promise((ready) => state.server.listen(0, "127.0.0.1", () => {
    state.port = (state.server.server.address() as { port: number }).port;
    ready(state);
  }));
}

function browser(target: () => ReturnType<typeof createApp> = () => app) {
  const cookies = new Map<string, string>();
  ip += 1;
  const address = `10.2.0.${ip}`;
  return async (method: string, path: string, body?: unknown) => {
    const response = await target().request(path, {
      method, redirect: "manual",
      headers: { origin: ORIGIN, "x-real-ip": address, "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  };
}
type Browser = ReturnType<typeof browser>;

function totp(uri: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of new URL(uri).searchParams.get("secret")!.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function secondStep(person: Browser, password: string) {
  const { totpURI } = await (await person("POST", "/api/auth/two-factor/enable", { password })).json() as { totpURI: string };
  assert.equal((await person("POST", "/api/auth/two-factor/verify-totp", { code: totp(totpURI) })).status, 200);
}

const settings = (extra: Record<string, unknown> = {}) => ({ host: "127.0.0.1", port: box.port, security: "starttls", username: "mailer", password: SMTP_PASSWORD, fromAddress: "noreply@example.test", fromName: "Hivelock Mail", ...extra });
const adminRow = async () => (await admin.query("select * from platform_mail_settings")).rows[0];
const clearSaved = () => admin.query("delete from platform_mail_settings");

let founder: Browser;
let outsider: Browser;
let workspace: string;

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();

  box = await mailbox({ needsLogin: true });
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgres://agent_platform_mail_settings_app:test-only@localhost/${DB}`,
    DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass",
    SECRETS_MASTER_KEY: Buffer.alloc(32, 6).toString("base64"),
    PUBLIC_URL: ORIGIN,
    BOOTSTRAP_ADMIN_EMAIL: ADMIN,
    ALLOWED_PRIVATE_HOSTS: "127.0.0.1",
  });
  env = loadEnv();
  await migrate(env);
  pool = createPool(env.DATABASE_URL);
  admin = createPool(env.DATABASE_ADMIN_URL!, 2);
  app = createApp({ pool, auth: createAuth(pool, env, { mailConfigured: (await mailSource(pool, env)) !== "none" }), env });
});

after(async () => {
  await pool.end();
  await admin.end();
  box.server.close();
});

test("with no mail anywhere, the first account can still be made and invitations still work", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (line: string) => errors.push(line));
  founder = browser();
  assert.equal((await founder("POST", "/api/auth/sign-up/email", { email: ADMIN, password: PASSWORD, name: "Founder" })).status, 200);
  assert.equal((await founder("POST", "/api/auth/sign-in/email", { email: ADMIN, password: PASSWORD })).status, 200);

  // Before two-step verification, even the administrator is held back.
  assert.equal((await founder("GET", base)).status, 403);
  await secondStep(founder, PASSWORD);

  const { id } = await (await founder("POST", "/api/auth/organization/create", { name: "Alpha", slug: "alpha" })).json() as { id: string };
  workspace = id;
  const invite = await founder("POST", "/api/auth/organization/invite-member", { email: "member@example.test", role: "viewer", organizationId: workspace });
  assert.equal(invite.status, 200);
  const { id: invitationId } = await invite.json() as { id: string };

  outsider = browser();
  assert.equal((await outsider("POST", "/api/auth/sign-up/email", { email: "member@example.test", password: OTHER_PASSWORD, name: "Member", invitationId })).status, 200);
  assert.equal((await outsider("POST", "/api/auth/sign-in/email", { email: "member@example.test", password: OTHER_PASSWORD })).status, 200);
  await secondStep(outsider, OTHER_PASSWORD);

  // The invitation says why it was not mailed, and sign-up does not try to send at all.
  assert.deepEqual(errors.map((line) => JSON.parse(line).event), ["invitation_mail_failed"]);
  assert.match(errors[0]!, /Mail is not set up/);
});

test("with no mail anywhere, reset and verification fail clearly and the same for every address", async () => {
  for (const path of ["/api/auth/request-password-reset", "/api/auth/send-verification-email"]) {
    const known = await browser()("POST", path, { email: ADMIN, redirectTo: "/reset" });
    const unknown = await browser()("POST", path, { email: "nobody@example.test", redirectTo: "/reset" });
    assert.equal(known.status, 400);
    assert.equal(unknown.status, 400);
    const body = await known.text();
    assert.equal(body, await unknown.text());
    assert.match(body, /Mail is not set up/);
  }
  await assert.rejects(createMailer(pool, env)({ to: ADMIN, subject: "x", text: "y" }), MailNotConfigured);
});

test("only the platform administrator can reach mail settings, and others cannot tell they exist", async () => {
  assert.equal((await browser()("GET", base)).status, 401);
  for (const [method, path, body] of [["GET", base], ["PUT", base, settings()], ["POST", `${base}/test`]] as const) {
    const refused = await outsider(method, path, body);
    assert.equal(refused.status, 404, `${method} ${path}`);
    assert.deepEqual(await refused.json(), { error: "Not found." });
  }
  assert.equal(await adminRow(), undefined);
  assert.equal(((await (await outsider("GET", "/api/v1/me")).json()) as any).isPlatformAdmin, false);
  assert.equal(((await (await founder("GET", "/api/v1/me")).json()) as any).isPlatformAdmin, true);
});

test("saving encrypts the password, never shows it, and audits without it", async () => {
  const before = await (await founder("GET", base)).json() as any;
  assert.deepEqual([before.source, before.settings, before.restartNeeded, before.verificationOn], ["none", null, false, false]);

  const saved = await founder("PUT", base, settings());
  assert.equal(saved.status, 200);
  assert.ok(!(await saved.text()).includes(SMTP_PASSWORD));

  const response = await founder("GET", base);
  const text = await response.text();
  assert.ok(!text.includes(SMTP_PASSWORD));
  assert.ok(!/ciphertext/.test(text));
  const shown = JSON.parse(text);
  assert.equal(shown.source, "settings");
  assert.equal(shown.settings.hasPassword, true);
  assert.equal(shown.settings.password, undefined);
  assert.equal(shown.settings.username, "mailer");
  assert.equal(shown.restartNeeded, true);

  const row = await adminRow();
  assert.ok(!row.password_ciphertext.includes(Buffer.from(SMTP_PASSWORD)));
  const stored = { ciphertext: row.password_ciphertext, iv: row.password_iv, tag: row.password_tag };
  assert.equal(decryptSecret(env.SECRETS_MASTER_KEY, MAIL_SCOPE, MAIL_PASSWORD_NAME, stored), SMTP_PASSWORD);
  assert.throws(() => decryptSecret(env.SECRETS_MASTER_KEY, MAIL_SCOPE, "another-name", stored));
  assert.throws(() => decryptSecret(env.SECRETS_MASTER_KEY, workspace, MAIL_PASSWORD_NAME, stored));

  const { rows: audit } = await admin.query("select * from audit_events where action = 'platform.mail_changed' order by seq desc limit 1");
  assert.equal(audit[0].details.passwordChanged, true);
  assert.equal(audit[0].details.host, "127.0.0.1");
  assert.ok(!JSON.stringify(audit[0]).includes(SMTP_PASSWORD));
});

test("a blank password keeps the saved one, but not for a different server", async () => {
  const first = await adminRow();
  assert.equal((await founder("PUT", base, settings({ password: "", fromName: "Renamed" }))).status, 200);
  const kept = await adminRow();
  assert.equal(kept.from_name, "Renamed");
  assert.deepEqual(kept.password_ciphertext, first.password_ciphertext);

  assert.equal((await founder("PUT", base, settings({ password: undefined, username: "changed" }))).status, 200);
  assert.equal((await adminRow()).username, "changed");
  assert.equal((await founder("PUT", base, settings({ password: undefined }))).status, 200);

  const count = async () => (await admin.query("select count(*)::int as n from audit_events where action = 'platform.mail_changed'")).rows[0].n;
  const audited = await count();
  for (const moved of [{ host: "evil.example.test" }, { port: box.port + 1 }]) {
    for (const password of [undefined, ""]) {
      const refused = await founder("PUT", base, settings({ ...moved, password }));
      assert.equal(refused.status, 400);
      assert.match(((await refused.json()) as { error: string }).error, /password again/);
    }
  }
  const after = await adminRow();
  assert.equal(after.host, "127.0.0.1");
  assert.equal(after.port, box.port);
  assert.equal(await count(), audited, "a refused change is not recorded as a change");

  // Spelling a host differently is not a different host.
  assert.equal((await founder("PUT", base, settings({ password: undefined, host: "127.0.0.1" }))).status, 200);
  assert.equal((await founder("PUT", base, settings({ host: "new.example.test", password: SMTP_PASSWORD }))).status, 200);
  assert.equal((await adminRow()).host, "new.example.test");
  assert.equal((await founder("PUT", base, settings({ password: undefined, host: "NEW.example.test" }))).status, 200);
  assert.equal((await adminRow()).host, "new.example.test");
  assert.equal((await founder("PUT", base, settings())).status, 200);
});

test("server activity is for the platform administrator, and holds only entries outside any workspace", async () => {
  const audit = "/api/v1/platform/audit";
  await recordAudit(pool, { action: "auth.sign_in_failed", ip: "203.0.113.9" });
  await recordAudit(pool, { actorId: "someone", action: "platform.mail_changed", targetType: "platform_settings", targetId: "mail" });
  await inWorkspace(pool, workspace, (db) => recordAudit(db, { workspaceId: workspace, action: "workflow.created", targetType: "workflow", targetId: "serveronly" }));

  assert.equal((await outsider("GET", audit)).status, 404, "anyone else cannot tell it exists");
  assert.equal((await browser()("GET", audit)).status, 401);

  const first = await (await founder("GET", audit)).json() as any;
  assert.ok(first.total >= 3, "sign-ins are here too");
  assert.equal(first.chainIntact, true);
  assert.ok(first.head.seq >= first.total);
  assert.ok(first.events.every((event: any) => !event.action.startsWith("workflow.")));
  assert.ok(first.events[0].id > first.events.at(-1).id, "newest first");
  const failed = first.events.find((event: any) => event.action === "auth.sign_in_failed");
  assert.equal(failed.ip, "203.0.113.9");

  const list = async (query: string) => await (await founder("GET", `${audit}?verify=false&${query}`)).json() as any;
  assert.equal((await list("")).chainIntact, undefined);
  assert.equal((await list("action=platform")).events.every((event: any) => event.action.startsWith("platform.")), true);
  assert.equal((await list("action=workflow")).total, 0, "an area outside this list matches nothing");
  assert.equal((await list("q=serveronly")).total, 0, "a workspace's entries cannot be searched from here");
  assert.equal((await list("q=sign%20failed")).events[0].action, "auth.sign_in_failed");
  assert.equal((await list("q=100%25")).total, 0);
  assert.equal((await list(`whenFrom=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`)).total, 0);
  assert.equal((await list("limit=1&offset=1")).events.length, 1);
  assert.ok((await list("limit=1&sort=when&direction=asc")).events[0].id < first.events[0].id);
});

test("the database refuses to read server activity from inside a workspace, and to anyone but its own role", async () => {
  await assert.rejects(inWorkspace(pool, workspace, (db) => db.query("select platform_audit_page('{}', null, null, null, true, 5, 0)")), /cannot be read inside a workspace/);
  const { rows: [function_] } = await admin.query("select prosecdef, proconfig from pg_proc where proname = 'platform_audit_page'");
  assert.equal(function_.prosecdef, true);
  assert.deepEqual(function_.proconfig, ["search_path=public"]);
  const { rows: [grant] } = await admin.query("select has_function_privilege('public', 'platform_audit_page(text[], text[], timestamptz, timestamptz, boolean, integer, integer)', 'execute') as open");
  assert.equal(grant.open, false);
  // The table stays closed to the app role, so the function is the only way in.
  assert.equal((await pool.query("select count(*)::int as n from audit_events where workspace_id is null")).rows[0].n, 0);
});

test("bad settings are refused", async () => {
  for (const bad of [
    { host: "" }, { host: "bad host" }, { host: "smtp.example.test\r\nX: y" }, { port: 0 }, { port: 70000 }, { security: "none" },
    { fromAddress: "not an address" }, { fromAddress: "a@example.test\r\nBcc: b@example.test" }, { fromName: "Name\r\nBcc: b@example.test" },
  ]) {
    assert.equal((await founder("PUT", base, settings(bad))).status, 400, JSON.stringify(bad));
  }
  assert.equal((await founder("PUT", base, null)).status, 400);
});

test("a test email goes only to the administrator's own address", async () => {
  await founder("PUT", base, settings());
  const logins = box.logins.length;
  const count = box.received.length;
  const response = await founder("POST", `${base}/test`, { to: "someone-else@example.test" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true, to: ADMIN, source: "settings" });

  const message = box.received.at(-1)!;
  assert.equal(box.received.length, count + 1);
  assert.deepEqual(message.to, [ADMIN]);
  assert.equal(message.from, "noreply@example.test");
  assert.match(message.text, /Hivelock Mail/);
  assert.deepEqual(box.logins.slice(logins), [{ user: "mailer", pass: SMTP_PASSWORD }]);

  const { rows } = await admin.query("select details from audit_events where action = 'platform.mail_test_sent'");
  assert.equal(rows.length, 1);
});

test("a failed test email gives a safe reason and does not repeat the server's reply", async () => {
  await founder("PUT", base, settings({ password: "wrong-password-canary" }));
  const refused = await founder("POST", `${base}/test`);
  assert.equal(refused.status, 400);
  const text = await refused.text();
  assert.match(text, /refused the username or password/);
  assert.ok(!text.includes("wrong-password-canary"));
  assert.ok(!text.includes("535"));

  await founder("PUT", base, settings({ port: 1, password: SMTP_PASSWORD }));
  const unreachable = await founder("POST", `${base}/test`);
  assert.equal(unreachable.status, 400);
  assert.match(await unreachable.text(), /Could not reach the mail server/);
});

test("private addresses are refused unless the operator allowed them", async () => {
  const count = box.received.length;
  for (const host of ["127.0.0.2", "10.0.0.5", "169.254.169.254", "localhost"]) {
    await founder("PUT", base, settings({ host }));
    const refused = await founder("POST", `${base}/test`);
    assert.equal(refused.status, 400, host);
    const text = await refused.text();
    assert.match(text, /private network/, host);
    assert.ok(!text.includes(SMTP_PASSWORD));
  }
  assert.equal(box.received.length, count);
  await founder("PUT", base, settings());
});

test("a host that is not allowed must use TLS, so a password is never sent in the clear", async () => {
  const policy = { allowedPrivateHosts: [] };
  const starttls = await smtpOptions({ host: "1.1.1.1", port: 587, secure: false, user: "u", password: "p" }, policy);
  assert.deepEqual([starttls.requireTLS, starttls.ignoreTLS, starttls.secure], [true, false, false]);
  const tls = await smtpOptions({ host: "1.1.1.1", port: 465, secure: true, user: "u", password: "p" }, policy);
  assert.deepEqual([tls.requireTLS, tls.ignoreTLS, tls.secure], [true, false, true]);

  // The same options against a server with no STARTTLS: the send stops before any login.
  const logins = box.logins.length;
  const transport = nodemailer.createTransport({ ...starttls, host: "127.0.0.1", port: box.port, tls: undefined });
  await assert.rejects(transport.sendMail({ from: "a@example.test", to: "b@example.test", text: "x" }), (error: { code?: string }) => error.code === "ETLS");
  assert.equal(box.logins.length, logins);

  const allowed = await smtpOptions({ host: "127.0.0.1", port: 25, secure: false }, { allowedPrivateHosts: ["127.0.0.1"] });
  assert.deepEqual([allowed.requireTLS, allowed.ignoreTLS, allowed.auth], [false, true, undefined]);
});

test("saved settings win over the environment, which stays as the fallback", async () => {
  const fallback = await mailbox();
  const withEnv = { ...env, SMTP_URL: `smtp://127.0.0.1:${fallback.port}?ignoreTLS=true`, MAIL_FROM: "Env <env@example.test>" };
  const mail = createMailer(pool, withEnv);
  try {
    await clearSaved();
    assert.equal(await mailSource(pool, withEnv), "environment");
    await mail({ to: "a@example.test", subject: "one", text: "one" });
    assert.equal(fallback.received.length, 1);
    assert.equal(fallback.received[0]!.from, "env@example.test");

    // Picked up on the next message, with no restart.
    await founder("PUT", base, settings());
    assert.equal(await mailSource(pool, withEnv), "settings");
    const count = box.received.length;
    await mail({ to: "a@example.test", subject: "two", text: "two" });
    assert.equal(fallback.received.length, 1);
    assert.equal(box.received.length, count + 1);
  } finally {
    fallback.server.close();
  }
});

test("the environment's address and password are never shown", async () => {
  const withEnv = { ...env, SMTP_URL: "smtp://user:env-password-canary@mail.example.test", MAIL_FROM: "env@example.test" };
  const normal = app;
  app = createApp({ pool, auth: createAuth(pool, withEnv), env: withEnv });
  await clearSaved();
  try {
    const response = await founder("GET", base);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes("env-password-canary"));
    assert.ok(!text.includes("mail.example.test"));
    assert.equal(JSON.parse(text).source, "environment");
    assert.equal(JSON.parse(text).environmentConfigured, true);
  } finally {
    app = normal;
  }
  await founder("PUT", base, settings());
});

test("the limited role cannot read the table, and the functions do nothing inside a workspace", async () => {
  await assert.rejects(pool.query("select * from platform_mail_settings"), (error: { code?: string }) => error.code === "42501");
  await assert.rejects(pool.query("update platform_mail_settings set host = 'x'"), (error: { code?: string }) => error.code === "42501");
  await assert.rejects(pool.query("delete from platform_mail_settings"), (error: { code?: string }) => error.code === "42501");
  assert.ok(await readMailSettings(pool), "outside a workspace the function reads the row");

  const inside = await inWorkspace(pool, workspace, (db) => readMailSettings(db));
  assert.equal(inside, undefined);
  await assert.rejects(inWorkspace(pool, workspace, (db) => db.query("select platform_mail_write('h', 25, 'tls', '', null, null, null, 'a@b.test', '', 'x')")), /inside a workspace/);
  assert.ok(await readMailSettings(pool), "a setting from a workspace transaction does not linger on the connection");
});

test("mail that fails gives the same answer for known and unknown addresses", async () => {
  await founder("PUT", base, settings({ port: 1, password: SMTP_PASSWORD }));
  for (const path of ["/api/auth/request-password-reset", "/api/auth/send-verification-email"]) {
    const known = await browser()("POST", path, { email: ADMIN, redirectTo: "/reset" });
    const unknown = await browser()("POST", path, { email: "nobody@example.test", redirectTo: "/reset" });
    assert.equal(known.status, 200, path);
    assert.equal(unknown.status, 200, path);
    assert.equal(await known.text(), await unknown.text(), path);
  }
  await founder("PUT", base, settings());
});

test("after a restart with mail saved, verification is on and unconfirmed accounts can get back in", async () => {
  const mailConfigured = (await mailSource(pool, env)) !== "none";
  assert.equal(mailConfigured, true);
  const restarted = createApp({ pool, auth: createAuth(pool, env, { mailConfigured }), env });
  const person = browser(() => restarted);

  const count = box.received.length;
  assert.equal((await person("POST", "/api/auth/sign-in/email", { email: ADMIN, password: PASSWORD })).status, 403);
  assert.equal(box.received.length, count + 1);
  const message = box.received.at(-1)!.text.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  assert.deepEqual(box.received.at(-1)!.to, [ADMIN]);
  const link = new URL(message.match(/http:\/\/localhost:4320\/\S+/)![0]);
  assert.ok([200, 302].includes((await person("GET", link.pathname + link.search)).status));

  const signedIn = await person("POST", "/api/auth/sign-in/email", { email: ADMIN, password: PASSWORD });
  assert.equal(signedIn.status, 200);
  assert.equal(((await signedIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect, true);

  const status = await (await founder("GET", base)).json() as any;
  assert.equal(status.restartNeeded, true, "the server that started without mail still needs its restart");
});

test("a database from before these settings reads as having none, so the server can still start", async () => {
  const empty = createPool(env.DATABASE_ADMIN_URL!.replace(DB, "postgres"), 1);
  try {
    assert.equal(await readMailSettings(empty), undefined);
    assert.equal(await mailSource(empty, env), "none");
  } finally {
    await empty.end();
  }
});

test("production starts without mail in the environment, and says so", (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => warnings.push(line));
  const saved = { NODE_ENV: process.env.NODE_ENV, PUBLIC_URL: process.env.PUBLIC_URL };
  Object.assign(process.env, { NODE_ENV: "production", PUBLIC_URL: "https://hivelock.example.test" });
  try {
    assert.equal(loadEnv().NODE_ENV, "production");
  } finally {
    Object.assign(process.env, saved);
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /SMTP_URL and MAIL_FROM are not set/);
});

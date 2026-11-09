import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { SMTPServer } from "smtp-server";
import { createApp } from "../src/platform/app.ts";
import { createAuth } from "../src/platform/auth.ts";
import { createPool } from "../src/platform/db.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";

const ORIGIN = "http://localhost:4320";
const OLD_PASSWORD = "first long password here";
const NEW_PASSWORD = "second long password here";

let smtp: SMTPServer;
let mail: string[] = [];
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

let env: PlatformEnv;

function browser(ip: string) {
  const cookies = new Map<string, string>();
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method, redirect: "manual",
      headers: { origin: ORIGIN, "x-real-ip": ip, "content-type": "application/json", cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
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

function totp(uri: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of new URL(uri).searchParams.get("secret")!.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1)! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Mail bodies may wrap long lines, so this joins them before reading the link. */
const linkIn = (message: string) => message.replace(/=\r?\n/g, "").replace(/=3D/g, "=").match(/http:\/\/localhost:4320\/\S+/)![0];

async function waitForMail(count: number) {
  for (let i = 0; i < 50 && mail.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(mail.length >= count, "no mail arrived");
  return mail.at(-1)!;
}

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query("drop database if exists agent_platform_test_mail with (force)");
  await bootstrap.query("create database agent_platform_test_mail");
  await bootstrap.end();

  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ["STARTTLS"],
    onData: (stream, _, done) => {
      let text = "";
      stream.on("data", (chunk) => (text += chunk));
      stream.on("end", () => {
        mail.push(text);
        done();
      });
    },
  });
  await new Promise<void>((ready) => smtp.listen(0, "127.0.0.1", () => ready()));
  const port = (smtp.server.address() as { port: number }).port;

  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://agent_platform_mail_app:test-only@localhost/agent_platform_test_mail",
    DATABASE_ADMIN_URL: "postgres:///agent_platform_test_mail",
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass",
    SECRETS_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    PUBLIC_URL: ORIGIN,
    BOOTSTRAP_ADMIN_EMAIL: "founder@example.test",
    SMTP_URL: `smtp://127.0.0.1:${port}?ignoreTLS=true`,
    MAIL_FROM: "Hivelock <noreply@example.test>",
  });
  env = loadEnv();
  await migrate(env);
  pool = createPool(env.DATABASE_URL);
  app = createApp({ pool, auth: createAuth(pool, env), env });
});

after(async () => {
  await pool.end();
  smtp.close();
});

test("with mail set up, an address must be confirmed before signing in", async () => {
  const person = browser("10.1.0.1");
  assert.equal((await person("POST", "/api/auth/sign-up/email", { email: "founder@example.test", password: OLD_PASSWORD, name: "Founder" })).status, 200);
  const message = await waitForMail(1);
  const refused = await person("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: OLD_PASSWORD });
  assert.equal(refused.status, 403);
  // The sign-in page reads this code to explain that a link was mailed.
  assert.equal((await refused.json()).code, "EMAIL_NOT_VERIFIED");

  const link = new URL(linkIn(message));
  assert.ok([200, 302].includes((await person("GET", link.pathname + link.search)).status));
  assert.equal((await person("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: OLD_PASSWORD })).status, 200);
});

test("someone who knows an invited address cannot take the invitation", async () => {
  const founder = browser("10.1.0.2");
  await founder("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: OLD_PASSWORD });
  const { totpURI } = await (await founder("POST", "/api/auth/two-factor/enable", { password: OLD_PASSWORD })).json() as { totpURI: string };
  assert.equal((await founder("POST", "/api/auth/two-factor/verify-totp", { code: totp(totpURI) })).status, 200);
  const { id: workspace } = await (await founder("POST", "/api/auth/organization/create", { name: "Mail", slug: "mail" })).json() as { id: string };

  const count = mail.length;
  const invite = await founder("POST", "/api/auth/organization/invite-member", { email: "invited@example.test", role: "viewer", organizationId: workspace });
  assert.equal(invite.status, 200);
  const { id: invitation } = await invite.json() as { id: string };
  assert.match(await waitForMail(count + 1), /invited@example\.test/);

  const attacker = browser("10.1.0.3");
  const signUp = { email: "invited@example.test", password: "attacker password here", name: "Attacker" };
  assert.equal((await attacker("POST", "/api/auth/sign-up/email", signUp)).status, 403);
  assert.equal((await attacker("POST", "/api/auth/sign-in/email", { email: signUp.email, password: signUp.password })).status, 401);
  assert.notEqual((await attacker("POST", "/api/auth/organization/accept-invitation", { invitationId: invitation })).status, 200);

  const invitee = browser("10.1.0.7");
  const mailCount = mail.length;
  assert.equal((await invitee("POST", "/api/auth/sign-up/email", { ...signUp, password: "the real invitee password", name: "Invitee", invitationId: invitation })).status, 200);
  assert.ok(new URL(linkIn(await waitForMail(mailCount + 1))).pathname.includes("verify-email"));
  const { rows } = await pool.query(`select count(*)::int as n from member where "organizationId" = $1`, [workspace]);
  assert.equal(rows[0].n, 1);
});

test("a password can be reset by email, and old sessions end", async () => {
  const session = browser("10.1.0.4");
  await session("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: OLD_PASSWORD });

  const count = mail.length;
  const person = browser("10.1.0.5");
  assert.equal((await person("POST", "/api/auth/request-password-reset", { email: "founder@example.test", redirectTo: "/reset" })).status, 200);
  const link = new URL(linkIn(await waitForMail(count + 1)));
  const token = link.pathname.split("/").at(-1)!;

  assert.notEqual((await person("POST", "/api/auth/reset-password", { token: "wrong-token", newPassword: NEW_PASSWORD })).status, 200);
  assert.equal((await person("POST", "/api/auth/reset-password", { token, newPassword: NEW_PASSWORD })).status, 200);
  assert.notEqual((await person("POST", "/api/auth/reset-password", { token, newPassword: "third long password here" })).status, 200, "a reset link works once");

  assert.equal((await person("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: OLD_PASSWORD })).status, 401);
  const after = await person("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: NEW_PASSWORD });
  assert.equal(after.status, 200);
  assert.equal(((await after.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect, true, "a reset must not skip two-step verification");
  assert.equal((await session("GET", "/api/v1/me")).status, 401);
});

test("a name that carries a link or a line break never reaches an invitation", async () => {
  const { rows: [{ id: userId }] } = await pool.query(`select id from "user" where email = 'founder@example.test'`);
  const workspace = (await pool.query(`select "organizationId" as id from member where "userId" = $1 limit 1`, [userId])).rows[0].id as string;
  const auth = createAuth(pool, env, { mailConfigured: true });
  const send = auth.options.plugins.find((plugin) => plugin.id === "organization")!.options!.sendInvitationEmail as (data: unknown) => Promise<void>;
  const invitationMail = async (workspaceName: string, inviterName: string) => {
    const count = mail.length;
    await send({ email: "someone@example.test", role: "viewer", id: "invitation-id", inviter: { user: { name: inviterName } }, organization: { id: workspace, name: workspaceName } });
    return (await waitForMail(count + 1)).replace(/=\r?\n/g, "");
  };

  const plain = await invitationMail("Acme Valves", "Ann Lee");
  assert.match(plain, /Subject: Join Acme Valves on Hivelock/);
  assert.match(plain, /Ann Lee invited you to Acme Valves as viewer/);

  for (const name of ["Visit https://evil.test/login now", "evil.test", "www.evil.test", "evil\uFF0Etest", "evil\u3002test", "//evil.test", "help@evil.test", "Acme\r\nBcc: x@evil.test", "Acme\u202Eevil", "x".repeat(81)]) {
    const text = await invitationMail(name, name);
    assert.match(text, /Subject: Join a workspace on Hivelock/, name);
    assert.match(text, /A teammate invited you to a workspace as viewer/, name);
    assert.doesNotMatch(text, /evil/, name);
  }
});

test("a stranger's password does not survive the owner confirming the address in another browser", async () => {
  const founder = browser("10.1.0.9");
  const signedIn = await founder("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: NEW_PASSWORD });
  assert.equal(signedIn.status, 200);
  const { rows: [{ id: workspace, inviter }] } = await pool.query(`select m."organizationId" as id, m."userId" as inviter from member m join "user" u on u.id = m."userId" where u.email = 'founder@example.test' limit 1`);
  const email = "squatted@example.test";
  const invitation = randomUUID();
  await pool.query(`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId", "createdAt") values ($1, $2, $3, 'viewer', 'pending', now() + interval '1 day', $4, now())`, [invitation, workspace, email, inviter]);

  const stranger = browser("10.1.0.10");
  const count = mail.length;
  assert.equal((await stranger("POST", "/api/auth/sign-up/email", { email, password: "the stranger's password", name: "Stranger", invitationId: invitation })).status, 200);
  const link = new URL(linkIn(await waitForMail(count + 1)));

  const owner = browser("10.1.0.11");
  const before = mail.length;
  assert.ok([200, 302].includes((await owner("GET", link.pathname + link.search)).status));
  assert.equal((await pool.query(`select "emailVerified" from "user" where email = $1`, [email])).rows[0].emailVerified, true);
  assert.equal((await stranger("POST", "/api/auth/sign-in/email", { email, password: "the stranger's password" })).status, 401);

  // The owner gets a link to choose their own, and that works.
  const reset = new URL(linkIn(await waitForMail(before + 1)));
  assert.equal(reset.pathname.includes("reset-password"), true);
  assert.equal((await owner("POST", "/api/auth/reset-password", { token: reset.pathname.split("/").at(-1)!, newPassword: "the real owner's password" })).status, 200);
  assert.equal((await owner("POST", "/api/auth/sign-in/email", { email, password: "the real owner's password" })).status, 200);
});

test("asking to reset an unknown address looks the same as a known one", async () => {
  const count = mail.length;
  const response = await browser("10.1.0.6")("POST", "/api/auth/request-password-reset", { email: "nobody@example.test", redirectTo: "/reset" });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mail.length, count);
});

test("sign-ins, password changes and workspace changes reach the audit log", async () => {
  const admin = new pg.Client({ connectionString: "postgres:///agent_platform_test_mail" });
  await admin.connect();
  const { rows } = await admin.query("select distinct action from audit_events");
  await admin.end();
  const actions = rows.map((r) => r.action);
  for (const action of ["auth.signed_in", "auth.password_reset", "workspace.created", "member.added", "member.invited"]) {
    assert.ok(actions.includes(action), `${action} missing from ${actions}`);
  }
});

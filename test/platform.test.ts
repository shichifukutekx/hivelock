import "./licensed.ts";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../src/platform/app.ts";
import { createAuth } from "../src/platform/auth.ts";
import { createPool, inWorkspace } from "../src/platform/db.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";
import { can } from "../src/platform/permissions.ts";
import { decryptSecret, encryptSecret, readSecret } from "../src/platform/secrets.ts";

const ADMIN_URL = "postgres:///agent_platform_test";
const PASSWORD = "correct horse battery staple";
const ORIGIN = "http://localhost:4320";
const masterKey = Buffer.alloc(32, 7).toString("base64");

const settings = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://agent_platform_test_app:test-only@localhost/agent_platform_test",
  DATABASE_ADMIN_URL: ADMIN_URL,
  BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass",
  SECRETS_MASTER_KEY: masterKey,
  PUBLIC_URL: ORIGIN,
  BOOTSTRAP_ADMIN_EMAIL: "founder@example.test",
};

let env: PlatformEnv;
let pool: pg.Pool;
let adminPool: pg.Pool;
let app: ReturnType<typeof createApp>;

/** A small browser: keeps cookies and sends the site's own origin. */
function browser(ip = "10.0.0.1") {
  const cookies = new Map<string, string>();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: {
        origin: ORIGIN, "x-real-ip": ip, "content-type": "application/json",
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      cookies.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  };
  return { call, cookies };
}

function totp(uri: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const encoded = new URL(uri).searchParams.get("secret")!;
  let bits = "";
  for (const char of encoded.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g)!.map((b) => parseInt(b, 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function signUp(person: ReturnType<typeof browser>, email: string, invitationId?: string) {
  return person.call("POST", "/api/auth/sign-up/email", { email, password: PASSWORD, name: email.split("@")[0], invitationId });
}

async function enableTwoFactor(person: ReturnType<typeof browser>) {
  const enabled = await (await person.call("POST", "/api/auth/two-factor/enable", { password: PASSWORD })).json() as { totpURI: string };
  const verified = await person.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(enabled.totpURI) });
  assert.equal(verified.status, 200);
  return enabled.totpURI;
}

const createWorkspace = async (person: ReturnType<typeof browser>, name: string) => {
  const response = await person.call("POST", "/api/auth/organization/create", { name, slug: name.toLowerCase() });
  assert.equal(response.status, 200);
  return ((await response.json()) as { id: string }).id;
};

const founder = browser("10.0.0.2");
const reader = browser("10.0.0.3");
let founderUri: string;
let workspaceA: string;
let workspaceB: string;

before(async () => {
  const reset = new pg.Client({ connectionString: ADMIN_URL });
  await reset.connect();
  await reset.query("drop schema public cascade; create schema public;");
  await reset.end();
  Object.assign(process.env, settings);
  env = loadEnv();
  await migrate(env);
  pool = createPool(env.DATABASE_URL);
  adminPool = createPool(ADMIN_URL, 2);
  app = createApp({ pool, auth: createAuth(pool, env), env });
});

after(async () => {
  await pool.end();
  await adminPool.end();
});

test("settings are refused when unsafe, and errors never show values", () => {
  const saved = { ...process.env };
  try {
    process.env.SECRETS_MASTER_KEY = "too-short";
    assert.throws(loadEnv, (error: Error) => /SECRETS_MASTER_KEY/.test(error.message) && !error.message.includes("too-short"));
    Object.assign(process.env, { SECRETS_MASTER_KEY: masterKey, NODE_ENV: "production", PUBLIC_URL: "http://example.test" });
    assert.throws(loadEnv, /https/);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("the app role has no special database powers", async () => {
  const { rows } = await pool.query("select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user");
  assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
});

test("sign-up is closed to everyone except the bootstrap address", async () => {
  assert.equal((await signUp(browser(), "stranger@example.test")).status, 403);
  assert.equal((await signUp(founder, "founder@example.test")).status, 200);
  assert.equal((await signUp(browser(), "stranger@example.test")).status, 403);
  assert.equal((await signUp(browser(), "founder2@example.test")).status, 403);
});

test("nothing works until two-step verification is on", async () => {
  const blocked = await founder.call("GET", "/api/v1/me");
  assert.equal(blocked.status, 403);
  assert.equal(((await blocked.json()) as { code: string }).code, "two_factor_required");
  assert.equal((await founder.call("POST", "/api/auth/organization/create", { name: "Early", slug: "early" })).status, 403);
  assert.equal((await browser().call("GET", "/api/v1/me")).status, 401);
});

test("unusual path spellings cannot get around two-step verification", async () => {
  for (const path of [
    "/api/auth//organization/create",
    "/api/auth/%6frganization/create",
    "/api/auth/ORGANIZATION/create",
    "/api/auth/./organization/create",
    "/api/auth/organization%2Fcreate",
  ]) {
    const response = await founder.call("POST", path, { name: "Sneak", slug: "sneak" });
    assert.notEqual(response.status, 200, path);
  }
  const { rows } = await adminPool.query("select count(*)::int as n from organization");
  assert.equal(rows[0].n, 0);
});

test("after enabling it, a password alone does not sign in", async () => {
  founderUri = await enableTwoFactor(founder);
  assert.equal((await founder.call("GET", "/api/v1/me")).status, 200);

  const person = browser("10.0.0.4");
  const signIn = await person.call("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: PASSWORD });
  assert.equal(((await signIn.json()) as { twoFactorRedirect: boolean }).twoFactorRedirect, true);
  assert.equal((await person.call("GET", "/api/v1/me")).status, 401);
  assert.notEqual((await person.call("POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status, 200);
  assert.equal((await person.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(founderUri) })).status, 200);
  assert.equal((await person.call("GET", "/api/v1/me")).status, 200);
});

test("secret values are stored encrypted and no route returns them", async () => {
  workspaceA = await createWorkspace(founder, "Alpha");
  workspaceB = await createWorkspace(founder, "Bravo");
  const path = `/api/v1/workspaces/${workspaceA}/secrets`;
  assert.equal((await founder.call("PUT", `${path}/API_TOKEN`, { value: "plain-text-canary" })).status, 200);
  assert.equal((await founder.call("PUT", `${path}/bad name`, { value: "x" })).status, 400);

  const list = await (await founder.call("GET", path)).text();
  assert.match(list, /API_TOKEN/);
  assert.doesNotMatch(list, /plain-text-canary|ciphertext/);

  const { rows } = await adminPool.query("select ciphertext::text as raw from secrets");
  assert.doesNotMatch(rows[0].raw, /plain-text-canary/);
  assert.doesNotMatch(Buffer.from(rows[0].raw.slice(2), "hex").toString("latin1"), /plain-text-canary/);

  const value = await inWorkspace(pool, workspaceA, (db) => readSecret(db, masterKey, workspaceA, "API_TOKEN"));
  assert.equal(value, "plain-text-canary");
});

test("a moved or altered secret cannot be decrypted", () => {
  const stored = encryptSecret(masterKey, "workspace-1", "TOKEN", "value");
  assert.equal(decryptSecret(masterKey, "workspace-1", "TOKEN", stored), "value");
  assert.throws(() => decryptSecret(masterKey, "workspace-2", "TOKEN", stored));
  assert.throws(() => decryptSecret(masterKey, "workspace-1", "OTHER", stored));
  const altered = { ...stored, ciphertext: Buffer.from(stored.ciphertext) };
  altered.ciphertext[0]! ^= 1;
  assert.throws(() => decryptSecret(masterKey, "workspace-1", "TOKEN", altered));
});

test("the database keeps workspaces apart even if the app's query forgets to", async () => {
  await founder.call("PUT", `/api/v1/workspaces/${workspaceB}/secrets/OTHER_TOKEN`, { value: "bravo" });
  const seen = await inWorkspace(pool, workspaceA, async (db) => (await db.query("select name from secrets")).rows);
  assert.deepEqual(seen.map((r) => r.name), ["API_TOKEN"]);
  assert.equal((await pool.query("select * from secrets")).rowCount, 0);
  await assert.rejects(inWorkspace(pool, workspaceA, (db) =>
    db.query(`insert into secrets (workspace_id, name, ciphertext, iv, tag, key_version, created_by)
              values ($1, 'PLANTED', '\\x00', '\\x00', '\\x00', 1, 'x')`, [workspaceB])), /row-level security/);
});

test("an invited person gets only their role, in only that workspace", async () => {
  const email = "viewer@example.test";
  const invite = await founder.call("POST", "/api/auth/organization/invite-member", { email, role: "viewer", organizationId: workspaceA });
  assert.equal(invite.status, 200);
  const { id } = await invite.json() as { id: string };

  assert.equal((await signUp(browser(), email)).status, 403, "knowing the address must not be enough");
  assert.equal((await signUp(browser(), email, randomUUID())).status, 403);
  assert.equal((await signUp(reader, email, id)).status, 200);
  await enableTwoFactor(reader);
  assert.equal((await reader.call("POST", "/api/auth/organization/accept-invitation", { invitationId: id })).status, 200);

  const secrets = `/api/v1/workspaces/${workspaceA}/secrets`;
  assert.equal((await reader.call("GET", secrets)).status, 403);
  assert.equal((await reader.call("PUT", `${secrets}/SNEAK`, { value: "x" })).status, 403);
  assert.equal((await reader.call("DELETE", `${secrets}/API_TOKEN`)).status, 403);
  assert.equal((await reader.call("GET", `/api/v1/workspaces/${workspaceA}/audit`)).status, 403);

  assert.equal((await reader.call("GET", `/api/v1/workspaces/${workspaceB}/secrets`)).status, 404);
  assert.equal((await reader.call("GET", "/api/v1/workspaces/does-not-exist/secrets")).status, 404);
  const me = await (await reader.call("GET", "/api/v1/me")).json() as { workspaces: { role: string }[] };
  assert.deepEqual(me.workspaces.map((w) => w.role), ["viewer"]);
});

test("an invited person cannot open a workspace and become its owner", async () => {
  const made = await reader.call("POST", "/api/auth/organization/create", { name: "Mine", slug: "mine" });
  assert.notEqual(made.status, 200);
  const me = await (await reader.call("GET", "/api/v1/me")).json() as { canCreateWorkspaces: boolean };
  assert.equal(me.canCreateWorkspaces, false);
});

test("sign-up gives the same reply whether or not someone was invited", async () => {
  const invite = await founder.call("POST", "/api/auth/organization/invite-member", { email: "pending@example.test", role: "viewer", organizationId: workspaceA });
  assert.equal(invite.status, 200);
  const invited = await signUp(browser(), "pending@example.test");
  const stranger = await signUp(browser(), "unknown@example.test");
  assert.deepEqual([invited.status, await invited.text()], [stranger.status, await stranger.text()]);
});

test("a session opened before two-step setup does not survive it, and devices cannot be remembered", async () => {
  const email = "two-sessions@example.test";
  const invite = await founder.call("POST", "/api/auth/organization/invite-member", { email, role: "viewer", organizationId: workspaceA });
  const { id } = await invite.json() as { id: string };
  const first = browser("10.0.1.1");
  assert.equal((await signUp(first, email, id)).status, 200);
  const second = browser("10.0.1.2");
  assert.equal((await second.call("POST", "/api/auth/sign-in/email", { email, password: PASSWORD })).status, 200);
  await enableTwoFactor(second);
  assert.equal((await second.call("GET", "/api/v1/me")).status, 200);
  assert.equal((await first.call("GET", "/api/v1/me")).status, 401);
  assert.equal((await second.call("POST", "/api/auth/two-factor/verify-totp", { code: "000000", trustDevice: true })).status, 400);
});

test("reset tokens never reach the request log", async () => {
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => logged.push(line);
  try {
    await app.request("/api/auth/reset-password/secret-reset-token-value?callbackURL=/", { headers: { origin: ORIGIN } });
  } finally {
    console.log = original;
  }
  assert.ok(logged.some((line) => line.includes("[token]")));
  assert.ok(!logged.join("").includes("secret-reset-token-value"));
});

test("simultaneous writers cannot break the audit chain", async () => {
  const seeded = createPool(env.DATABASE_URL, 16);
  try {
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(Array.from({ length: 32 }, (_, i) => seeded.query(
        "insert into audit_events (workspace_id, action) values ($1, $2)", [workspaceA, `burst.${round}.${i}`],
      )));
    }
  } finally {
    await seeded.end();
  }
  const { rows: [check] } = await pool.query("select audit_chain_break($1) as broken", [workspaceA]);
  assert.equal(check.broken, null);
  const log = await (await founder.call("GET", `/api/v1/workspaces/${workspaceA}/audit`)).json() as { head: { seq: string; hash: string } };
  assert.equal(log.head.hash.length, 64);
});

test("each role has exactly the expected powers", () => {
  assert.equal(can("owner", "workspace:delete"), true);
  assert.equal(can("admin", "workspace:delete"), false);
  assert.equal(can("admin", "secrets:write"), true);
  assert.equal(can("builder", "secrets:write"), false);
  assert.equal(can("builder", "workflows:write"), true);
  assert.equal(can("operator", "workflows:write"), false);
  assert.equal(can("operator", "runs:approve"), true);
  assert.equal(can("viewer", "runs:start"), false);
  assert.equal(can("hacker", "content:read"), false);
  assert.equal(can(undefined, "content:read"), false);
});

test("the audit log records actions, and the app cannot change it", async () => {
  const log = await (await founder.call("GET", `/api/v1/workspaces/${workspaceA}/audit`)).json() as { events: { action: string }[]; chainIntact: boolean };
  assert.ok(log.events.some((e) => e.action === "secret.saved"));
  assert.equal(log.chainIntact, true);
  await assert.rejects(pool.query("update audit_events set action = 'x'"), /permission denied/);
  await assert.rejects(pool.query("delete from audit_events"), /permission denied/);
  await assert.rejects(adminPool.query("update audit_events set action = 'x'"), /cannot be changed/);
  await assert.rejects(adminPool.query("truncate audit_events"), /cannot be changed/);
});

test("repeated password guesses are slowed down and logged", async () => {
  const attacker = browser("10.0.0.9");
  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    const response = await attacker.call("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: "wrong password here" });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `statuses were ${statuses}`);
  const { rows } = await adminPool.query("select count(*)::int as n from audit_events where action = 'auth.sign_in_failed'");
  assert.ok(rows[0].n >= 1);
});

test("forged forwarded headers do not get around the limit", async () => {
  const statuses = [];
  for (let i = 0; i < 8; i += 1) {
    const response = await browser("10.0.0.10").call("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: "wrong password here" }, { "x-forwarded-for": `1.2.3.${i}` });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `statuses were ${statuses}`);
});

test("cross-site requests are refused and responses carry safety headers", async () => {
  const forged = await app.request(`/api/v1/workspaces/${workspaceA}/secrets/FORGED`, {
    method: "PUT",
    headers: { origin: "https://evil.example", "content-type": "text/plain", cookie: [...founder.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: JSON.stringify({ value: "x" }),
  });
  assert.equal(forged.status, 403);
  const page = await app.request("/health");
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await founder.call("GET", "/api/v1/me")).headers.get("cache-control"), "no-store");
});

test("oversized requests are refused, and internal errors reveal nothing", async () => {
  const big = await founder.call("PUT", `/api/v1/workspaces/${workspaceA}/secrets/BIG_TOKEN`, { value: "x".repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const broken = createApp({ pool: { query: () => Promise.reject(new Error("password=hunter2")) } as never, auth: { api: { getSession: async () => ({ user: { id: "u", twoFactorEnabled: true } }) } } as never, env });
  const response = await broken.request("/api/v1/me", { headers: { origin: ORIGIN } });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /hunter2/);
});

test("tampering with the audit log is detected", async () => {
  await adminPool.query("alter table audit_events disable trigger audit_events_append_only");
  await adminPool.query("update audit_events set details = '{\"forged\":true}' where workspace_id = $1 and id = (select min(id) from audit_events where workspace_id = $1)", [workspaceA]);
  await adminPool.query("alter table audit_events enable trigger audit_events_append_only");
  const log = await (await founder.call("GET", `/api/v1/workspaces/${workspaceA}/audit`)).json() as { chainIntact: boolean };
  assert.equal(log.chainIntact, false);
});

test("the server reports health and readiness", async () => {
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/ready")).status, 200);
});

test("a person may turn two-step sign-in off for their own account, with their password, and back on", async () => {
  const person = browser("10.0.0.77");
  assert.equal((await person.call("POST", "/api/auth/sign-in/email", { email: "founder@example.test", password: PASSWORD })).status, 200);
  assert.equal((await person.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(founderUri) })).status, 200);
  assert.deepEqual(await (await person.call("GET", "/api/v1/me/two-factor")).json(), { enabled: true, optedOut: false, singleSignOn: false });

  assert.equal((await person.call("POST", "/api/v1/me/two-factor/off", { password: "not-the-password" })).status, 403);
  assert.equal((await person.call("POST", "/api/v1/me/two-factor/off", { password: PASSWORD })).status, 200);
  assert.deepEqual(await (await person.call("GET", "/api/v1/me/two-factor")).json(), { enabled: false, optedOut: true, singleSignOn: false });
  assert.equal((await person.call("GET", "/api/v1/me")).status, 200, "the password alone now opens the account");
  assert.equal((await founder.call("GET", "/api/v1/me")).status, 401, "other sessions were signed out");

  // Someone who never chose this still needs the second step.
  assert.equal((await adminPool.query("select count(*)::int as n from two_factor_opt_outs")).rows[0].n, 1);

  founderUri = await enableTwoFactor(person);
  assert.deepEqual(await (await person.call("GET", "/api/v1/me/two-factor")).json(), { enabled: true, optedOut: false, singleSignOn: false });
  assert.equal((await adminPool.query("select count(*)::int as n from two_factor_opt_outs")).rows[0].n, 0);
});

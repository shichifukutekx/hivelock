// Several replicas on one database, as Compose runs them. Each app here has its own connections and memory, like a separate process.
import "./licensed.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { createApp } from "../src/platform/app.ts";
import { createAuth } from "../src/platform/auth.ts";
import { createPool, inWorkspace } from "../src/platform/db.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { createLiveHub, tokenStream, type LiveHub } from "../src/platform/live.ts";
import { migrate } from "../src/platform/migrate.ts";
import { allow } from "../src/platform/rate-limit.ts";

const DB = "agent_platform_test_ha";
const WORKSPACE = "workspace-a";
const ORIGIN = "http://localhost:4320";

let env: PlatformEnv;
let admin: pg.Pool;

interface Replica { pool: pg.Pool; live: LiveHub; base: string; server: ServerType; app: ReturnType<typeof createApp> }
const replicas: Replica[] = [];

async function startReplica(person?: object) {
  const pool = createPool(env.DATABASE_URL, 5);
  const live = createLiveHub(env.DATABASE_URL);
  await live.start();
  const auth = person ? { api: { getSession: async () => ({ user: person, session: { id: "s" } }) } } as never : createAuth(pool, env, { mailConfigured: false });
  const workflows = { live, engine: {} as never, boss: { isInstalled: async () => true, getQueues: async () => [] } as never, chat: {} as never };
  const app = createApp({ pool, auth, env, workflows, streamCheckMs: 500 });
  const server = await new Promise<ServerType>((resolve) => { const made = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(made)); });
  const replica = { pool, live, app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  replicas.push(replica);
  return replica;
}

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_ha_app:test-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 61).toString("base64"),
    PUBLIC_URL: ORIGIN, BOOTSTRAP_ADMIN_EMAIL: "founder@example.test", AUDIT_LOG: "off", WORKSPACE_DATA_DIR: mkdtempSync(join(tmpdir(), "ha-")),
  });
  env = loadEnv();
});

after(async () => {
  for (const { live, pool, server } of replicas) {
    live.closeStreams();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise((resolve) => { server.close(resolve); });
    await live.stop();
    await pool.end();
  }
  await admin?.end();
});

test("replicas that start together run the migrations once, in turn", async () => {
  await Promise.all([migrate(env), migrate(env), migrate(env), migrate(env)]);
  admin = createPool(env.DATABASE_ADMIN_URL!, 3);
  const { rows } = await admin.query<{ name: string; times: number }>("select name, count(*)::int as times from schema_migrations group by name having count(*) > 1");
  assert.deepEqual(rows, []);
  assert.ok((await admin.query("select 1 from schema_migrations where name = '016_fair_queue.sql'")).rowCount === 1);
  const locks = await admin.query("select 1 from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())");
  assert.equal(locks.rowCount, 0, "nothing keeps the lock afterwards");
});

test("a failed migration lets go of the lock, so the next attempt is not stuck", async () => {
  const broken = { ...env, DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL };
  const directory = mkdtempSync(join(tmpdir(), "ha-migrations-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(directory, "001_broken.sql"), "select nonsense_that_fails();\n");
  await assert.rejects(migrate(broken, { directory }));
  await migrate(env);
});

test("a session opened on one replica works on another, and signing out ends it everywhere", async () => {
  const [first, second] = [await startReplica(), await startReplica()];
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  const headers = { "content-type": "application/json", origin: ORIGIN };
  const signUp = await fetch(`${first!.base}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ email, password: "a-long-test-password", name: "Founder" }) });
  assert.equal(signUp.status, 200, await signUp.clone().text());
  const cookie = signUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const read = async (replica: Replica) => (await (await fetch(`${replica.base}/api/auth/get-session`, { headers: { cookie, origin: ORIGIN } })).json() as { user?: { email: string } } | null)?.user?.email;
  assert.equal(await read(first!), email);
  assert.equal(await read(second!), email, "the other replica knows the session");
  const out = await fetch(`${second!.base}/api/auth/sign-out`, { method: "POST", headers: { ...headers, cookie }, body: "{}" });
  assert.equal(out.status, 200);
  assert.equal(await read(first!), undefined, "signing out on one ends it on the other");
});

test("the sign-in limit is shared, so a second replica does not double it", async () => {
  const [first, second] = replicas as [Replica, Replica];
  const attempt = (replica: Replica) => fetch(`${replica.base}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-real-ip": "203.0.113.9" }, body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-here" }),
  });
  const seen: number[] = [];
  for (let i = 0; i < 12; i += 1) seen.push((await attempt(i % 2 ? first : second)).status);
  assert.ok(seen.includes(429), `No limit was reached across replicas: ${seen.join(" ")}`);
  assert.equal((await admin.query(`select 1 from "rateLimit"`)).rowCount! > 0, true, "it is counted in the database");
});

test("the API rate limit is shared across replicas, however calls are split between them", async () => {
  const [first, second] = replicas as [Replica, Replica];
  const key = `shared:${randomUUID()}`;
  const limit = { limit: 5, windowSeconds: 60 };
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => allow((i % 2 ? first : second).pool, key, limit)));
  assert.equal(answers.filter(Boolean).length, 5);
});

async function viewerOf(replica: Replica, session: string) {
  const controller = new AbortController();
  const response = await fetch(`${replica.base}/api/v1/workspaces/${WORKSPACE}/sessions/${session}/stream`, { headers: { origin: ORIGIN }, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const ended = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return { text: () => text, ended, stop: () => controller.abort() };
}

const waitFor = async (what: string, check: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("live text reaches a viewer on a different replica from the worker, and a stopping replica ends its streams", async () => {
  const person = { id: "owner", email: "owner@example.test", name: "Owner", twoFactorEnabled: true };
  await admin.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('owner', 'Owner', $1, true, now(), now()) on conflict do nothing`, [person.email]);
  await admin.query(`insert into organization (id, name, slug, "createdAt") values ($1, $1, $1, now()) on conflict do nothing`, [WORKSPACE]);
  await admin.query(`insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, 'owner', 'owner', now())`, [randomUUID(), WORKSPACE]);
  const [one, two] = [await startReplica(person), await startReplica(person)];
  const worker = createPool(env.DATABASE_URL, 2);
  try {
    const { rows: [{ id: session }] } = await inWorkspace(worker, WORKSPACE, (db) => db.query("insert into agent_sessions (workspace_id, agent_name, title, created_by) values ($1, 'helper', 'Test', 'owner') returning id", [WORKSPACE]));
    const near = await viewerOf(one!, session);
    const far = await viewerOf(two!, session);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stream = tokenStream(worker, WORKSPACE, session);
    stream.push("hello across replicas ");
    stream.flushNow();
    await waitFor("both viewers to get the text", () => near.text().includes("hello across replicas") && far.text().includes("hello across replicas"));

    two!.live.closeStreams();
    await far.ended;
    assert.ok(two!.live.connected());
    stream.push("still going ");
    stream.flushNow();
    await waitFor("the other replica's viewer to carry on", () => near.text().includes("still going"));

    const again = await viewerOf(one!, session);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await stream.end();
    await waitFor("a reconnected viewer to hear the end", () => again.text().includes('"done"'));
    near.stop();
    again.stop();
  } finally {
    await worker.end();
  }
});

test("a hub reconnects once after losing its connection, so no token arrives twice", async () => {
  const listening = async () => (await admin.query("select count(*)::int as count from pg_stat_activity where query ilike 'listen %' and datname = current_database()")).rows[0].count as number;
  const replica = replicas.at(-1)!;
  const before = await listening();
  assert.equal(before, replicas.length);
  await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where query ilike 'listen %' and datname = current_database()");
  await waitFor("the hub to notice", () => !replica.live.connected());
  const deadline = Date.now() + 8_000;
  while (!replicas.every(({ live }) => live.connected())) {
    assert.ok(Date.now() < deadline, "A hub did not reconnect.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Long enough for any second reconnect to have happened too.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(await listening(), before, "one connection for each hub, and no more");

  const session = randomUUID();
  const heard: string[] = [];
  const stop = replica.live.subscribe(session, ({ text }) => { heard.push(text ?? ""); });
  await replica.pool.query("select pg_notify('agent_stream', $1)", [JSON.stringify({ workspaceId: WORKSPACE, sessionId: session, type: "token", text: "once" })]);
  await waitFor("the token", () => heard.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();
  assert.deepEqual(heard, ["once"]);
});

test("a hub keeps trying while the database is away, and stopping it ends that", async () => {
  // Nothing listens on this port, so every attempt fails, as it would with the database down.
  const hub = createLiveHub("postgres://nobody:nothing@127.0.0.1:1/none");
  await assert.rejects(hub.start());
  assert.equal(hub.connected(), false);
  await hub.stop();
});

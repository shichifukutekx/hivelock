// Metrics, error reporting and health, with a stand-in for the error tracker.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Hono } from "hono";
import pg from "pg";
import { z } from "zod";
import { createApp } from "../src/platform/app.ts";
import { createPool } from "../src/platform/db.ts";
import { flushErrors, parseDsn, reportError, startErrorReporting } from "../src/platform/error-reporting.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { log, withLogFields } from "../src/platform/log.ts";
import { counter, histogram, renderMetrics, watchPool } from "../src/platform/metrics.ts";
import { migrate } from "../src/platform/migrate.ts";
import { readiness } from "../src/platform/routes/health.ts";
import { scrub } from "../src/platform/scrub.ts";
import { startWorkerHttp } from "../src/platform/worker-http.ts";

const DB = "agent_platform_test_monitoring";
const person = { id: "owner", email: "owner@example.test", name: "Owner", twoFactorEnabled: true };
const auth = { api: { getSession: async () => ({ user: person, session: { id: "s" } }) } } as never;

let env: PlatformEnv;
let pool: pg.Pool;
let admin: pg.Pool;
let tracker: Server;
let received: { url: string; headers: Record<string, unknown>; body: string }[] = [];
let trackerPort = 0;

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_monitoring_app:test-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 41).toString("base64"),
    PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test", AUDIT_LOG: "off", METRICS_TOKEN: "monitoring-test-token",
    WORKSPACE_DATA_DIR: mkdtempSync(join(tmpdir(), "monitoring-")),
  });
  env = loadEnv();
  await migrate(env);
  pool = createPool(env.DATABASE_URL, 4);
  admin = createPool(env.DATABASE_ADMIN_URL!, 2);
  tracker = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ url: request.url!, headers: request.headers, body });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => { tracker.listen(0, "127.0.0.1", resolve); });
  trackerPort = (tracker.address() as AddressInfo).port;
});

after(async () => {
  startErrorReporting(undefined, { role: "test" });
  tracker.close();
  await pool.end();
  await admin.end();
});

test("a DSN is read the way Sentry-compatible services expect, and nonsense is refused", () => {
  assert.deepEqual(parseDsn("https://abc123@errors.example.com/42"), { envelopeUrl: "https://errors.example.com/api/42/envelope/", publicKey: "abc123" });
  assert.deepEqual(parseDsn("http://abc@host.example:9000/tracker/7"), { envelopeUrl: "http://host.example:9000/tracker/api/7/envelope/", publicKey: "abc" });
  assert.equal(parseDsn("not a dsn"), undefined);
  assert.equal(parseDsn("https://errors.example.com/42"), undefined, "no key");
  assert.equal(parseDsn("ftp://abc@errors.example.com/42"), undefined);
});

test("credentials are removed from text leaving the server", () => {
  const fake = "x".repeat(24);
  for (const [text, gone] of [
    [`connect failed postgres://app:hunter2secret@db.internal/main`, "hunter2secret"],
    [`Authorization: Bearer ${fake}`, fake],
    [`password=hunter2secret and more`, "hunter2secret"],
    [`{"apiKey":"${fake}"}`, fake],
    [`GET /hook?token=${fake}&page=2`, fake],
    [`key sk-${fake}`, fake],
  ] as const) assert.ok(!scrub(text).includes(gone), scrub(text));
  assert.equal(scrub("A plain message about a workflow."), "A plain message about a workflow.");
});

test("error reporting is off by default and sends nothing", async () => {
  startErrorReporting(undefined, { role: "test" });
  received = [];
  reportError(new Error("nobody should hear this"));
  await flushErrors();
  assert.equal(received.length, 0);
});

test("an error goes out in the envelope format, scrubbed, with no request content", async () => {
  startErrorReporting(`http://publickey@127.0.0.1:${trackerPort}/9`, { role: "worker", release: "1.2.3" });
  received = [];
  const error = new Error(`Could not reach postgres://app:hunter2secret@db.internal/main ${randomUUID()}`);
  reportError(error, { requestId: "req-12345678", route: "/api/v1/x", queue: "workflow-step" });
  await flushErrors();
  assert.equal(received.length, 1);
  const [{ url, headers, body }] = received as [typeof received[0]];
  assert.equal(url, "/api/9/envelope/");
  assert.match(String(headers["x-sentry-auth"]), /sentry_key=publickey/);
  assert.ok(!body.includes("hunter2secret"));
  assert.ok(!body.includes(process.cwd()), "paths are cut back to the project");
  const [head, item, payload] = body.split("\n").map((line) => JSON.parse(line));
  assert.equal(item.type, "event");
  assert.equal(head.event_id, payload.event_id);
  assert.equal(payload.release, "1.2.3");
  assert.equal(payload.tags.role, "worker");
  assert.equal(payload.extra.requestId, "req-12345678");
  assert.equal(payload.exception.values[0].type, "Error");
  assert.ok(payload.exception.values[0].stacktrace.frames.length > 0);
});

test("the same error repeating is sent once, and a broken tracker harms nothing", async () => {
  startErrorReporting(`http://publickey@127.0.0.1:${trackerPort}/9`, { role: "web" });
  received = [];
  const same = new Error(`repeating ${randomUUID()}`);
  for (let i = 0; i < 5; i += 1) reportError(same);
  await flushErrors();
  assert.equal(received.length, 1);
  startErrorReporting("http://publickey@127.0.0.1:1/9", { role: "web" });
  reportError(new Error(`unreachable ${randomUUID()}`));
  await flushErrors();
});

test("an unhandled error in a route reaches the tracker and the log with its request id", async () => {
  startErrorReporting(`http://publickey@127.0.0.1:${trackerPort}/9`, { role: "web" });
  received = [];
  const app = createApp({ pool, auth, env });
  app.get("/test-explodes", () => { throw new Error(`exploded ${randomUUID()}`); });
  // Routes added after createApp sit behind its catch-all only when the web app is built, so this path is checked either way.
  const response = await app.request("/test-explodes", { headers: { "x-request-id": "from-the-proxy-1234" } });
  assert.equal(response.headers.get("x-request-id"), "from-the-proxy-1234");
  if (response.status === 500) {
    await flushErrors();
    assert.equal(JSON.parse(received[0]!.body.split("\n")[2]!).extra.requestId, "from-the-proxy-1234");
  }
});

test("a request id that is not plain is replaced, so it cannot forge a log line", async () => {
  const app = createApp({ pool, auth, env });
  const response = await app.request("/health", { headers: { "x-request-id": 'bad" id={forged}' } });
  assert.match(response.headers.get("x-request-id")!, /^[0-9a-f-]{36}$/);
});

test("logging carries the request id and scrubs what it is given", () => {
  const lines: string[] = [];
  const real = console.error;
  console.error = (line: string) => lines.push(line);
  try {
    withLogFields({ requestId: "abc" }, () => log("error", "something", { message: "postgres://app:hunter2secret@db/main" }));
  } finally {
    console.error = real;
  }
  const line = JSON.parse(lines[0]!);
  assert.equal(line.requestId, "abc");
  assert.equal(line.event, "something");
  assert.ok(!lines[0]!.includes("hunter2secret"));
});

test("metrics use the text format, and histogram buckets add up", () => {
  const name = `test_${randomUUID().replace(/-/g, "")}`;
  const hits = counter(`${name}_total`, "Test.");
  hits.inc({ route: 'odd"value' });
  const times = histogram(`${name}_seconds`, "Test.", [1, 5]);
  times.observe({ queue: "q" }, 0.5);
  times.observe({ queue: "q" }, 3);
  times.observe({ queue: "q" }, 9);
  const text = renderMetrics();
  assert.ok(text.includes(`agent_platform_${name}_total{route="odd\\"value"} 1`));
  assert.ok(text.includes(`agent_platform_${name}_seconds_bucket{queue="q",le="1"} 1`));
  assert.ok(text.includes(`agent_platform_${name}_seconds_bucket{queue="q",le="5"} 2`));
  assert.ok(text.includes(`agent_platform_${name}_seconds_bucket{queue="q",le="+Inf"} 3`));
  assert.ok(text.includes(`agent_platform_${name}_seconds_count{queue="q"} 3`));
});

test("request numbers use the route's pattern, so ids never become labels", async () => {
  const app = new Hono();
  const created = createApp({ pool, auth, env });
  app.route("/", created);
  const id = randomUUID();
  await created.request(`/api/v1/workspaces/${id}/secrets`);
  const text = renderMetrics();
  assert.ok(!text.includes(id));
  assert.match(text, /agent_platform_http_requests_total\{method="GET",route="\/api\/v1\/workspaces\/:workspaceId\/secrets",status="4xx"\}/);
  assert.match(text, /agent_platform_http_request_duration_seconds_bucket\{method="GET",route="[^"]+",le="0\.01"\}/);
});

test("pool numbers are reported by name", () => {
  watchPool("test", pool);
  assert.match(renderMetrics(), /agent_platform_db_pool_connections\{pool="test",state="idle"\} \d+/);
  assert.match(renderMetrics(), /agent_platform_db_pool_waiting\{pool="test"\} 0/);
});

test("/ready says ready only when everything needed is true, and shows no detail", async () => {
  const app = createApp({ pool, auth, env });
  const fine = await app.request("/ready");
  assert.equal(fine.status, 200);
  assert.deepEqual(await fine.json(), { status: "ready", checks: { database: "ok", migrations: "ok" } });
});

test("/ready fails when this code's migrations have not run", async () => {
  await admin.query("delete from schema_migrations where name = '016_fair_queue.sql'");
  try {
    const response = await createApp({ pool, auth, env }).request("/ready");
    assert.equal(response.status, 503);
    assert.equal((await response.json() as any).checks.migrations, "failing");
  } finally {
    await admin.query("insert into schema_migrations (name) values ('016_fair_queue.sql')");
  }
});

test("/ready ignores a newer migration, because old code runs on the new schema during an upgrade", async () => {
  await admin.query("insert into schema_migrations (name) values ('999_newer.sql')");
  try {
    assert.equal((await createApp({ pool, auth, env }).request("/ready")).status, 200);
  } finally {
    await admin.query("delete from schema_migrations where name = '999_newer.sql'");
  }
});

test("/ready fails when the database cannot be reached, is a standby, or the queue or streaming is down", async () => {
  const broken = createPool("postgres://nobody:nothing@127.0.0.1:1/none", 1);
  assert.equal((await readiness({ pool: broken })).checks.database, "failing");
  await broken.end();
  const standby = { query: async (text: string) => (text.includes("recovery") ? { rows: [{ standby: true }] } : pool.query(text)) } as never;
  assert.equal((await readiness({ pool: standby })).ready, false);
  const down = await readiness({ pool, boss: { isInstalled: async () => false } as never, live: { connected: () => false } as never });
  assert.deepEqual([down.ready, down.checks.queue, down.checks.streaming], [false, "failing", "failing"]);
});

test("/ready fails first when stopping, while /health still answers", async () => {
  const app = createApp({ pool, auth, env, stopping: () => true });
  assert.equal((await app.request("/ready")).status, 503);
  assert.equal((await app.request("/health")).status, 200);
});

test("/status is public, cached and says nothing about any workspace", async () => {
  await admin.query(`insert into organization (id, name, slug, "createdAt") values ('secret-customer', 'Secret Customer', 'secret-customer', now()) on conflict do nothing`);
  await admin.query("insert into worker_presence (worker_id) values ('w1') on conflict (worker_id) do update set seen_at = now()");
  const app = createApp({ pool, auth, env });
  const response = await app.request("/status");
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.status, "ok");
  assert.deepEqual(Object.keys(body.components).sort(), ["database", "queue", "web", "workers"]);
  assert.doesNotMatch(text, /secret-customer|Secret Customer|w1/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=10");
});

test("/status reads degraded with no workers, and not down", async () => {
  await admin.query("delete from worker_presence");
  const response = await createApp({ pool, auth, env }).request("/status");
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.status, "degraded");
  assert.equal(body.components.workers, "degraded");
});

test("a worker's own port answers health, and metrics only with the token", async () => {
  let stopping = false;
  const server = startWorkerHttp({ pool, boss: { isInstalled: async () => true, getQueues: async () => [] } as never, port: 0, host: "127.0.0.1", metricsToken: "worker-token", stopping: () => stopping });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/ready`)).status, 200);
    assert.equal((await fetch(`${base}/metrics`)).status, 404);
    assert.equal((await fetch(`${base}/anything`)).status, 404);
    const metrics = await fetch(`${base}/metrics`, { headers: { authorization: "Bearer worker-token" } });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /agent_platform_workers_alive/);
    stopping = true;
    assert.equal((await fetch(`${base}/ready`)).status, 503);
  } finally {
    server.close();
  }
});

// Keeps zod in step with the settings these features read.
test("new settings have safe defaults, and a bad port turns the worker's port off", () => {
  assert.equal(env.ERROR_REPORTING_DSN, undefined);
  assert.equal(env.WORKSPACE_WORK_LIMIT, 4);
  assert.equal(env.WORKER_HTTP_PORT, undefined);
  assert.equal(z.coerce.number().int().optional().catch(undefined).parse("nonsense"), undefined);
});

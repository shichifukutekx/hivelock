// Measures real throughput against a throwaway database. Usage: npx tsx scripts/load-test.ts [runs] [workers]
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { createApp } from "../src/platform/app.ts";
import { createPool } from "../src/platform/db.ts";
import { createEngine } from "../src/platform/engine/engine.ts";
import { registerNodeType } from "../src/platform/engine/nodes.ts";
import { createBoss, startWorker } from "../src/platform/engine/queue.ts";
import { loadExtensions } from "../src/platform/extensions.ts";
import { loadEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";
import { LIMITS } from "../src/platform/rate-limit.ts";

const RUNS = Number(process.argv[2] ?? 300);
const WORKERS = Number(process.argv[3] ?? 1);
const WORKSPACES = 4;
const DB = "agent_platform_load";

const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
await bootstrap.connect();
await bootstrap.query(`drop database if exists ${DB} with (force)`);
await bootstrap.query(`create database ${DB}`);
await bootstrap.end();

Object.assign(process.env, {
  NODE_ENV: "test", AUDIT_LOG: "off",
  DATABASE_URL: `postgres://agent_platform_load_app:load-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
  BETTER_AUTH_SECRET: "a-load-test-only-secret-that-is-long-enough", SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  PUBLIC_URL: "http://localhost:4399", BOOTSTRAP_ADMIN_EMAIL: "load@example.test",
});
LIMITS.user.limit = 1e9;
LIMITS.runStart.limit = 1e9;
const quiet = console.log;
console.log = () => {};

registerNodeType("load-echo", { label: "Echo", configSchema: z.object({}), run: async ({}, { data }) => ({ output: data.input }) });

await loadExtensions();
const env = loadEnv();
await migrate(env);
const pool = createPool(env.DATABASE_URL, 30);
const admin = createPool(env.DATABASE_ADMIN_URL, 3);
const spaces = Array.from({ length: WORKSPACES }, (_, i) => `load-${i}`);
await admin.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('load', 'Load', 'load@example.test', true, now(), now())`);
for (const id of spaces) {
  await admin.query(`insert into organization (id, name, slug, "createdAt") values ($1, $1, $1, now())`, [id]);
  await admin.query(`insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, 'load', 'owner', now())`, [randomUUID(), id]);
}

const options = { masterKey: env.SECRETS_MASTER_KEY, network: { allowedPrivateHosts: [] } };
const boss = createBoss(env.DATABASE_URL, "api");
await boss.start();
const engine = createEngine(pool, boss, options);
const workers = [];
for (let i = 0; i < WORKERS; i += 1) {
  const worker = createBoss(env.DATABASE_URL, "worker");
  await worker.start();
  await startWorker(worker, pool, createEngine(pool, worker, options));
  workers.push(worker);
}
const auth = { api: { getSession: async () => ({ user: { id: "load", twoFactorEnabled: true } }) } };
const app = createApp({ pool, auth: auth as never, env, workflows: { engine, boss } });
const server = serve({ fetch: app.fetch, port: 4399, hostname: "127.0.0.1" });
const base = "http://127.0.0.1:4399";
const call = (method: string, path: string, body?: unknown) => fetch(base + path, {
  method, headers: { "content-type": "application/json", origin: env.PUBLIC_URL }, body: body === undefined ? undefined : JSON.stringify(body),
});

const flows = new Map<string, string>();
for (const id of spaces) {
  const made = await call("POST", `/api/v1/workspaces/${id}/workflows`, {
    name: "Load",
    definition: {
      nodes: [{ id: "start", type: "start" }, { id: "a", type: "load-echo" }, { id: "b", type: "load-echo" }, { id: "c", type: "load-echo" }],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "c" }],
    },
  });
  flows.set(id, ((await made.json()) as { id: string }).id);
}

const percentile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.floor(values.length * share)]!.toFixed(0);

/** Runs tasks with a fixed number going at once. */
async function pooled(count: number, width: number, task: (index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < count) await task(next++);
  }));
}

const started = Date.now();
let accepted = 0;
let backedOff = 0;
const startTimes: number[] = [];
await pooled(RUNS, 20, async (index) => {
  const id = spaces[index % WORKSPACES]!;
  for (;;) {
    const at = performance.now();
    const response = await call("POST", `/api/v1/workspaces/${id}/workflows/${flows.get(id)}/runs`, { input: { index } });
    startTimes.push(performance.now() - at);
    await response.text();
    if (response.status === 202) {
      accepted += 1;
      return;
    }
    backedOff += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

let finished = 0;
for (;;) {
  const { rows: [row] } = await admin.query("select count(*) filter (where status = 'succeeded')::int as done, count(*) filter (where status = 'failed')::int as failed from runs");
  finished = row.done + row.failed;
  if (finished >= accepted || Date.now() - started > 300_000) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const seconds = (Date.now() - started) / 1000;
const { rows: [outcome] } = await admin.query("select count(*) filter (where status = 'succeeded')::int as ok, count(*) filter (where status = 'failed')::int as failed from runs");

const reads: number[] = [];
const readStart = Date.now();
await pooled(3_000, 50, async (index) => {
  const id = spaces[index % WORKSPACES]!;
  const at = performance.now();
  const response = await call("GET", `/api/v1/workspaces/${id}/runs`);
  await response.text();
  reads.push(performance.now() - at);
});
const readSeconds = (Date.now() - readStart) / 1000;

quiet(JSON.stringify({
  workers: WORKERS, runs: RUNS, steps: RUNS * 4, succeeded: outcome.ok, failed: outcome.failed, secondsToFinish: seconds,
  runsPerSecond: Number((outcome.ok / seconds).toFixed(1)), stepsPerSecond: Number(((outcome.ok * 4) / seconds).toFixed(1)),
  refusedByActiveRunLimit: backedOff, startP50ms: percentile(startTimes, 0.5), startP95ms: percentile(startTimes, 0.95),
  readsPerSecond: Math.round(3_000 / readSeconds), readP50ms: percentile(reads, 0.5), readP95ms: percentile(reads, 0.95), readP99ms: percentile(reads, 0.99),
}));

await boss.stop({ graceful: false });
for (const worker of workers) await worker.stop({ graceful: false });
server.close();
await pool.end();
await admin.end();
process.exit(0);

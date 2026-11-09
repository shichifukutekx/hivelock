// Proves the workers are shared fairly: real Postgres, real pg-boss, several workers, and a worker killed outright.
import "./licensed.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { createAgentChat } from "../src/platform/agent-chat.ts";
import { createPool, inWorkspace } from "../src/platform/db.ts";
import { createEngine, STEP_QUEUE, type Engine } from "../src/platform/engine/engine.ts";
import type { FairQueue } from "../src/platform/engine/fair-queue.ts";
import { registerNodeType } from "../src/platform/engine/nodes.ts";
import { createBoss, startWorker } from "../src/platform/engine/queue.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { databaseMetrics, jobDuration, queueDeferrals, queueWait, renderMetrics } from "../src/platform/metrics.ts";
import { migrate } from "../src/platform/migrate.ts";

const DB = "agent_platform_test_fair";
const A = "workspace-busy";
const B = "workspace-quiet";
const network = { allowedPrivateHosts: [] };

let env: PlatformEnv;
let pool: pg.Pool;
let admin: pg.Pool;
let engine: Engine;
const workers: { boss: PgBoss; fair: FairQueue }[] = [];

// Tells how many steps run at once in each workspace, across every worker in this process.
const runningNow = new Map<string, number>();
const peak = new Map<string, number>();
let holdOpen: Promise<void> | undefined;
registerNodeType("test-slow", {
  label: "Slow", configSchema: z.object({ ms: z.number() }),
  run: async ({ ms }, { workspaceId }) => {
    const now = (runningNow.get(workspaceId) ?? 0) + 1;
    runningNow.set(workspaceId, now);
    peak.set(workspaceId, Math.max(peak.get(workspaceId) ?? 0, now));
    try {
      await new Promise((resolve) => setTimeout(resolve, ms));
      await holdOpen;
      return { output: "done" };
    } finally {
      runningNow.set(workspaceId, runningNow.get(workspaceId)! - 1);
    }
  },
});
// The real worker in test/crash-worker.ts hangs on this step. Here it finishes.
registerNodeType("test-crash", { label: "Crash", configSchema: z.object({}), run: async () => ({ output: "finished by the second worker" }) });

async function startOneWorker(limit: number, concurrency = 3, options: { leaseSeconds?: number; sweepSeconds?: number } = {}) {
  const boss = createBoss(env.DATABASE_URL, "worker", { superviseIntervalSeconds: 1, monitorIntervalSeconds: 1 });
  await boss.start();
  const own = createEngine(pool, boss, { masterKey: env.SECRETS_MASTER_KEY, network, retryDelay: 1, heartbeatSeconds: 10 });
  process.env.WORKSPACE_WORK_LIMIT = String(limit);
  const fair = await startWorker(boss, pool, own, concurrency, undefined, undefined, options);
  const worker = { boss, fair };
  workers.push(worker);
  return worker;
}

async function stopWorkers() {
  for (const { boss } of workers.splice(0)) await boss.stop({ graceful: false });
}

const slowFlow = async (workspace: string, ms: number, nodeType = "test-slow") => {
  const id = randomUUID();
  await inWorkspace(pool, workspace, (db) => db.query(
    "insert into workflows (id, workspace_id, name, definition, enabled, created_by) values ($1, $2, $3, $4, true, 'owner')",
    [id, workspace, `flow-${id}`, JSON.stringify({ nodes: [{ id: "start", type: "start", config: {} }, { id: "s", type: nodeType, config: nodeType === "test-slow" ? { ms } : {} }], edges: [{ from: "start", to: "s" }] })],
  ));
  return id;
};

const startRuns = async (workspace: string, workflowId: string, count: number) => {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push((await engine.startRun({ workspaceId: workspace, workflowId, input: {}, triggerKind: "manual", maxActive: 10_000 }))!);
  return ids;
};

const statuses = (workspace: string) => inWorkspace(pool, workspace, async (db) => {
  const { rows } = await db.query<{ status: string; count: number }>("select status, count(*)::int as count from runs group by status");
  return Object.fromEntries(rows.map(({ status, count }) => [status, count])) as Record<string, number>;
});

const waitUntil = async (what: string, check: () => Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const count = async (table: string) => Number((await admin.query(`select count(*) from ${table}`)).rows[0].count);

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_fair_app:test-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 21).toString("base64"),
    PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test", AUDIT_LOG: "off", WORKSPACE_DATA_DIR: mkdtempSync(join(tmpdir(), "fair-queue-")),
  });
  env = loadEnv();
  await migrate(env);
  pool = createPool(env.DATABASE_URL, 40);
  admin = createPool(env.DATABASE_ADMIN_URL!, 4);
  for (const id of [A, B]) await admin.query(`insert into organization (id, name, slug, "createdAt") values ($1, $1, $1, now())`, [id]);
  await admin.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('owner', 'Owner', 'owner@example.test', true, now(), now())`);
  const boss = createBoss(env.DATABASE_URL, "api");
  await boss.start();
  workers.push({ boss, fair: undefined as never });
  engine = createEngine(pool, boss, { masterKey: env.SECRETS_MASTER_KEY, network, retryDelay: 1, heartbeatSeconds: 10 });
});

beforeEach(async () => {
  const sender = workers.shift()!;
  await stopWorkers();
  workers.push(sender);
  holdOpen = undefined;
  peak.clear();
  runningNow.clear();
  await admin.query("delete from runs");
  await admin.query("delete from work_leases");
  await admin.query("delete from work_waiting");
  await admin.query("delete from pgboss.job");
});

after(async () => {
  for (const { boss } of workers.splice(0)) await boss.stop({ graceful: false });
  await pool.end();
  await admin.end();
});

test("a flood from one workspace does not starve another, and nothing is lost", async () => {
  process.env.WORKSPACE_WORK_LIMIT = "2";
  const flood = await slowFlow(A, 120);
  const quiet = await slowFlow(B, 20);
  await startRuns(A, flood, 60);
  assert.ok(Number((await admin.query("select count(*) from pgboss.job where name = $1 and state = 'created'", [STEP_QUEUE])).rows[0].count) <= 2, "the backlog stays out of the shared queue");
  await startOneWorker(2);
  await startOneWorker(2);

  // Each of these waits for the last, so they measure how long a quiet workspace waits with the flood in progress.
  const waits: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const started = Date.now();
    const [run] = await startRuns(B, quiet, 1);
    await waitUntil("the quiet workspace's run", async () => (await inWorkspace(pool, B, (db) => db.query("select status from runs where id = $1", [run]))).rows[0].status === "succeeded", 10_000);
    waits.push(Date.now() - started);
  }
  const during = await statuses(A);
  assert.ok((during.running ?? 0) > 20, `The flood must still be going when the quiet workspace has finished, and ${during.running ?? 0} of 60 runs are left.`);
  assert.ok(Math.max(...waits) < 5_000, `The quiet workspace waited ${Math.max(...waits)} ms at worst.`);

  await waitUntil("the flood to finish", async () => (await statuses(A)).succeeded === 60, 60_000);
  assert.deepEqual(await statuses(A), { succeeded: 60 }, "every run of the flood finishes, and none fails");
  assert.equal(peak.get(A), 2, "the limit holds across both workers");
  assert.ok(queueDeferrals.value({ queue: STEP_QUEUE }) > 0);
  await waitUntil("places to come back", async () => (await count("work_leases")) === 0 && (await count("work_waiting")) === 0, 5_000);
  const { rows: failed } = await admin.query("select id from pgboss.job where state = 'failed'");
  assert.equal(failed.length, 0, "held-back work is never failed");
});

test("work created over the limit waits outside the queue, and a queued job keeps its place", async () => {
  process.env.WORKSPACE_WORK_LIMIT = "1";
  const flow = await slowFlow(A, 1);
  const [first, second] = await startRuns(A, flow, 2);
  const queued = await admin.query("select data->>'runId' as run from pgboss.job where name = $1 and state = 'created'", [STEP_QUEUE]);
  assert.deepEqual(queued.rows.map(({ run }) => run), [first]);
  const { rows: waiting } = await admin.query("select data->>'runId' as run from work_waiting where released_at is null");
  assert.deepEqual(waiting.map(({ run }) => run), [second]);
});

test("the limit holds when many workers ask at the same moment", async () => {
  const ask = (i: number) => pool.query<{ granted: boolean }>("select * from work_acquire($1, $2, $3, $4, $5, 3, 60, false)", [A, STEP_QUEUE, `race:${i}`, JSON.stringify({ workspaceId: A }), `worker-${i % 4}`]);
  const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => ask(i)));
  assert.equal(answers.filter(({ rows }) => rows[0]!.granted).length, 3);
  assert.equal(await count("work_waiting"), 27);
  assert.equal(await count("work_leases"), 3);
});

test("one workspace's places leave the other's alone", async () => {
  const ask = (workspace: string, key: string) => pool.query<{ granted: boolean }>("select * from work_acquire($1, $2, $3, $4, 'w', 1, 60, false)", [workspace, STEP_QUEUE, key, JSON.stringify({ workspaceId: workspace })]);
  assert.equal((await ask(A, "a1")).rows[0]!.granted, true);
  assert.equal((await ask(A, "a2")).rows[0]!.granted, false);
  assert.equal((await ask(B, "b1")).rows[0]!.granted, true);
});

test("a newcomer cannot jump the line or take a place being held for waiting work", async () => {
  const ask = (key: string) => pool.query<{ granted: boolean }>("select * from work_acquire($1, $2, $3, $4, 'w', 1, 60, false)", [A, STEP_QUEUE, key, JSON.stringify({ workspaceId: A, key })]);
  assert.equal((await ask("first")).rows[0]!.granted, true);
  assert.equal((await ask("second")).rows[0]!.granted, false);
  await pool.query("select work_release('first', 'w')");
  assert.equal((await ask("third")).rows[0]!.granted, false, "second is older");
  const claimed = await pool.query<{ job_key: string }>("select job_key from work_claim($1, 1)", [A]);
  assert.deepEqual(claimed.rows.map(({ job_key }) => job_key), ["second"]);
  assert.equal((await ask("fourth")).rows[0]!.granted, false, "the place is held for second");
  assert.equal((await ask("second")).rows[0]!.granted, true);
});

test("a turn key reused while its lease is held goes back to waiting, and does not sit on a place for half an hour", async () => {
  const key = "turn:reused";
  const job = JSON.stringify({ workspaceId: A, sessionId: "reused" });
  const ask = () => pool.query<{ granted: boolean }>("select * from work_acquire($1, 'agent-turn', $2, $3, 'w', 2, 60, false)", [A, key, job]);
  assert.equal((await ask()).rows[0]!.granted, true, "the first turn is running");
  // Its answer is saved and the conversation is free, a moment before its lease is released, and the next message is admitted.
  assert.equal((await pool.query("select work_admit($1, 'agent-turn', $2, $3, 2) as admitted", [A, key, job])).rows[0].admitted, true);
  assert.equal((await ask()).rows[0]!.granted, false, "its job reached a worker too soon");
  assert.deepEqual((await admin.query("select released_at from work_waiting where job_key = $1", [key])).rows, [{ released_at: null }]);
  await pool.query("select work_release($1, 'w')", [key]);
  const claimed = await pool.query<{ job_key: string }>("select job_key from work_claim($1, 2)", [A]);
  assert.deepEqual(claimed.rows.map(({ job_key }) => job_key), [key], "the next message goes straight back on the queue");
});

test("a worker killed outright gives its place back when the lease runs out, and held-back work carries on", async () => {
  process.env.WORKSPACE_WORK_LIMIT = "1";
  const hung = await slowFlow(A, 0, "test-crash");
  const after = await slowFlow(A, 5);
  const [first] = await startRuns(A, hung, 1);
  const child = spawn(process.execPath, ["--import", "tsx", "test/crash-worker.ts"], { env: { ...process.env, TEST_LEASE_SECONDS: "2" }, stdio: "ignore" });
  await waitUntil("the worker to start the step", async () => (await inWorkspace(pool, A, (db) => db.query("select 1 from run_steps where run_id = $1 and node_id = 's' and status = 'running'", [first]))).rowCount === 1);
  const [second] = await startRuns(A, after, 1);
  await waitUntil("the second run to be held back", async () => (await count("work_waiting")) === 1);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  const killedAt = Date.now();
  await startOneWorker(1, 2, { leaseSeconds: 2, sweepSeconds: 1 });
  await waitUntil("held-back work to run", async () => (await inWorkspace(pool, A, (db) => db.query("select status from runs where id = $1", [second]))).rows[0].status === "succeeded", 20_000);
  assert.ok(Date.now() - killedAt < 15_000, "a dead worker must not keep its place until the queue notices");
});

test("a stopping worker hands back unfinished steps without using up an attempt, and another worker finishes them", async () => {
  let open = () => {};
  holdOpen = new Promise((resolve) => { open = resolve; });
  process.env.WORKSPACE_WORK_LIMIT = "1";
  const flow = await slowFlow(A, 1);
  const [run] = await startRuns(A, flow, 1);
  const stopping = await startOneWorker(1, 1, { sweepSeconds: 100 });
  const step = () => inWorkspace(pool, A, async (db) => (await db.query("select status, attempt from run_steps where run_id = $1 and node_id = 's'", [run])).rows[0]);
  await waitUntil("the step to start", async () => (await step())?.status === "running");
  assert.equal((await step()).attempt, 1);

  assert.equal(await stopping.fair.drain(50), 1);
  assert.equal((await step()).attempt, 0, "being stopped is not the step's fault");
  assert.equal(await count("work_leases"), 0);
  assert.equal(await count("work_waiting"), 1, "the step is safe in the database");
  open();
  await stopping.boss.stop({ graceful: false });

  holdOpen = undefined;
  await startOneWorker(1, 1, { sweepSeconds: 1 });
  await waitUntil("another worker to finish it", async () => (await statuses(A)).succeeded === 1);
});

test("a stopping worker ends an unfinished turn with a message, because it cannot safely run twice", async () => {
  const boss = workers[0]!.boss;
  const chat = createAgentChat(pool, boss, { masterKey: env.SECRETS_MASTER_KEY, network });
  const { rows: [{ id: session }] } = await inWorkspace(pool, A, (db) => db.query("insert into agent_sessions (workspace_id, agent_name, title, created_by, status) values ($1, 'helper', 'Test', 'owner', 'running') returning id", [A]));
  await chat.interrupt(A, session);
  const { status, role } = await inWorkspace(pool, A, async (db) => ({
    status: (await db.query("select status from agent_sessions where id = $1", [session])).rows[0].status,
    role: (await db.query("select role from agent_messages where session_id = $1", [session])).rows[0].role,
  }));
  assert.equal(status, "idle");
  assert.equal(role, "error");
});

test("queue numbers name no workspace, and wait time is recorded", async () => {
  process.env.WORKSPACE_WORK_LIMIT = "1";
  const flow = await slowFlow(A, 1);
  await startRuns(A, flow, 6);
  const worker = await startOneWorker(1, 2);
  await waitUntil("the runs to finish", async () => (await statuses(A)).succeeded === 6);
  await waitUntil("the queue to empty", async () => (await count("work_waiting")) === 0);
  assert.ok(queueWait.count({ queue: STEP_QUEUE }) >= 6);
  assert.ok(jobDuration.count({ queue: STEP_QUEUE }) >= 6);
  await admin.query("insert into work_waiting (job_key, workspace_id, queue, data) values ('x', $1, $2, '{}')", [A, STEP_QUEUE]);
  const text = renderMetrics(await databaseMetrics(pool, worker.boss));
  assert.match(text, /agent_platform_queue_depth\{queue="workflow-step",state="waiting"\} 1/);
  assert.match(text, /agent_platform_queue_workspaces_waiting\{queue="workflow-step"\} 1/);
  assert.match(text, /agent_platform_queue_deferrals_total\{queue="workflow-step"\} \d+/);
  assert.match(text, /agent_platform_queue_wait_seconds_bucket\{queue="workflow-step",le="\+Inf"\} \d+/);
  assert.doesNotMatch(text, new RegExp(`${A}|${B}|step:`));
});

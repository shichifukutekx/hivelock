// The real server and worker programs, in their own processes, told to stop the way an orchestrator does.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPool } from "../src/platform/db.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";

const DB = "agent_platform_test_shutdown";
const WEB_PORT = 43217;
const WORKER_PORT = 43218;
const web = `http://127.0.0.1:${WEB_PORT}`;
const worker = `http://127.0.0.1:${WORKER_PORT}`;
const children: ChildProcess[] = [];

let env: PlatformEnv;
let admin: pg.Pool;

const start = (program: string, extra: Record<string, string> = {}) => {
  const child = spawn(process.execPath, ["--import", "tsx", program], { env: { ...process.env, PLATFORM_PORT: String(WEB_PORT), SHUTDOWN_GRACE_SECONDS: "3", ...extra }, stdio: "ignore" });
  children.push(child);
  return child;
};
const answers = async (url: string) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).status;
  } catch {
    return 0;
  }
};
const waitFor = async (what: string, check: () => Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => {
  if (child.exitCode !== null) resolve(child.exitCode);
  else child.once("exit", (code) => resolve(code));
});

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_shutdown_app:test-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 71).toString("base64"),
    PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test", AUDIT_LOG: "off", WORKSPACE_DATA_DIR: mkdtempSync(join(tmpdir(), "shutdown-")),
  });
  env = loadEnv();
  await migrate(env);
  admin = createPool(env.DATABASE_ADMIN_URL!, 2);
});

after(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await admin.end();
});

test("the worker reports itself, then on SIGTERM stops being ready, leaves and exits cleanly", async () => {
  const child = start("src/platform/worker.ts", { WORKER_HTTP_PORT: String(WORKER_PORT) });
  await waitFor("the worker to be ready", async () => (await answers(`${worker}/ready`)) === 200);
  await waitFor("the worker to report in", async () => (await admin.query("select 1 from worker_presence")).rowCount === 1);
  child.kill("SIGTERM");
  assert.equal(await exited(child), 0);
  assert.equal((await admin.query("select 1 from worker_presence")).rowCount, 0, "it says it has gone, so no one waits for it");
});

test("the server fails /ready first, keeps answering through the drain, then exits cleanly", async () => {
  const child = start("src/platform/server.ts", { SHUTDOWN_DRAIN_SECONDS: "2" });
  await waitFor("the server to be ready", async () => (await answers(`${web}/ready`)) === 200);
  assert.equal(await answers(`${web}/status`), 200);
  child.kill("SIGTERM");
  await waitFor("/ready to fail", async () => (await answers(`${web}/ready`)) === 503, 2_000);
  assert.equal(await answers(`${web}/health`), 200, "still answering, so the proxy has time to move away");
  assert.equal(await exited(child), 0);
  assert.equal(await answers(`${web}/health`), 0);
});

test("a stream left open does not hold a stopping server past its grace period", async () => {
  const child = start("src/platform/server.ts");
  await waitFor("the server to be ready", async () => (await answers(`${web}/ready`)) === 200);
  // An idle connection, as a browser's held-open keep-alive would be.
  const { connect } = await import("node:net");
  const socket = connect(WEB_PORT, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write("GET /health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
  await new Promise((resolve) => socket.once("data", resolve));
  socket.on("error", () => {});
  const stopping = Date.now();
  child.kill("SIGTERM");
  assert.equal(await exited(child), 0);
  socket.destroy();
  assert.ok(Date.now() - stopping < 6_000, "it must not wait for a client that will never leave");
});

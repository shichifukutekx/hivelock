// Runs the real drill script against real backups, including ones that must fail it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { recordAudit } from "../src/platform/audit-log.ts";
import { createPool, inWorkspace } from "../src/platform/db.ts";
import { loadEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";

const run = promisify(execFile);
const SOURCE = "agent_platform_test_drill";
const PASSPHRASE = "a-test-only-drill-passphrase";
const WORKSPACE = "workspace-a";

const admin = () => new pg.Client({ connectionString: `postgres:///${SOURCE}` });
const withAdmin = async (work: (client: pg.Client) => Promise<unknown>) => {
  const client = admin();
  await client.connect();
  await client.query("set session_replication_role = replica");
  try {
    await work(client);
  } finally {
    await client.end();
  }
};

const folder = () => mkdtempSync(join(tmpdir(), "agent-drill-"));
const backup = (directory: string) => run("bash", ["scripts/backup.sh"], { env: { ...process.env, DATABASE_ADMIN_URL: `postgres:///${SOURCE}`, BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: directory, BACKUP_STATUS_DIR: join(directory, "status") } });
const drill = (directory: string, extra: Record<string, string> = {}) => run("bash", ["scripts/restore-drill.sh"], { env: { ...process.env, BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: directory, ...extra } });
const report = (directory: string) => JSON.parse(readFileSync(join(directory, "status", "restore-drill.json"), "utf8"));
const metrics = (directory: string) => readFileSync(join(directory, "status", "restore-drill.prom"), "utf8");
const databases = async () => {
  const client = new pg.Client({ connectionString: "postgres:///postgres" });
  await client.connect();
  const { rows } = await client.query("select datname from pg_database order by 1");
  await client.end();
  return rows.map(({ datname }) => datname as string);
};

before(async () => {
  const client = new pg.Client({ connectionString: "postgres:///postgres" });
  await client.connect();
  await client.query(`drop database if exists ${SOURCE} with (force)`);
  await client.query(`create database ${SOURCE}`);
  await client.end();
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_drill_app:test-only@localhost/${SOURCE}`, DATABASE_ADMIN_URL: `postgres:///${SOURCE}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 31).toString("base64"),
    PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test",
  });
  await migrate(loadEnv());
  const setup = admin();
  await setup.connect();
  await setup.query(`insert into organization (id, name, slug, "createdAt") values ($1, 'Alpha', 'alpha', now())`, [WORKSPACE]);
  await setup.end();
  const pool = createPool(process.env.DATABASE_URL!, 2);
  await inWorkspace(pool, WORKSPACE, async (db) => {
    for (const action of ["secret.saved", "secret.deleted", "run.started"]) await recordAudit(db, { workspaceId: WORKSPACE, action });
  });
  await pool.end();
});

after(async () => {
  const client = new pg.Client({ connectionString: "postgres:///postgres" });
  await client.connect();
  await client.query(`drop database if exists ${SOURCE} with (force)`);
  await client.end();
});

test("a good backup passes, and the result is recorded for people and for monitoring", async () => {
  const directory = folder();
  await backup(directory);
  const servers = await databases();
  const { stdout } = await drill(directory);
  assert.match(stdout, /ok: user: 0 rows, 0 recorded/, "a table with a quoted name is compared too");
  assert.match(stdout, /ok: audit chain intact/);
  assert.match(stdout, /ok: migrations current/);
  const result = report(directory);
  assert.equal(result.result, "passed");
  assert.equal(result.rows.audit_events, 3);
  assert.equal(result.rows.organization, 1);
  assert.ok(result.backupAgeSeconds >= 0);
  assert.ok(result.totalSeconds >= result.restoreSeconds);
  assert.match(metrics(directory), /agent_platform_restore_drill_last_result 1/);
  assert.match(metrics(directory), /agent_platform_restore_drill_last_success_timestamp_seconds [1-9]\d+/);
  assert.deepEqual(await databases(), servers, "nothing is left on, or added to, the real server");
});

test("a broken audit chain fails the drill, and keeps the time of the last success", async () => {
  const directory = folder();
  await backup(directory);
  await drill(directory);
  const passedAt = /last_success_timestamp_seconds (\d+)/.exec(metrics(directory))![1];
  await withAdmin((client) => client.query("alter table audit_events disable trigger all").then(() => client.query("update audit_events set action = 'forged' where seq = 2 and workspace_id = $1", [WORKSPACE])));
  try {
    await backup(directory);
    await assert.rejects(drill(directory));
    assert.equal(report(directory).result, "failed");
    assert.match(report(directory).problems, /audit chain broken in: workspace-a/);
    assert.match(metrics(directory), /agent_platform_restore_drill_last_result 0/);
    assert.equal(/last_success_timestamp_seconds (\d+)/.exec(metrics(directory))![1], passedAt);
  } finally {
    await withAdmin((client) => client.query("update audit_events set action = 'secret.deleted' where seq = 2 and workspace_id = $1", [WORKSPACE]));
  }
});

test("a backup missing a migration fails, unless that is expected", async () => {
  const directory = folder();
  await backup(directory);
  const migrations = folder();
  writeFileSync(join(migrations, "999_from_the_future.sql"), "select 1;\n");
  const extra = { MIGRATION_DIRS: `src/platform/migrations ${migrations}` };
  await assert.rejects(drill(directory, extra));
  assert.match(report(directory).problems, /999_from_the_future\.sql/);
  await drill(directory, { ...extra, DRILL_ALLOW_PENDING: "1" });
  assert.equal(report(directory).result, "passed");
  assert.match(report(directory).notes, /999_from_the_future\.sql/);
});

test("a file marked as replacing a recorded migration counts as applied", async () => {
  const directory = folder();
  await backup(directory);
  const migrations = folder();
  writeFileSync(join(migrations, "998_split_part.sql"), "-- replaces: 001_foundation.sql\nselect 1;\n");
  await drill(directory, { MIGRATION_DIRS: `src/platform/migrations ${migrations}` });
  assert.equal(report(directory).result, "passed");
});

test("fewer audit entries than the backup recorded fails the drill", async () => {
  const directory = folder();
  await backup(directory);
  const counts = readdirSync(directory).find((name) => name.endsWith(".counts"))!;
  const path = join(directory, counts);
  writeFileSync(path, readFileSync(path, "utf8").replace(/^audit_events \d+$/m, "audit_events 9999"));
  await assert.rejects(drill(directory));
  assert.match(report(directory).problems, /audit_events has 3 rows, and the backup recorded 9999/);
});

test("a corrupt backup, a wrong passphrase and no backup at all each fail", async () => {
  const directory = folder();
  await backup(directory);
  await assert.rejects(drill(directory, { BACKUP_PASSPHRASE: "not-the-passphrase" }));
  assert.equal(report(directory).result, "failed");
  const file = readdirSync(directory).find((name) => name.endsWith(".dump.enc"))!;
  writeFileSync(join(directory, file), Buffer.from("Salted__not really a backup"));
  await assert.rejects(drill(directory));
  assert.equal(report(directory).result, "failed");
  const empty = folder();
  await assert.rejects(drill(empty));
  assert.match(report(empty).problems, /no backup found/);
});

test("the throwaway server leaves nothing behind", async () => {
  const directory = folder();
  await backup(directory);
  const scratch = mkdtempSync("/tmp/agent-drill-scratch-");
  try {
    await drill(directory, { DRILL_TMP: scratch });
    assert.deepEqual(readdirSync(scratch), []);
    assert.ok(existsSync(directory));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import pg from "pg";
import { recordAudit } from "../src/platform/audit-log.ts";
import { createPool, inWorkspace } from "../src/platform/db.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";
import { putSecret, readSecret } from "../src/platform/secrets.ts";

const run = promisify(execFile);
const SOURCE = "agent_platform_test_backup";
const TARGET = "agent_platform_test_restored";
const PASSPHRASE = "a-test-only-backup-passphrase";
const WORKSPACE = "workspace-a";
const directory = mkdtempSync(join(tmpdir(), "agent-backups-"));
let env: PlatformEnv;

const shell = (script: string, args: string[], extra: Record<string, string>) =>
  run("bash", [script, ...args], { env: { ...process.env, ...extra } });
const backup = (extra: Record<string, string> = {}) =>
  shell("scripts/backup.sh", [], { DATABASE_ADMIN_URL: `postgres:///${SOURCE}`, BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_DIR: directory, ...extra });

async function recreate(name: string) {
  const client = new pg.Client({ connectionString: "postgres:///postgres" });
  await client.connect();
  await client.query(`drop database if exists ${name} with (force)`);
  await client.query(`create database ${name}`);
  await client.end();
}

before(async () => {
  await recreate(SOURCE);
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `postgres://agent_platform_backup_app:test-only@localhost/${SOURCE}`,
    DATABASE_ADMIN_URL: `postgres:///${SOURCE}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass",
    SECRETS_MASTER_KEY: Buffer.alloc(32, 8).toString("base64"),
    PUBLIC_URL: "http://localhost:4320",
    BOOTSTRAP_ADMIN_EMAIL: "founder@example.test",
  });
  env = loadEnv();
  await migrate(env);
  const admin = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL! });
  await admin.connect();
  await admin.query(`insert into organization (id, name, slug, "createdAt") values ($1, 'Alpha', 'alpha', now())`, [WORKSPACE]);
  await admin.end();
  const pool = createPool(env.DATABASE_URL, 2);
  await inWorkspace(pool, WORKSPACE, async (db) => {
    await putSecret(db, env.SECRETS_MASTER_KEY, WORKSPACE, "API_TOKEN", "backup-canary-value", "founder");
    await recordAudit(db, { workspaceId: WORKSPACE, action: "secret.saved" });
    await recordAudit(db, { workspaceId: WORKSPACE, action: "secret.deleted" });
  });
  await pool.end();
});

after(async () => {
  for (const name of [SOURCE, TARGET]) {
    const client = new pg.Client({ connectionString: "postgres:///postgres" });
    await client.connect();
    await client.query(`drop database if exists ${name} with (force)`);
    await client.end();
  }
});

test("a backup is encrypted and contains nothing readable", async () => {
  const { stdout } = await backup();
  const bytes = readFileSync(stdout.trim());
  assert.equal(bytes.subarray(0, 8).toString("latin1"), "Salted__");
  assert.ok(!bytes.includes("backup-canary-value"));
  assert.ok(!bytes.includes("PGDMP"));
  assert.ok(!bytes.includes("founder"));
  assert.equal(readdirSync(directory).filter((f) => f.endsWith(".partial")).length, 0);
});

test("a backup refuses to run without a passphrase", async () => {
  await assert.rejects(backup({ BACKUP_PASSPHRASE: "" }));
});

test("a restored database works, including secrets, and its audit chain still verifies", async () => {
  const { stdout } = await backup();
  await recreate(TARGET);
  await shell("scripts/restore.sh", [stdout.trim(), `postgres:///${TARGET}`], { BACKUP_PASSPHRASE: PASSPHRASE });

  const url = new URL(env.DATABASE_URL);
  url.pathname = `/${TARGET}`;
  const restored = createPool(url.toString(), 2);
  try {
    const value = await inWorkspace(restored, WORKSPACE, (db) => readSecret(db, env.SECRETS_MASTER_KEY, WORKSPACE, "API_TOKEN"));
    assert.equal(value, "backup-canary-value");
    const { rows: [check] } = await restored.query("select audit_chain_break($1) as broken", [WORKSPACE]);
    assert.equal(check.broken, null);

    assert.equal((await restored.query("select * from secrets")).rowCount, 0, "row security must survive a restore");
    await assert.rejects(restored.query("delete from audit_events"), /permission denied/);
    await inWorkspace(restored, WORKSPACE, (db) => recordAudit(db, { workspaceId: WORKSPACE, action: "after.restore" }));
    const { rows: [after] } = await restored.query("select audit_chain_break($1) as broken", [WORKSPACE]);
    assert.equal(after.broken, null);
  } finally {
    await restored.end();
  }
});

test("a restore refuses a database that already holds data", async () => {
  const { stdout } = await backup();
  await assert.rejects(shell("scripts/restore.sh", [stdout.trim(), `postgres:///${SOURCE}`], { BACKUP_PASSPHRASE: PASSPHRASE }), /not empty/);
});

test("a wrong passphrase or a damaged file does not restore", async () => {
  const { stdout } = await backup();
  await recreate(TARGET);
  await assert.rejects(shell("scripts/restore.sh", [stdout.trim(), `postgres:///${TARGET}`], { BACKUP_PASSPHRASE: "wrong" }));

  const bytes = readFileSync(stdout.trim());
  // One flipped byte can land in text that still restores, so this damages a whole stretch.
  bytes.fill(0, Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 4_096);
  const damaged = join(directory, "damaged.enc");
  writeFileSync(damaged, bytes);
  await recreate(TARGET);
  await assert.rejects(shell("scripts/restore.sh", [damaged, `postgres:///${TARGET}`], { BACKUP_PASSPHRASE: PASSPHRASE }));
});

test("only the newest backups are kept", async () => {
  await backup({ BACKUP_KEEP: "2" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await backup({ BACKUP_KEEP: "2" });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await backup({ BACKUP_KEEP: "2" });
  const kept = readdirSync(directory).filter((f) => f.startsWith("agent-platform-"));
  assert.equal(kept.filter((f) => f.endsWith(".dump.enc")).length, 2);
  assert.equal(kept.filter((f) => f.endsWith(".counts")).length, 2, "a backup's counts go with it");
});

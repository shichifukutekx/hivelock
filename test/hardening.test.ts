import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import mysql from "mysql2";
import { hostedMode } from "../src/config.ts";
import { adminUrl, loadEnv } from "../src/platform/env.ts";
import { getConnector } from "../src/platform/connectors/index.ts";
import { PermanentError } from "../src/platform/connectors/types.ts";
import { migrate } from "../src/platform/migrate.ts";

const run = promisify(execFile);

const appSettings = {
  NODE_ENV: "test", DATABASE_URL: "postgres://app:x@localhost/app", BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass",
  SECRETS_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"), PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test",
};

test("the app starts without the superuser's address, and only the commands that need it ask for it", async () => {
  Object.assign(process.env, appSettings);
  delete process.env.DATABASE_ADMIN_URL;
  const env = loadEnv();
  assert.equal(env.DATABASE_ADMIN_URL, undefined);
  assert.throws(() => adminUrl(env), /DATABASE_ADMIN_URL is required/);
  await assert.rejects(migrate(env), /DATABASE_ADMIN_URL is required/);
  assert.equal(adminUrl({ ...env, DATABASE_ADMIN_URL: "postgres:///x" }), "postgres:///x");
});

test("HOSTED_MODE must be true, false or empty, everywhere it is read", async () => {
  Object.assign(process.env, appSettings);
  const saved = process.env.HOSTED_MODE;
  try {
    for (const value of ["True", "TRUE", "1", "yes", "enabled", " true", "false "]) {
      process.env.HOSTED_MODE = value;
      assert.throws(() => loadEnv(), (error: Error) => /HOSTED_MODE/.test(error.message) && !error.message.includes(value), JSON.stringify(value));
      assert.throws(() => hostedMode(), /HOSTED_MODE must be true, false or empty/, JSON.stringify(value));
    }
    for (const value of ["false", ""]) {
      process.env.HOSTED_MODE = value;
      assert.equal(loadEnv().HOSTED_MODE, false);
      assert.equal(hostedMode(), false);
    }
    delete process.env.HOSTED_MODE;
    assert.equal(loadEnv().HOSTED_MODE, false);
    assert.equal(hostedMode(), false);
  } finally {
    if (saved === undefined) delete process.env.HOSTED_MODE; else process.env.HOSTED_MODE = saved;
  }
});

test("a program that only reads the agent settings stops at a bad HOSTED_MODE too", async () => {
  const load = (value: string) => run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/config.ts"); console.log("started")'], { env: { ...process.env, HOSTED_MODE: value } });
  assert.match((await load("false")).stdout, /started/);
  await assert.rejects(load("True"), (error: { code?: number; stdout?: string; stderr?: string }) => {
    assert.notEqual(error.code, 0);
    assert.doesNotMatch(error.stdout!, /started/);
    assert.match(error.stderr!, /HOSTED_MODE must be true, false or empty/);
    return true;
  });
});

test("compose gives the superuser's details to the migrate step and to nothing that serves traffic", () => {
  const compose = readFileSync("compose.yaml", "utf8");
  const service = (name: string) => compose.slice(compose.indexOf(`\n  ${name}:`) + 1).split(/\n  \S/)[0]!;
  assert.match(compose.slice(0, compose.indexOf("services:")), /env_file: \.env\.production\n/);
  assert.match(service("migrate"), /env_file: \[\.env\.production, \.env\.migrate\]/);
  for (const name of ["web", "worker"]) assert.doesNotMatch(service(name), /env\.migrate|DATABASE_ADMIN_URL|POSTGRES_PASSWORD|env_file/, name);
  const example = readFileSync(".env.production.example", "utf8");
  assert.doesNotMatch(example, /^(DATABASE_ADMIN_URL|POSTGRES_PASSWORD)=/m);
  assert.match(readFileSync(".env.migrate.example", "utf8"), /^DATABASE_ADMIN_URL=/m);
  assert.match(readFileSync(".gitignore", "utf8"), /^\.env\.migrate$/m);
});

test("the backup scripts keep the database password out of the process list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pg-url-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "log");
  const fake = (name: string, output: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} args: $*" "${name} password: $PGPASSWORD" >> "${log}"\n${output}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("pg_dump", "echo dump");
  fake("psql", "echo 0");
  fake("pg_restore", "cat > /dev/null");
  const url = "postgres://backup_admin:p%40ss%2Fw%25rd@db.internal:5433/app?sslmode=require";
  const settings = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BACKUP_PASSPHRASE: "test-only", BACKUP_DIR: join(directory, "backups") };

  const { stdout } = await run("bash", ["scripts/backup.sh"], { env: { ...settings, DATABASE_ADMIN_URL: url } });
  await run("bash", ["scripts/restore.sh", stdout.trim()], { env: { ...settings, RESTORE_DATABASE_URL: url } });
  const seen = readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.equal(seen.length, 8);
  for (const line of seen.filter((entry) => entry.includes(" args: "))) {
    assert.ok(!line.includes("p%40ss"), line);
    assert.ok(!line.includes("p@ss"), line);
    assert.ok(line.includes("--dbname=postgres://backup_admin@db.internal:5433/app?sslmode=require"), line);
  }
  for (const line of seen.filter((entry) => entry.includes(" password: "))) assert.match(line, /password: p@ss\/w%rd$/);
});

function mysqlStub(rows: (index: number) => Record<string, string>, total: number) {
  const server = mysql.createServer((connection: any) => {
    connection.serverHandshake({
      protocolVersion: 10, serverVersion: "8.0.0", connectionId: 1, statusFlags: 2, characterSet: 8, capabilityFlags: 0xffffff,
      authCallback: (_: unknown, done: (error: null) => void) => done(null),
    });
    connection.on("error", () => {});
    connection.on("query", () => connection.writeOk());
    connection.on("stmt_prepare", () => {
      const packet = Buffer.alloc(16);
      packet[4] = 0;
      packet.writeUInt32LE(1, 5);
      connection.writePacket({ buffer: packet, length: () => packet.length, writeHeader: (sequenceId: number) => { packet.writeUIntLE(packet.length - 4, 0, 3); packet[3] = sequenceId; } });
    });
    connection.on("stmt_execute", () => {
      const column = { catalog: "def", schema: "s", table: "t", orgTable: "t", name: "v", orgName: "v", characterSet: 33, columnLength: 16_777_215, columnType: 253, flags: 0, decimals: 0 };
      connection.writeColumns([column]);
      let index = 0;
      const send = () => {
        while (index < total && !connection.stream.destroyed) {
          connection.writeBinaryRow([rows(index).v]);
          index += 1;
          if (index % 500 === 0) return setImmediate(send);
        }
        if (!connection.stream.destroyed) connection.writeEof();
      };
      send();
    });
  }) as unknown as { _server: Server; listen: Server["listen"] };
  return new Promise<{ port: number; close: () => void }>((ready) => {
    server.listen(0, "127.0.0.1", () => ready({ port: (server._server.address() as { port: number }).port, close: () => server._server.close() }));
  });
}

const query = (port: number) => getConnector("database")!.actions.query!.run(
  { engine: "mysql", host: "127.0.0.1", port, database: "d", user: "u", password: "", ssl: false },
  { sql: "select v", values: [] },
  { network: { allowedPrivateHosts: ["127.0.0.1"] }, idempotencyKey: "k" },
) as Promise<any>;

test("a MySQL server is read row by row, up to the row limit", async () => {
  const stub = await mysqlStub((index) => ({ v: `row ${index}` }), 500_000);
  try {
    const found = await query(stub.port);
    assert.equal(found.rows.length, 1_000);
    assert.equal(found.truncated, true);
    assert.equal(found.rows[0].v, "row 0");
  } finally {
    stub.close();
  }
});

test("a MySQL server that sends a small result is answered in full", async () => {
  const stub = await mysqlStub((index) => ({ v: `row ${index}` }), 10);
  try {
    const found = await query(stub.port);
    assert.equal(found.rows.length, 10);
    assert.equal(found.truncated, false);
  } finally {
    stub.close();
  }
});

test("a MySQL server cannot send more than the size limit, in however few rows", async () => {
  const large = "x".repeat(4 * 1024 * 1024);
  const stub = await mysqlStub(() => ({ v: large }), 100);
  try {
    await assert.rejects(query(stub.port), (error: Error) => error instanceof PermanentError && /larger than/.test(error.message));
  } finally {
    stub.close();
  }
});

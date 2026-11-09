// What this code does with no package added: the Community edition, its limits, and how a locked feature explains itself.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createApp } from "../src/platform/app.ts";
import { listConnectors } from "../src/platform/connectors/index.ts";
import { createPool } from "../src/platform/db.ts";
import { editionOf, upgradeHint } from "../src/platform/edition.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { agentGate, hostedPolicy, loadExtensions, withoutExtensionsForTests } from "../src/platform/extensions.ts";
import { assertFeature, assertWorkflowRoom, connectorLabel, hasFeature, lockedConnectorMessage, connectorLocked, EditionLimit } from "../src/platform/limits.ts";
import { migrate, migrationsInOrder } from "../src/platform/migrate.ts";
import { COMMUNITY, SALES_EMAIL } from "../src/platform/plans.ts";

const DB = "agent_platform_test_core_alone";
const WORKSPACE = "workspace-a";
const founder = { id: "founder", name: "Founder", email: "founder@example.test", twoFactorEnabled: true };

let env: PlatformEnv;
let pool: pg.Pool;
let admin: pg.Pool;

const alone = <T>(work: () => Promise<T> | T) => withoutExtensionsForTests(work);
const fakeAuth = { api: { getSession: async () => ({ user: founder, session: { id: "s" } }) } } as never;
const call = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) => app.request(path, {
  method, headers: { "content-type": "application/json", origin: "http://localhost:4320" }, body: body === undefined ? undefined : JSON.stringify(body),
});

before(async () => {
  await loadExtensions();
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_core_app:test-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 51).toString("base64"),
    PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test", AUDIT_LOG: "off", WORKSPACE_DATA_DIR: mkdtempSync(join(tmpdir(), "core-alone-")),
  });
  delete process.env.HIVELOCK_LICENSE_KEY;
  env = loadEnv();
  await alone(() => migrate(env));
  pool = createPool(env.DATABASE_URL, 4);
  admin = createPool(env.DATABASE_ADMIN_URL!, 2);
  await admin.query(`insert into organization (id, name, slug, "createdAt") values ($1, $1, $1, now())`, [WORKSPACE]);
  await admin.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('founder', 'Founder', 'founder@example.test', true, now(), now())`);
  await admin.query(`insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, 'founder', 'owner', now())`, [randomUUID(), WORKSPACE]);
});

after(async () => {
  await pool.end();
  await admin.end();
});

test("hosted mode refuses to start with no package to enforce its rules", async () => {
  await alone(() => {
    assert.throws(() => hostedPolicy(), /Hosted mode needs the paid package/);
    process.env.HOSTED_MODE = "true";
    try {
      assert.throws(() => loadEnv(), /Hosted mode needs the paid package/);
    } finally {
      delete process.env.HOSTED_MODE;
    }
    assert.throws(() => createApp({ pool, auth: fakeAuth, env: { ...env, HOSTED_MODE: true } }), /Hosted mode needs the paid package/);
  });
});

test("only the six free connectors are here, and the rest are named so a refusal can say what is missing", async () => {
  await alone(async () => {
    const free = listConnectors().map(({ name }) => name).filter((name) => (COMMUNITY.connectors as readonly string[]).includes(name)).sort();
    assert.deepEqual(free, [...COMMUNITY.connectors!].sort());
    const edition = await editionOf(pool);
    assert.equal(connectorLocked(edition, "hubspot"), true);
    assert.equal(connectorLabel("hubspot"), "HubSpot");
    assert.match(lockedConnectorMessage(edition, "hubspot"), new RegExp(`HubSpot connections cannot run.*${SALES_EMAIL}`));
  });
});

test("the edition is Community, with the published limits", async () => {
  await alone(async () => {
    const { id, limits } = await editionOf(pool);
    assert.equal(id, "community");
    assert.deepEqual([limits.workspaces, limits.people, limits.agents, limits.workflows, limits.storageBytes], [1, 5, 5, 10, 1024 ** 3]);
    for (const feature of ["sso", "whatsapp", "emailTriggers", "versionHistory", "evals"] as const) assert.equal(await hasFeature(pool, WORKSPACE, feature), false);
    assert.match(upgradeHint(), new RegExp(SALES_EMAIL));
    await assert.rejects(assertFeature(pool, WORKSPACE, "sso"), (error: Error) => error instanceof EditionLimit && error.message.includes(SALES_EMAIL));
  });
});

test("a limit stops only the next one, and says how to upgrade", async () => {
  await alone(async () => {
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.workspace_id', $1, true)", [WORKSPACE]);
      for (let i = 0; i < COMMUNITY.workflows!; i += 1) await client.query("insert into workflows (workspace_id, name, definition, created_by) values ($1, $2, '{}', 'founder')", [WORKSPACE, `flow-${i}`]);
      await assert.rejects(assertWorkflowRoom(client, WORKSPACE), (error: Error) => error instanceof EditionLimit && /10 workflows/.test(error.message) && error.message.includes(SALES_EMAIL));
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

test("each paid route answers with the way to upgrade, not a bare not found", async () => {
  await alone(async () => {
    const app = createApp({ pool, auth: fakeAuth, env });
    const base = `/api/v1/workspaces/${WORKSPACE}`;
    const flow = randomUUID();
    for (const [method, path] of [["GET", "/sso"], ["GET", "/channels"], ["GET", "/agents/helper/evals"], ["POST", "/agents/helper/evals/run"], ["POST", "/agents/helper/release/override"], ["GET", `/workflows/${flow}/versions/compare`], ["POST", `/workflows/${flow}/versions/1/restore`]] as const) {
      const response = await call(app, method, `${base}${path}`);
      assert.equal(response.status, 402, path);
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, "edition_limit", path);
      assert.match(body.error, new RegExp(SALES_EMAIL), path);
    }
  });
});

test("the edition route shows Community with no licence routes behind it", async () => {
  await alone(async () => {
    const app = createApp({ pool, auth: fakeAuth, env });
    const edition = await (await call(app, "GET", `/api/v1/workspaces/${WORKSPACE}/edition`)).json() as { id: string; lockedFeatures: unknown[]; contact: string };
    assert.equal(edition.id, "community");
    assert.equal(edition.lockedFeatures.length, 6);
    assert.equal(edition.contact, SALES_EMAIL);
    assert.equal((await call(app, "GET", "/api/v1/platform/license")).status, 404);
  });
});

test("a template or trigger that needs something paid says so, and free ones are not held back", async () => {
  await alone(async () => {
    const app = createApp({ pool, auth: fakeAuth, env, workflows: { engine: {} as never, boss: {} as never } });
    const base = `/api/v1/workspaces/${WORKSPACE}`;
    const { templates } = await (await call(app, "GET", `${base}/templates`)).json() as { templates: { id: string; needsUpgrade: string[]; connectors: { name: string }[] }[] };
    const paid = templates.find(({ connectors }) => connectors.some(({ name }) => name === "hubspot"))!;
    assert.ok(paid.needsUpgrade.includes("HubSpot"));
    const free = templates.filter(({ connectors }) => connectors.every(({ name }) => (COMMUNITY.connectors as readonly string[]).includes(name)));
    assert.ok(free.length > 0);
    for (const template of free) assert.deepEqual(template.needsUpgrade, []);
    const install = await call(app, "POST", `${base}/templates/${paid.id}/install`, {});
    assert.equal(install.status, 402);
    assert.match((await install.json() as { error: string }).error, /HubSpot/);

    const { connectors, notInstalled } = await (await call(app, "GET", "/api/v1/connectors")).json() as { connectors: { name: string; locked: boolean }[]; notInstalled: string[] };
    // Each paid connector is either absent or locked. Which one depends on whether its code happens to be loaded in this process.
    assert.ok(connectors.filter(({ name }) => (COMMUNITY.connectors as readonly string[]).includes(name)).every(({ locked }) => !locked));
    assert.equal(connectors.filter(({ locked }) => locked).length + notInstalled.length, 20);
    const paidConnection = await call(app, "POST", `${base}/connections`, { connector: "hubspot", name: "CRM", credentials: {} });
    assert.equal(paidConnection.status, 402);
    assert.match((await paidConnection.json() as { error: string }).error, /HubSpot.*sales@/);
    const trigger = await call(app, "POST", `${base}/workflows/${randomUUID()}/triggers`, { kind: "email", connectionId: randomUUID() });
    assert.equal(trigger.status, 402);
    assert.match((await trigger.json() as { error: string }).error, new RegExp(SALES_EMAIL));
  });
});

test("no paid table is created by the core's migrations", () => {
  const sources = readdirSync("src/platform/migrations");
  assert.ok(sources.every((name) => !/billing|license/.test(name)));
  assert.ok(sources.every((name) => !/create table (channels|eval_cases|email_triggers|workspace_sso|workspace_billing|platform_license)\b/.test(readFileSync(`src/platform/migrations/${name}`, "utf8"))));
});

test("the core's migrations are enough on their own, and the app role cannot read a closed table", async () => {
  const names = (await admin.query("select name from schema_migrations order by name")).rows.map((row) => row.name);
  await alone(() => assert.deepEqual(names, migrationsInOrder().map(({ name }) => name)));
  await assert.rejects(pool.query("select * from platform_mail_settings"), /permission denied/);
});

test("with no package there is no release gate: a changed agent goes straight to workflows", async () => {
  await alone(() => assert.equal(agentGate(), undefined));
  assert.equal((await admin.query("select to_regclass('agent_releases') as gate")).rows[0].gate, null, "the core makes no gate table");
});

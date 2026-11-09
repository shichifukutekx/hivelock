import "./licensed.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { createAgentChat } from "../src/platform/agent-chat.ts";
import { createApp } from "../src/platform/app.ts";
import { createPool } from "../src/platform/db.ts";
import { createEngine } from "../src/platform/engine/engine.ts";
import { createBoss, startWorker } from "../src/platform/engine/queue.ts";
import { loadEnv, type PlatformEnv } from "../src/platform/env.ts";
import { migrate } from "../src/platform/migrate.ts";
import { LIMITS } from "../src/platform/rate-limit.ts";
import { sendCompletion } from "./llm-stub.ts";

LIMITS.user.limit = 1_000_000;
LIMITS.runStart.limit = 1_000_000;

const DB = "agent_platform_test_models";
const A = "workspace-a";
const B = "workspace-b";
const KEY = "provider-key-canary-77";
const callers = Object.fromEntries(["owner", "admin", "builder", "viewer"].map((name) => [name, { id: name, twoFactorEnabled: true }]));

let env: PlatformEnv;
let pool: pg.Pool;
let admin: pg.Pool;
let boss: PgBoss;
let app: ReturnType<typeof createApp>;

interface Stub { server: Server; url: string; requests: { url: string; model?: string; auth?: string; body: any }[]; broken: boolean }
const stubs: Record<string, Stub> = {};
let envRequests: any[] = [];

function stub(name: string) {
  const state: Stub = { server: undefined as never, url: "", requests: [], broken: false };
  state.server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/v1/models") {
        state.requests.push({ url: req.url!, auth: req.headers.authorization, body: null });
        return res.end(JSON.stringify({ data: [{ id: `${name}-large` }, { id: `models/${name}-large` }, { id: `${name}-small` }, { id: 7 }] }));
      }
      const request = JSON.parse(body);
      state.requests.push({ url: req.url!, model: request.model, auth: req.headers.authorization, body: request });
      if (state.broken) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: { message: "down" } }));
      }
      const wantsTool = request.tools?.some((t: any) => t.function.name === "read_document") && String(JSON.stringify(request.messages)).includes("policy.txt");
      const tool_calls = wantsTool ? [{ id: "call_1", type: "function", function: { name: "read_document", arguments: '{"name":"policy.txt"}' } }] : undefined;
      sendCompletion(res, request, {
        id: `chat-${randomUUID()}`, object: "chat.completion", created: 0, model: request.model,
        choices: [{ index: 0, finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: tool_calls ? "" : `answer from ${name}`, tool_calls } }],
        usage: { prompt_tokens: 1_000, completion_tokens: 500, total_tokens: 1_500 },
      });
    });
  });
  stubs[name] = state;
  return new Promise<void>((ready) => state.server.listen(0, "127.0.0.1", () => {
    state.url = `http://127.0.0.1:${(state.server.address() as { port: number }).port}/v1`;
    ready();
  }));
}

const space = (workspace = A) => `/api/v1/workspaces/${workspace}`;
function call(person: string, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method, headers: { "x-test-user": person, "content-type": "application/json", origin: "http://localhost:4320" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const json = async (person: string, method: string, path: string, body?: unknown) => {
  const response = await call(person, method, path, body);
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return await response.json() as any;
};
const providers = (workspace = A) => `${space(workspace)}/model-providers`;
const provider = (name: string, extra: Record<string, unknown> = {}) => ({
  name: `${name}-${randomUUID().slice(0, 6)}`, baseUrl: stubs[name]!.url, apiKey: KEY, models: { main: `${name}-large`, fast: `${name}-small` }, ...extra,
});
const clear = (workspace = A) => admin.query("delete from model_providers where workspace_id = $1", [workspace]);

async function chat(workspace = A) {
  const { id } = await json("owner", "POST", `${space(workspace)}/sessions`, { agent: "document-assistant", title: "Test" });
  await json("owner", "POST", `${space(workspace)}/sessions/${id}/messages`, { text: "Hello" });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = await json("owner", "GET", `${space(workspace)}/sessions/${id}`);
    if (found.session.status === "idle" && found.messages.length >= 2) return found.messages.at(-1);
    assert.ok(Date.now() < deadline, "chat stuck");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

before(async () => {
  const bootstrap = new pg.Client({ connectionString: "postgres:///postgres" });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${DB} with (force)`);
  await bootstrap.query(`create database ${DB}`);
  await bootstrap.end();
  await stub("first");
  await stub("second");
  await stub("fromenv");

  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: `postgres://agent_platform_models_app:test-only@localhost/${DB}`, DATABASE_ADMIN_URL: `postgres:///${DB}`,
    BETTER_AUTH_SECRET: "a-test-only-secret-that-is-long-enough-to-pass", SECRETS_MASTER_KEY: Buffer.alloc(32, 6).toString("base64"),
    PUBLIC_URL: "http://localhost:4320", BOOTSTRAP_ADMIN_EMAIL: "founder@example.test", AUDIT_LOG: "off",
    ALLOWED_MODEL_HOSTS: "127.0.0.1",
    LLM_BASE_URL: stubs.fromenv!.url, LLM_API_KEY: "env-key", LLM_MODEL_MAIN: "fromenv-model", LLM_MODEL_FAST: "fromenv-fast", LLM_MODEL_CODING: "fromenv-coding", LLM_MODEL_FALLBACK: "", LLM_EXTRA_BODY: "{}",
    KIMI_API_KEY: "", DOCUMENTS_DIR: "data/documents", WORKSPACE_DATA_DIR: mkdtempSync(join(tmpdir(), "model-providers-")),
  });
  env = loadEnv();
  await migrate(env);
  pool = createPool(env.DATABASE_URL, 15);
  admin = createPool(env.DATABASE_ADMIN_URL!, 3);
  for (const [id, name] of [[A, "Alpha"], [B, "Bravo"]]) {
    await admin.query(`insert into organization (id, name, slug, "createdAt") values ($1, $2, $3, now())`, [id, name, name!.toLowerCase()]);
    await admin.query("insert into workspace_settings (workspace_id, confidential_mode) values ($1, false)", [id]);
  }
  for (const name of Object.keys(callers)) {
    await admin.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $1 || '@example.test', true, now(), now())`, [name]);
    await admin.query(`insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, $3, now())`, [randomUUID(), A, name]);
  }
  await admin.query(`insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, 'owner', 'owner', now())`, [randomUUID(), B]);

  boss = createBoss(env.DATABASE_URL, "worker");
  await boss.start();
  const options = { masterKey: env.SECRETS_MASTER_KEY, network: { allowedPrivateHosts: [] } };
  const engine = createEngine(pool, boss, options);
  const agentChat = createAgentChat(pool, boss, options);
  await startWorker(boss, pool, engine, 5, agentChat);
  const auth = { api: { getSession: async ({ headers }: { headers: Headers }) => ({ user: callers[headers.get("x-test-user") ?? ""] }) } };
  app = createApp({ pool, auth: auth as never, env, workflows: { engine, boss, chat: agentChat } });
});

after(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
  await admin.end();
  for (const { server } of Object.values(stubs)) { server.closeAllConnections(); server.close(); }
});

beforeEach(async () => {
  for (const state of Object.values(stubs)) {
    state.requests = [];
    state.broken = false;
  }
  await clear(A);
  await clear(B);
  await admin.query("update workspace_settings set confidential_mode = false");
});

test("a workspace with no providers uses the server settings", async () => {
  const { usingServerDefaults, presets } = await json("owner", "GET", providers());
  assert.equal(usingServerDefaults, true);
  assert.ok(presets.some((p: any) => p.id === "ollama" && p.local));
  const gemini = presets.find((p: any) => p.id === "gemini");
  assert.equal(gemini.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.ok(gemini.models.main && gemini.models.fast, "an example brings suggested models");
  assert.equal((await chat()).content, "answer from fromenv");
});

test("once a provider is added it is used, and the server settings are ignored", async () => {
  await json("owner", "POST", providers(), provider("first"));
  assert.equal((await chat()).content, "answer from first");
  assert.equal(stubs.fromenv!.requests.length, 0);
  assert.equal(stubs.first!.requests[0]!.model, "first-large");
  assert.equal(stubs.first!.requests[0]!.auth, `Bearer ${KEY}`);
});

test("the next provider takes over when the first fails, and order can change", async () => {
  const one = await json("owner", "POST", providers(), provider("first"));
  const two = await json("owner", "POST", providers(), provider("second"));
  stubs.first!.broken = true;
  assert.equal((await chat()).content, "answer from second");
  stubs.first!.broken = false;
  await json("owner", "POST", `${providers()}/order`, { ids: [two.id, one.id] });
  stubs.first!.requests = [];
  assert.equal((await chat()).content, "answer from second");
  assert.equal(stubs.first!.requests.length, 0);
});

test("turning off every provider stops work rather than falling back to the server", async () => {
  await json("owner", "POST", providers(), provider("first", { enabled: false }));
  const reply = await chat();
  assert.equal(reply.role, "error");
  assert.match(reply.content, /No AI provider is turned on/);
  assert.equal(stubs.fromenv!.requests.length, 0);
});

test("confidential mode uses only providers cleared for it", async () => {
  await json("owner", "POST", providers(), provider("first"));
  await json("owner", "POST", providers(), provider("second", { confidentialAllowed: true }));
  await json("owner", "PUT", `${space()}/settings`, { confidentialMode: true });
  assert.equal((await chat()).content, "answer from second");
  assert.equal(stubs.first!.requests.length, 0);
});

test("confidential mode refuses when no provider is cleared", async () => {
  await json("owner", "POST", providers(), provider("first"));
  await json("owner", "PUT", `${space()}/settings`, { confidentialMode: true });
  const reply = await chat();
  assert.equal(reply.role, "error");
  assert.match(reply.content, /no AI provider is cleared/);
  assert.equal(stubs.first!.requests.length, 0);
});

test("confidential fallback never reaches an uncleared provider", async () => {
  await json("owner", "POST", providers(), provider("second", { confidentialAllowed: true }));
  await json("owner", "POST", providers(), provider("first"));
  await json("owner", "PUT", `${space()}/settings`, { confidentialMode: true });
  stubs.second!.broken = true;
  assert.equal((await chat()).role, "error");
  assert.equal(stubs.first!.requests.length, 0);
});

test("keys are encrypted and no route ever returns them", async () => {
  const { id } = await json("owner", "POST", providers(), provider("first"));
  const list = await (await call("owner", "GET", providers())).text();
  assert.doesNotMatch(list, new RegExp(KEY));
  assert.match(list, /"hasKey":true/);
  const { rows: [row] } = await admin.query("select t::text as raw, encode(key_ciphertext, 'escape') as key from model_providers t where id = $1", [id]);
  assert.ok(!row.raw.includes(KEY) && !row.key.includes(KEY));
  const log = await (await call("owner", "GET", `${space()}/audit`)).text();
  assert.doesNotMatch(log, new RegExp(KEY));
});

test("a saved key cannot be sent to a new address", async () => {
  const body = provider("first");
  const { id } = await json("owner", "POST", providers(), body);
  const moved = await call("owner", "PUT", `${providers()}/${id}`, { ...body, apiKey: undefined, baseUrl: stubs.second!.url });
  assert.equal(moved.status, 400);
  assert.match(await moved.text(), /Enter the API key again/);

  const before = stubs.second!.requests.length;
  await json("owner", "POST", `${providers()}/discover`, { baseUrl: stubs.second!.url, providerId: id });
  assert.equal(stubs.second!.requests.length, before + 1);
  assert.equal(stubs.second!.requests.at(-1)!.auth, undefined, "the saved key must not travel");

  await json("owner", "PUT", `${providers()}/${id}`, { ...body, apiKey: undefined, name: "Renamed" });
  await chat();
  assert.equal(stubs.first!.requests.at(-1)!.auth, `Bearer ${KEY}`, "editing other fields keeps the key");
});

test("a key stored for one provider cannot be moved to another row", async () => {
  const one = await json("owner", "POST", providers(), provider("first"));
  const two = await json("owner", "POST", providers(), provider("second", { apiKey: undefined }));
  await admin.query(
    `update model_providers set key_ciphertext = o.key_ciphertext, key_iv = o.key_iv, key_tag = o.key_tag
     from model_providers o where model_providers.id = $1 and o.id = $2`, [two.id, one.id],
  );
  await admin.query("delete from model_providers where id = $1", [one.id]);
  const reply = await chat();
  assert.equal(reply.role, "error");
  assert.equal(stubs.second!.requests.length, 0);
});

test("a self-hosted server can use any model address, and cloud metadata stays refused", async () => {
  const saved = process.env.ALLOWED_MODEL_HOSTS;
  process.env.ALLOWED_MODEL_HOSTS = "";
  try {
    assert.equal((await call("owner", "POST", `${providers()}/discover`, { baseUrl: stubs.first!.url })).status, 200, "local servers need no server setting");
    for (const baseUrl of ["https://169.254.169.254/latest", "http://[::ffff:169.254.169.254]/latest", "http://100.100.100.200/v1"]) {
      assert.equal((await call("owner", "POST", `${providers()}/discover`, { baseUrl })).status, 400, baseUrl);
    }
  } finally {
    process.env.ALLOWED_MODEL_HOSTS = saved;
  }
});

test("hosted mode keeps private addresses closed", async () => {
  const [savedHosts, savedMode] = [process.env.ALLOWED_MODEL_HOSTS, process.env.HOSTED_MODE];
  process.env.ALLOWED_MODEL_HOSTS = "";
  process.env.HOSTED_MODE = "true";
  try {
    for (const baseUrl of ["http://127.0.0.1:5432/v1", "https://[::1]/v1", stubs.first!.url, "http://example.com/v1"]) {
      assert.equal((await call("owner", "POST", `${providers()}/discover`, { baseUrl })).status, 400, baseUrl);
    }
    const before = stubs.first!.requests.length;
    const { id } = await json("owner", "POST", providers(), provider("first"));
    const { results } = await json("owner", "POST", `${providers()}/${id}/test`);
    assert.ok(results.every((result: any) => result.status !== "tools work"));
    assert.equal(stubs.first!.requests.length, before, "nothing may reach a blocked address, including the key");
  } finally {
    process.env.ALLOWED_MODEL_HOSTS = savedHosts;
    if (savedMode === undefined) delete process.env.HOSTED_MODE; else process.env.HOSTED_MODE = savedMode;
  }
});

test("only the address is needed: name, key and model are all optional", async () => {
  const made = await json("owner", "POST", providers(), { baseUrl: stubs.first!.url, models: {} });
  const { providers: list } = await json("owner", "GET", providers());
  const saved = list.find((item: any) => item.id === made.id);
  assert.equal(saved.name, "127.0.0.1");
  assert.equal(saved.models.main, "first-large");
  assert.equal(saved.hasKey, false);
});

test("a model server cannot redirect the key elsewhere", async () => {
  const evil = createServer((req, res) => res.writeHead(307, { location: `${stubs.second!.url}/chat/completions` }).end());
  await new Promise<void>((ready) => evil.listen(0, "127.0.0.1", () => ready()));
  const url = `http://127.0.0.1:${(evil.address() as { port: number }).port}/v1`;
  await json("owner", "POST", providers(), { ...provider("first"), baseUrl: url });
  await chat();
  evil.close();
  assert.equal(stubs.second!.requests.length, 0);
});

test("models are discovered and tested, without leaking the key", async () => {
  const found = await json("owner", "POST", `${providers()}/discover`, { baseUrl: stubs.first!.url, apiKey: "typed-key" });
  assert.deepEqual(found.models, ["first-large", "first-small"]);
  assert.equal(stubs.first!.requests.at(-1)!.auth, "Bearer typed-key");

  const { id } = await json("owner", "POST", providers(), provider("first"));
  const { results } = await json("owner", "POST", `${providers()}/${id}/test`);
  assert.deepEqual(results.map((r: any) => [r.role, r.model, r.status]), [["main", "first-large", "tools work"], ["fast", "first-small", "tools work"]]);

  stubs.first!.broken = true;
  const failed = await (await call("owner", "POST", `${providers()}/${id}/test`)).text();
  assert.match(failed, /"status":"error"/);
  assert.doesNotMatch(failed, new RegExp(KEY));
});

test("a local server without a key works", async () => {
  await json("owner", "POST", providers(), { name: "Ollama", preset: "ollama", baseUrl: stubs.first!.url, models: { main: "qwen" } });
  assert.equal((await chat()).content, "answer from first");
});

test("each role uses its own model, and missing roles fall back to main", async () => {
  await json("owner", "POST", providers(), provider("first", { models: { main: "only-main" } }));
  await json("owner", "POST", `${space()}/agents`, { name: "quick-one", description: "x", model: "fast", instructions: "x" });
  const { id } = await json("owner", "POST", `${space()}/sessions`, { agent: "quick-one", title: "t" });
  await json("owner", "POST", `${space()}/sessions/${id}/messages`, { text: "hi" });
  const deadline = Date.now() + 10_000;
  while (!stubs.first!.requests.length) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(stubs.first!.requests[0]!.model, "only-main");
});

test("provider prices drive cost figures", async () => {
  await json("owner", "POST", providers(), provider("first", { inputPrice: 2, outputPrice: 10 }));
  await chat();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { rows } = await admin.query("select cost_usd from spans where workspace_id = $1 and name = 'first-large' order by id desc limit 1", [A]);
  assert.equal(Number(rows[0].cost_usd), (1_000 * 2 + 500 * 10) / 1_000_000);
});

test("only admins can manage providers, and workspaces cannot see each other's", async () => {
  const body = provider("first");
  assert.equal((await call("builder", "POST", providers(), body)).status, 403);
  assert.equal((await call("viewer", "GET", providers())).status, 403);
  assert.equal((await call("admin", "POST", providers(), body)).status, 201);
  const { providers: list } = await json("builder", "GET", providers());
  assert.equal(list.length, 1);
  assert.equal((await call("builder", "POST", `${providers()}/${list[0].id}/test`)).status, 403);
  assert.equal((await json("owner", "GET", providers(B))).providers.length, 0);
  assert.equal((await call("owner", "DELETE", `${providers(B)}/${list[0].id}`)).status, 404);
  assert.equal((await call("owner", "POST", `${providers(B)}/${list[0].id}/test`)).status, 404);
  assert.equal((await pool.query("select count(*)::int as n from model_providers")).rows[0].n, 0, "row security");
  assert.equal((await chat(B)).content, "answer from fromenv");
});

test("invalid providers are refused, and errors never echo a key", async () => {
  for (const bad of [{ baseUrl: "not a url" }, { baseUrl: "ftp://example.com" }]) {
    const response = await call("owner", "POST", providers(), { ...provider("first"), apiKey: "secret-echo-check", ...bad });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /secret-echo-check/);
  }
  const body = provider("first");
  await json("owner", "POST", providers(), body);
  assert.equal((await call("owner", "POST", providers(), body)).status, 400);
});

test("server settings import once, encrypted, and only for an owner", async () => {
  assert.equal((await call("admin", "POST", `${providers()}/import-env`)).status, 403);
  await json("owner", "POST", `${providers()}/import-env`);
  const { providers: list, usingServerDefaults } = await json("owner", "GET", providers());
  assert.equal(usingServerDefaults, false);
  assert.equal(list[0].models.main, "fromenv-model");
  assert.equal(list[0].models.fast, "fromenv-fast");
  assert.equal(list[0].hasKey, true);
  assert.equal(list[0].confidentialAllowed, false, "an import must not clear a provider for confidential work");
  assert.equal((await call("owner", "POST", `${providers()}/import-env`)).status, 400);
  assert.equal((await chat()).content, "answer from fromenv");
  assert.equal(stubs.fromenv!.requests.at(-1)!.auth, "Bearer env-key");
});

test("provider changes reach the audit log", async () => {
  const { id } = await json("owner", "POST", providers(), provider("first"));
  await json("owner", "DELETE", `${providers()}/${id}`);
  const { rows } = await admin.query("select distinct action from audit_events where action like 'model_provider.%'");
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes("model_provider.created") && actions.includes("model_provider.deleted"));
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createUiServer } from "../src/ui/server.ts";

const work = mkdtempSync(join(tmpdir(), "agent-ui-"));
let replies: any[] = [];
let modelRequests: any[] = [];
let provider: Server;
let ui: Server;
let base: string;
let port: number;

function completion(reply: any, n: number) {
  const tool_calls = reply.tool
    ? [{ id: `call_${n}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }]
    : undefined;
  return {
    id: `chat-${n}`, object: "chat.completion", created: 0, model: "fake-main",
    choices: [{ index: 0, finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: reply.text ?? "", tool_calls } }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

before(async () => {
  let n = 0;
  provider = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      modelRequests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completion(replies.shift() ?? { text: "done" }, ++n)));
    });
  });
  await new Promise<void>((ready) => provider.listen(0, "127.0.0.1", ready));
  const providerPort = (provider.address() as { port: number }).port;
  Object.assign(process.env, {
    LLM_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, LLM_API_KEY: "test-key",
    LLM_MODEL_MAIN: "fake-main", LLM_MODEL_FALLBACK: "", KIMI_API_KEY: "", LLM_EXTRA_BODY: "{}",
    DOCUMENTS_DIR: "data/documents", AGENTS_DIR: join(work, "agents"), RFQS_DIR: join(work, "rfqs"), OUTPUT_DIR: join(work, "output"), AUDIT_LOG: join(work, "audit.jsonl"),
  });

  const probe = createUiServer(0);
  await new Promise<void>((ready) => probe.listen(0, "127.0.0.1", ready));
  port = (probe.address() as { port: number }).port;
  await new Promise((done) => probe.close(done));
  ui = createUiServer(port);
  await new Promise<void>((ready) => ui.listen(port, "127.0.0.1", ready));
  base = `http://127.0.0.1:${port}`;
});

after(() => { ui.close(); provider.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Reads a run's events, calling `onEvent` as each one arrives. */
async function followRun(id: string, onEvent: (event: any) => Promise<void> = async () => {}) {
  const response = await fetch(`${base}/api/runs/${id}/events`);
  const events: any[] = [];
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += Buffer.from(chunk).toString();
    for (const line of buffer.split("\n\n").slice(0, -1)) {
      const event = JSON.parse(line.replace(/^data: /, ""));
      events.push(event);
      await onEvent(event);
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
  }
  return events;
}

test("serves the page with a strict content policy", async () => {
  const response = await fetch(base + "/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'self'");
  assert.match(await response.text(), /Hivelock/);
  assert.equal((await fetch(base + "/app.js")).status, 200);
  assert.equal((await fetch(base + "/../.env")).status, 404);
});

test("lists agents without their instructions", async () => {
  const list = await (await fetch(base + "/api/agents")).json();
  assert.ok(list.some((a: any) => a.name === "document-assistant"));
  assert.equal(list[0].instructions, undefined);
});

test("runs a request and streams its steps", async () => {
  replies = [{ tool: "list_documents" }, { text: "Here is the answer" }];
  const { id } = await (await post("/api/runs", { agent: "document-assistant", prompt: "Hi" })).json();
  const types = (await followRun(id)).map((e) => e.type);
  assert.deepEqual(types, ["started", "model", "tool_started", "tool_finished", "model", "finished"]);
});

test("a write waits for approval from the page", async () => {
  replies = [{ tool: "save_report", args: { fileName: "ui.txt", content: "from ui" } }, { text: "saved" }];
  const { id } = await (await post("/api/runs", { agent: "document-assistant", prompt: "Save" })).json();
  await followRun(id, async (event) => {
    if (event.type === "approval_needed") {
      assert.equal(existsSync(join(work, "output", "ui.txt")), false);
      assert.equal((await post(`/api/runs/${id}/approval`, { approved: true })).status, 200);
    }
  });
  assert.equal(readFileSync(join(work, "output", "ui.txt"), "utf8"), "from ui");
});

test("a declined write does not run, and a repeat answer is refused", async () => {
  replies = [{ tool: "save_report", args: { fileName: "declined.txt", content: "x" } }, { text: "not saved" }];
  const { id } = await (await post("/api/runs", { agent: "document-assistant", prompt: "Save" })).json();
  await followRun(id, async (event) => {
    if (event.type === "approval_needed") {
      await post(`/api/runs/${id}/approval`, { approved: false });
      assert.equal((await post(`/api/runs/${id}/approval`, { approved: true })).status, 409);
    }
  });
  assert.equal(existsSync(join(work, "output", "declined.txt")), false);
});

test("anything but true counts as declined", async () => {
  replies = [{ tool: "save_report", args: { fileName: "odd.txt", content: "x" } }, { text: "not saved" }];
  const { id } = await (await post("/api/runs", { agent: "document-assistant", prompt: "Save" })).json();
  await followRun(id, async (event) => {
    if (event.type === "approval_needed") await post(`/api/runs/${id}/approval`, { approved: "yes" });
  });
  assert.equal(existsSync(join(work, "output", "odd.txt")), false);
});

test("the page receives parsed lines and their problems, now and in history", async () => {
  const args = {
    rfqDate: "2026-10-01",
    items: [{ line: "A", valveType: "GATE VALVE", quantity: null, attributes: { size: "4", class: "300", endConnection: "RF", body: "WCB", trimNo: "8" } }],
    contradictions: [],
    suspiciousContent: [],
  };
  replies = [{ tool: "check_items", args }, { text: "checked" }];
  const { id } = await (await post("/api/runs", { agent: "rfq-checker", prompt: "Parsed check" })).json();
  const events = await followRun(id);
  assert.deepEqual(events.find((e) => e.type === "tool_started").args, args);
  const live = JSON.parse(events.find((e) => e.type === "tool_finished").output);
  assert.equal(live.status, "needs_clarification");
  assert.equal(live.findings[0].code, "MISSING:quantity");

  const runs = await (await fetch(base + "/api/history")).json();
  const step = runs[0].steps.find((s: any) => s.tool === "check_items");
  assert.equal(runs[0].prompt, "Parsed check");
  assert.deepEqual(step.args, args);
  assert.equal(step.result.findings[0].code, "MISSING:quantity");
});

test("history shows finished runs, newest first", async () => {
  const runs = await (await fetch(base + "/api/history")).json();
  assert.ok(runs.every((r: any) => r.status === "finished"));
  assert.equal(runs.at(-1).prompt, "Hi");
  assert.equal(runs.at(-1).answer, "Here is the answer");
});

test("refuses other websites and bad requests", async () => {
  const good = { agent: "document-assistant", prompt: "Hi" };
  assert.equal((await post("/api/runs", good, { origin: "https://evil.example" })).status, 403);
  const form = await fetch(base + "/api/runs", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(good) });
  assert.equal(form.status, 415);
  assert.equal((await post("/api/runs", { agent: "__proto__", prompt: "Hi" })).status, 400);
  assert.equal((await post("/api/runs", { agent: "document-assistant", prompt: " " })).status, 400);
  assert.equal((await post("/api/runs/unknown/approval", { approved: true })).status, 409);
});

test("stores an upload under a safe new name", async () => {
  const data = Buffer.from("%PDF-1.7 test").toString("base64");
  const response = await post("/api/uploads", { name: "../../evil name.pdf", dataBase64: data });
  assert.equal(response.status, 201);
  const { name } = await response.json();
  assert.match(name, /^upload-[\w-]{8}-evil_name\.pdf$/);
  assert.deepEqual(readdirSync(join(work, "rfqs")), [name]);
});

test("refuses unsafe or disguised uploads", async () => {
  const send = (name: string, text: string) => post("/api/uploads", { name, dataBase64: Buffer.from(text).toString("base64") });
  assert.equal((await send("macro.xlsm", "PK\x03\x04")).status, 400);
  assert.equal((await send("run.exe", "MZ")).status, 400);
  assert.equal((await send("fake.pdf", "<html>")).status, 400);
  assert.equal((await send("fake.xlsx", "<html>")).status, 400);
  assert.equal((await send("empty.pdf", "")).status, 400);
  assert.equal((await post("/api/uploads", { name: "big.pdf", dataBase64: "A".repeat(21 * 1024 * 1024) })).status, 400);
  assert.equal(readdirSync(join(work, "rfqs")).length, 1);
});

test("refuses requests with another Host header", async () => {
  const { request } = await import("node:http");
  const status = await new Promise<number>((done) => {
    request({ port, host: "127.0.0.1", path: "/api/agents", headers: { host: "evil.example" } }, (res) => {
      res.resume();
      done(res.statusCode!);
    }).end();
  });
  assert.equal(status, 403);
});

const textOf = (request: any) => request.messages.map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

test("a follow-up message continues the same conversation", async () => {
  replies = [{ text: "Quantity is missing." }, { text: "Now complete." }];
  const first = await (await post("/api/runs", { agent: "rfq-checker", prompt: "Check valve tag 540-XV-478" })).json();
  await followRun(first.id);

  modelRequests = [];
  const second = await post("/api/runs", { agent: "rfq-checker", prompt: "need 2 qty", conversationId: first.conversationId });
  assert.equal(second.status, 201);
  const { id, conversationId } = await second.json();
  assert.equal(conversationId, first.conversationId);
  await followRun(id);

  const seen = textOf(modelRequests[0]);
  assert.match(seen, /540-XV-478/);
  assert.match(seen, /Quantity is missing/);
  assert.match(seen, /need 2 qty/);
});

test("separate requests do not share a conversation", async () => {
  replies = [{ text: "first" }];
  const first = await (await post("/api/runs", { agent: "rfq-checker", prompt: "secret-one" })).json();
  await followRun(first.id);

  replies = [{ text: "second" }];
  modelRequests = [];
  const second = await (await post("/api/runs", { agent: "rfq-checker", prompt: "other request" })).json();
  await followRun(second.id);
  assert.notEqual(second.conversationId, first.conversationId);
  assert.doesNotMatch(textOf(modelRequests[0]), /secret-one/);
});

test("an unknown conversation or a different agent is refused", async () => {
  const unknown = await post("/api/runs", { agent: "rfq-checker", prompt: "hi", conversationId: "missing" });
  assert.equal(unknown.status, 409);
  assert.equal((await unknown.json()).conversationLost, true);

  replies = [{ text: "ok" }];
  const first = await (await post("/api/runs", { agent: "rfq-checker", prompt: "hi" })).json();
  await followRun(first.id);
  const other = await post("/api/runs", { agent: "document-assistant", prompt: "hi", conversationId: first.conversationId });
  assert.equal(other.status, 409);
});

test("a conversation cannot start a second run while one is active", async () => {
  replies = [{ tool: "save_report", args: { fileName: "busy.md", content: "x" } }, { text: "done" }];
  const first = await (await post("/api/runs", { agent: "rfq-checker", prompt: "save a report" })).json();
  await followRun(first.id, async (event) => {
    if (event.type !== "approval_needed") return;
    const second = await post("/api/runs", { agent: "rfq-checker", prompt: "again", conversationId: first.conversationId });
    assert.equal(second.status, 409);
    await post(`/api/runs/${first.id}/approval`, { approved: false });
  });
});

test("the history groups a conversation's runs", async () => {
  replies = [{ text: "one" }, { text: "two" }];
  const first = await (await post("/api/runs", { agent: "rfq-checker", prompt: "first turn" })).json();
  await followRun(first.id);
  const second = await (await post("/api/runs", { agent: "rfq-checker", prompt: "second turn", conversationId: first.conversationId })).json();
  await followRun(second.id);
  const history = await (await fetch(`${base}/api/history`)).json();
  const turns = history.filter((run: any) => run.conversationId === first.conversationId);
  assert.deepEqual(turns.map((run: any) => run.prompt), ["second turn", "first turn"]);
});

test("a helper agent's work streams with the run, and only the top agent ends it", async () => {
  replies = [
    { tool: "delegate", args: { agent: "document-assistant", task: "Look it up" } },
    { tool: "list_documents" },
    { text: "Helper answer" },
    { text: "Final answer" },
  ];
  const { id } = await (await post("/api/runs", { agent: "orchestrator", prompt: "Find it" })).json();
  const events = await followRun(id);
  const parent = events[0];
  const child = events.find((e) => e.parentRunId === parent.runId);
  assert.equal(child.agent, "document-assistant");
  assert.equal(child.type, "started");
  assert.ok(events.some((e) => e.type === "finished" && e.parentRunId === parent.runId));
  const last = events.at(-1);
  assert.equal(last.type, "finished");
  assert.equal(last.answer, "Final answer");

  const history = await (await fetch(`${base}/api/history`)).json();
  assert.equal(history.filter((run: any) => run.runId === child.runId).length, 0);
  const run = history.find((r: any) => r.runId === parent.runId);
  assert.ok(run.steps.some((s: any) => s.tool === "list_documents" && s.agent === "document-assistant"));
  assert.ok(run.events.some((e: any) => e.type === "started" && e.parentRunId === parent.runId));
});

test("the agent list says who manages and who takes files", async () => {
  const list = await (await fetch(base + "/api/agents")).json();
  const orchestrator = list.find((a: any) => a.name === "orchestrator");
  assert.equal(orchestrator.managesAgents, true);
  assert.equal(orchestrator.acceptsFiles, true);
  assert.equal(list.find((a: any) => a.name === "document-assistant").acceptsFiles, false);
  assert.equal((await fetch(base + "/flow.js")).status, 200);
});

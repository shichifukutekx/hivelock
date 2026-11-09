import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemorySaver } from "@langchain/langgraph";
import { getAgent, listAgents } from "../agents/registry.ts";
import { hostedMode, paths } from "../config.ts";
import { RFQ_EXTENSIONS } from "../rfq/extract.ts";
import { checkRfq } from "../rfq/rules.ts";
import { runAgent } from "../runtime.ts";
import type { RunEvent } from "../tools.ts";
import type { AgentDefinition } from "../agents/types.ts";

interface LiveRun {
  events: RunEvent[];
  listeners: Set<ServerResponse>;
  resolveApproval?: (approved: boolean) => void;
}

interface ChatState {
  agent: string;
  busy: boolean;
}

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/flow.js": ["flow.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};
const MAX_BODY = 64 * 1024;
const MAX_LIVE_RUNS = 100;
const MAX_CONVERSATIONS = 50;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_BODY = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 1024;

/** Only the top-level agent ending ends the run. Helper agents finish along the way. */
const isRunEnd = (e: RunEvent) => (e.type === "finished" || e.type === "failed") && !e.parentRunId;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  let body = "";
  let tooLarge = false;
  // An oversized body is read to its end and discarded, so the client gets the error and the connection stays usable.
  for await (const chunk of req) {
    if (tooLarge) continue;
    body += chunk;
    tooLarge = body.length > limit;
  }
  if (tooLarge) throw new Error("This file is too large. The limit is 15 MB.");
  return JSON.parse(body);
}

/** Checks that a file really is the type its name claims, then stores it under a new name. */
function saveUpload(name: unknown, dataBase64: unknown): string {
  if (typeof name !== "string" || typeof dataBase64 !== "string") throw new Error("Choose a file to upload.");
  const extension = extname(name).toLowerCase();
  if (!RFQ_EXTENSIONS.includes(extension)) {
    throw new Error(`Only ${RFQ_EXTENSIONS.join(", ")} files are supported.`);
  }
  const data = Buffer.from(dataBase64, "base64");
  if (data.length === 0) throw new Error("This file is empty.");
  if (data.length > MAX_UPLOAD_BYTES) throw new Error("This file is too large. The limit is 15 MB.");
  const signature = data.subarray(0, 4).toString("latin1");
  if ((extension === ".pdf" && signature !== "%PDF") || (extension === ".xlsx" && signature !== "PK\x03\x04")) {
    throw new Error(`This file is not a real ${extension} file.`);
  }
  const safeName = basename(name, extname(name)).replace(/[^\w.-]/g, "_").slice(0, 80);
  const saved = `upload-${randomUUID().slice(0, 8)}-${safeName}${extension}`;
  mkdirSync(paths.rfqs(), { recursive: true });
  writeFileSync(join(paths.rfqs(), saved), data, { flag: "wx" });
  return saved;
}

/** Summarizes the audit log into recent runs, newest first. Work done by a helper agent belongs to the run that asked for it. */
function readHistory() {
  const file = paths.auditLog();
  if (!existsSync(file)) return [];
  const runs = new Map<string, Record<string, any>>();
  const owner = new Map<string, Record<string, any>>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    const base = { runId: e.runId, at: e.at };
    if (e.event === "run_started") {
      const parent = e.parentRunId ? owner.get(e.parentRunId) : undefined;
      if (parent) owner.set(e.runId, parent);
      else {
        const run = { runId: e.runId, conversationId: e.conversationId, at: e.at, agent: e.agent, prompt: e.prompt, status: "unfinished", steps: [], models: [], events: [] };
        runs.set(e.runId, run);
        owner.set(e.runId, run);
      }
      owner.get(e.runId)!.agents ??= {};
      owner.get(e.runId)!.agents[e.runId] = e.agent;
      owner.get(e.runId)!.events.push({ ...base, type: "started", agent: e.agent, parentRunId: e.parentRunId, prompt: e.prompt });
      continue;
    }
    const run = owner.get(e.runId);
    if (!run) continue;
    const isRoot = run.runId === e.runId;
    const agent = run.agents[e.runId];
    if (e.event === "tool_call") {
      const result = e.tool === "check_items" && !e.isError ? checkRfq(e.args.items, e.args.rfqDate) : undefined;
      // A hand-off is logged after the helper's own run, so that run stands for it unless the hand-off itself failed.
      if (e.tool !== "delegate" || e.isError) {
        run.steps.push({ tool: e.tool, args: e.args, isError: e.isError, result, agent: isRoot ? undefined : agent });
        run.events.push({ ...base, type: "tool_started", tool: e.tool, args: e.args });
        run.events.push({ ...base, type: "tool_finished", tool: e.tool, isError: e.isError, output: "" });
      }
    }
    if (e.event === "approval") {
      run.steps.push({ tool: e.tool, approved: e.approved });
      run.events.push({ ...base, type: "approval_needed", tool: e.tool });
      run.events.push({ ...base, type: "approval_decided", tool: e.tool, approved: e.approved });
    }
    if (e.event === "model_call") {
      if (e.model && !run.models.includes(e.model)) run.models.push(e.model);
      run.events.push({ ...base, type: "model", model: e.model, tokens: e.usage?.total_tokens });
    }
    if (e.event === "run_finished") {
      if (isRoot) Object.assign(run, { status: "finished", answer: e.answer });
      run.events.push({ ...base, type: "finished", answer: e.answer });
    }
    if (e.event === "run_failed") {
      if (isRoot) Object.assign(run, { status: "failed", answer: e.error });
      run.events.push({ ...base, type: "failed", message: e.error });
    }
  }
  return [...runs.values()].reverse().slice(0, 50).map(({ agents: _agents, ...run }) => run);
}

export function createUiServer(port: number): Server {
  const live = new Map<string, LiveRun>();
  // Conversations stay in memory only, so a restart forgets them and their document text.
  const memory = new MemorySaver();
  const conversations = new Map<string, ChatState>();

  const forget = (id: string) => {
    conversations.delete(id);
    void memory.deleteThread(id);
  };

  const openConversation = (agent: string): string => {
    const id = randomUUID();
    conversations.set(id, { agent, busy: false });
    if (conversations.size > MAX_CONVERSATIONS) {
      const oldest = [...conversations].find(([, chat]) => !chat.busy);
      if (oldest) forget(oldest[0]);
    }
    return id;
  };

  const startRun = (agent: AgentDefinition, prompt: string, conversationId: string): string => {
    const chat = conversations.get(conversationId)!;
    chat.busy = true;
    const id = randomUUID();
    const run: LiveRun = { events: [], listeners: new Set() };
    live.set(id, run);
    if (live.size > MAX_LIVE_RUNS) live.delete(live.keys().next().value!);

    const emit = (event: RunEvent) => {
      run.events.push(event);
      for (const res of run.listeners) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const approve = () => new Promise<boolean>((resolve) => { run.resolveApproval = resolve; });

    runAgent(agent, prompt, approve, emit, { conversation: { id: conversationId, memory } })
      .catch((error) => {
        // A failed run can leave half-finished tool calls, so its conversation cannot continue.
        forget(conversationId);
        if (!run.events.some(isRunEnd)) emit({ type: "failed", message: String(error), runId: "", agent: agent.name, at: new Date().toISOString() });
      })
      .finally(() => {
        chat.busy = false;
        for (const res of run.listeners) res.end();
        run.listeners.clear();
      });
    return id;
  };

  return createServer(async (req, res) => {
    try {
      // The server can run agents, so only pages it serves itself may talk to it.
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      const origin = req.headers.origin;
      if (!allowed.includes(req.headers.host ?? "") || (origin && !allowed.includes(origin.replace(/^http:\/\//, "")))) {
        return sendJson(res, 403, { error: "Forbidden" });
      }

      const { pathname } = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && staticFiles[pathname]) {
        const [file, type] = staticFiles[pathname];
        res.writeHead(200, { "content-type": type, "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff" });
        return res.end(readFileSync(join(publicDir, file)));
      }

      if (req.method === "GET" && pathname === "/api/agents") {
        return sendJson(res, 200, listAgents().map(({ name, description, server, model, tools, requiresApproval, createdByAgent }) => ({
          name, description, model, tools, requiresApproval, createdByAgent: !!createdByAgent,
          managesAgents: tools.includes("delegate"),
          acceptsFiles: server === "rfq" || tools.includes("delegate"),
        })));
      }

      if (req.method === "GET" && pathname === "/api/history") return sendJson(res, 200, readHistory());

      const eventsMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const run = live.get(eventsMatch[1]!);
        if (!run) return sendJson(res, 404, { error: "Run not found" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (run.events.some(isRunEnd)) return res.end();
        run.listeners.add(res);
        req.on("close", () => run.listeners.delete(res));
        return;
      }

      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          return sendJson(res, 415, { error: "JSON required" });
        }
        if (pathname === "/api/uploads") {
          const upload = await readJson(req, MAX_UPLOAD_BODY);
          return sendJson(res, 201, { name: saveUpload(upload.name, upload.dataBase64) });
        }

        const body = await readJson(req);

        if (pathname === "/api/runs") {
          const { agent: agentName, prompt, conversationId } = body;
          const agent = typeof agentName === "string" ? getAgent(agentName) : undefined;
          if (!agent || typeof prompt !== "string" || !prompt.trim()) {
            return sendJson(res, 400, { error: "Choose an agent and enter a request." });
          }
          if (conversationId !== undefined) {
            const chat = typeof conversationId === "string" ? conversations.get(conversationId) : undefined;
            if (chat?.agent !== agent.name) {
              return sendJson(res, 409, { error: "This conversation is no longer available. Start a new request and attach the RFQ again.", conversationLost: true });
            }
            if (chat.busy) return sendJson(res, 409, { error: "This conversation is still running." });
          }
          const conversation = (conversationId as string | undefined) ?? openConversation(agent.name);
          return sendJson(res, 201, { id: startRun(agent, prompt.trim(), conversation), conversationId: conversation });
        }

        const approvalMatch = pathname.match(/^\/api\/runs\/([\w-]+)\/approval$/);
        if (approvalMatch) {
          const run = live.get(approvalMatch[1]!);
          if (!run?.resolveApproval) return sendJson(res, 409, { error: "Nothing is waiting for approval." });
          const resolve = run.resolveApproval;
          run.resolveApproval = undefined;
          resolve(body.approved === true);
          return sendJson(res, 200, { ok: true });
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: String(error) });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // This older app has no sign-in and reads the server's own folders and keys.
  if (hostedMode()) throw new Error("The local UI does not run in hosted mode.");
  const port = Number(process.env.UI_PORT ?? 4310);
  // Bound to this computer only: there is no login yet.
  createUiServer(port).listen(port, "127.0.0.1", () => {
    console.log(`Hivelock UI: http://127.0.0.1:${port}`);
  });
}

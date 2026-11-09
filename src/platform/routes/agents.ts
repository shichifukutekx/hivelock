import { lstatSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { z } from "zod";
import { ApprovalRefused, SessionBusy, type AgentChat } from "../agent-chat.ts";
import { capabilities, draftAgent } from "../agent-drafts.ts";
import { agentLooks } from "../agent-looks.ts";
import { workspaceDirectory } from "../agents-store.ts";
import { streamSSE } from "hono/streaming";
import { recordAudit } from "../audit-log.ts";
import { assertNotPaused, releaseStorage, reserveStorage } from "../limits.ts";
import { assertMayReadMail } from "../connectors/store.ts";
import { inWorkspace } from "../db.ts";
import { workspaceFolders } from "../engine/nodes.ts";
import type { PlatformEnv } from "../env.ts";
import type { Knowledge } from "../knowledge.ts";
import type { LiveHub } from "../live.ts";
import { can, type Permission } from "../permissions.ts";
import { readPage } from "../paging.ts";
import { extractIsolated } from "../../rfq/extract.ts";
import JSZip from "jszip";
import { EXPORT_TYPES } from "../exports.ts";
import { allFiles, allFolders, baseOf, cleanName, cleanPath, copyItem, ensureFolder, freeName, isFolder, listFolder, makeFolder, MAX_DEPTH, moveItem, onDisk, parentOf, PathProblem, removeItem, renameItem, within } from "../workspace-files.ts";
import { allow, LIMITS } from "../rate-limit.ts";
import { RFQ_EXTENSIONS as FILE_EXTENSIONS } from "../../rfq/extract.ts";
import { unseal } from "../secrets.ts";
import { agentGate } from "../extensions.ts";
import type { PgBoss } from "pg-boss";
import { PermanentError } from "../connectors/types.ts";
import { assertWithinBudget } from "../usage.ts";

interface Deps {
  pool: Pool;
  chat: AgentChat;
  /** Starts an agent's tests after a change, when a release gate is installed. */
  boss?: PgBoss;
  knowledge?: Knowledge;
  live?: LiveHub;
  env: PlatformEnv;
  requirePermission: (permission: Permission) => any;
  /** Asks again, for a connection that outlives the check made when it opened. */
  stillAllowed: (request: Request, workspaceId: string, permission: Permission) => Promise<boolean>;
  streamCheckMs?: number;
}

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES = 500;
/** Enough to read a document on screen. The download has the rest. */
const PREVIEW_CHARS = 100_000;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const uuid = z.uuid();

/** Checks that a file really is what its name says. */
function checkFile(name: string, data: Buffer) {
  const extension = extname(name).toLowerCase();
  if (!FILE_EXTENSIONS.includes(extension)) throw new Error(`Only ${FILE_EXTENSIONS.join(", ")} files are supported.`);
  if (data.length === 0) throw new Error("This file is empty.");
  if (data.length > MAX_FILE_BYTES) throw new Error("This file is too large. The limit is 15 MB.");
  const signature = data.subarray(0, 4).toString("latin1");
  if ((extension === ".pdf" && signature !== "%PDF") || (extension === ".xlsx" && signature !== "PK\x03\x04")) {
    throw new Error(`This file is not a real ${extension} file.`);
  }
  return extension;
}

export function addAgentRoutes(app: Hono<any>, { pool, chat, boss, knowledge, live, env, requirePermission, stillAllowed, streamCheckMs = 15_000 }: Deps) {
  const base = "/api/v1/workspaces/:workspaceId";
  const scoped = (c: any) => c.req.param("workspaceId") as string;
  const actor = (c: any) => c.get("user").id as string;
  const missing = (c: any) => c.json({ error: "Not found." }, 404);
  const bad = (c: any, error: unknown) => {
    if (typeof (error as { code?: unknown }).code === "string") throw error;
    return c.json({ error: (error as Error).message }, 400);
  };
  const open = (c: any, value: unknown) => unseal(env.SECRETS_MASTER_KEY, scoped(c), value);
  /** An agent that makes agents is offered only to people who may make them. */
  const mayUse = (c: any, agent: { tools: string[] }) => can(c.get("role"), "agents:write") || !agent.tools.includes("create_agent");
  const validSession = async (c: any, next: () => Promise<void>) => {
    if (!uuid.safeParse(c.req.param("sessionId")).success) return missing(c);
    await next();
  };

  app.get(`${base}/capabilities`, requirePermission("connections:list"), async (c) => c.json(await capabilities(pool, scoped(c))));

  app.post(`${base}/agents/draft`, requirePermission("agents:write"), async (c) => {
    const body = z.object({ description: z.string().trim().min(10).max(4_000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Describe the agent in a sentence or two." }, 400);
    if (!(await allow(pool, `run-start:${scoped(c)}`, LIMITS.runStart))) return c.json({ error: "Too many requests. Try again in a minute." }, 429);
    try {
      return c.json({ draft: await draftAgent(pool, scoped(c), body.data.description, env.SECRETS_MASTER_KEY) });
    } catch (error) {
      return bad(c, error);
    }
  });

  app.get(`${base}/agents/:name`, requirePermission("content:read"), async (c) => {
    const agent = await workspaceDirectory(pool, scoped(c), actor(c)).get(c.req.param("name"));
    if (!agent || !mayUse(c, agent)) return missing(c);
    const { name, description, model, tools, server, connections, mcp, skills, memory, knowledge: searchesDocuments, requiresApproval, createdByAgent } = agent;
    // The saved instructions, without the rules the platform adds.
    const { row, workflows, off } = await inWorkspace(pool, scoped(c), async (db) => ({
      row: (await db.query("select spec from workspace_agents where name = $1", [name])).rows[0],
      off: (await db.query("select reason, turned_off_at from agent_switches where agent_name = $1", [name])).rows[0] ?? null,
      workflows: (await db.query(`select id, name from workflows where definition -> 'nodes' @> $1::jsonb order by name`, [JSON.stringify([{ type: "agent", config: { agent: name } }])])).rows,
    }));
    const gate = (await agentGate()?.states({ pool, masterKey: env.SECRETS_MASTER_KEY }, scoped(c)))?.get(name) ?? null;
    return c.json({ agent: { ...agentLooks(agent), workflows, off, gate, name, description, model, tools, server, connections, mcp, skills, memory, knowledge: searchesDocuments, requiresApproval, createdByAgent, builtIn: !row, instructions: row?.spec.instructions ?? agent.instructions } });
  });

  app.put(`${base}/agents/:name`, requirePermission("agents:write"), async (c: any) => {
    const workspaceId = scoped(c);
    const name = c.req.param("name");
    const request = await c.req.json().catch(() => null);
    try {
      if (!can(c.get("role"), "connections:write")) await assertMayReadMail(pool, workspaceId, request?.connections);
      const updated = await workspaceDirectory(pool, workspaceId, actor(c)).update(name, { ...request, name });
      if (!updated) return missing(c);
      await inWorkspace(pool, workspaceId, (db) => recordAudit(db, { workspaceId, actorId: actor(c), action: "agent.updated", targetType: "agent", targetId: name }));
      // The change is saved either way. With saved tests, workflows keep off it until they pass.
      const gate = boss ? await agentGate()?.changed({ pool, boss }, workspaceId, name, actor(c)) : undefined;
      return c.json({ name, gate: gate ?? null });
    } catch (error) {
      return bad(c, error);
    }
  });

  app.get(`${base}/sessions`, requirePermission("content:read"), async (c) => {
    const agent = c.req.query("agent");
    const { limit, offset } = readPage((name) => c.req.query(name), 50);
    const found = await inWorkspace(pool, scoped(c), async (db) => ({
      total: (await db.query("select count(*)::int as total from agent_sessions where ($1::text is null or agent_name = $1)", [agent ?? null])).rows[0].total as number,
      sessions: (await db.query("select id, agent_name, title, status, updated_at from agent_sessions where ($1::text is null or agent_name = $1) order by updated_at desc, id limit $2 offset $3", [agent ?? null, limit, offset])).rows,
    }));
    return c.json(found);
  });

  app.post(`${base}/sessions`, requirePermission("runs:start"), async (c) => {
    const body = z.object({ agent: z.string().min(1).max(40), title: z.string().trim().min(1).max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose an agent." }, 400);
    const workspaceId = scoped(c);
    const agent = await workspaceDirectory(pool, workspaceId, actor(c)).get(body.data.agent);
    if (!agent || !mayUse(c, agent)) return c.json({ error: "That agent does not exist." }, 400);
    const id = await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [row] } = await db.query("insert into agent_sessions (workspace_id, agent_name, title, created_by) values ($1, $2, $3, $4) returning id", [workspaceId, body.data.agent, body.data.title, actor(c)]);
      await recordAudit(db, { workspaceId, actorId: actor(c), action: "chat.started", targetType: "agent", targetId: body.data.agent });
      return row.id as string;
    });
    return c.json({ id }, 201);
  });

  app.get(`${base}/sessions/:sessionId`, requirePermission("content:read"), validSession, async (c) => {
    const id = c.req.param("sessionId");
    const found = await inWorkspace(pool, scoped(c), async (db) => {
      // Listed by name: a channel's session holds the contact's number, which is not for everyone who can read the chat.
      const { rows: [session] } = await db.query("select id, agent_name, title, status, channel_id, created_by, created_at, updated_at from agent_sessions where id = $1", [id]);
      if (!session) return undefined;
      return {
        session,
        messages: (await db.query("select id, role, content, at from agent_messages where session_id = $1 order by id", [id])).rows,
        activity: (await db.query("select id, event, at from agent_activity where session_id = $1 order by id desc limit 200", [id])).rows.reverse(),
        approvals: (await db.query("select id, tool, args, created_at from agent_approvals where session_id = $1 and status = 'pending' order by created_at", [id])).rows,
      };
    });
    return found ? c.json(open(c, found)) : missing(c);
  });

  // Live text for a chat. Polling still shows everything, so a dropped stream only loses the typing effect.
  app.get(`${base}/sessions/:sessionId/stream`, requirePermission("content:read"), validSession, async (c) => {
    const id = c.req.param("sessionId");
    const workspaceId = scoped(c);
    const { rowCount } = await inWorkspace(pool, workspaceId, (db) => db.query("select 1 from agent_sessions where id = $1", [id]));
    if (!rowCount || !live) return missing(c);
    return streamSSE(c, async (stream) => {
      let closed = false;
      let wake = () => {};
      const queue: { type: string; text?: string }[] = [];
      const stop = live.subscribe(id, (message) => {
        if (message.type === "reconnect") {
          closed = true;
          wake();
          return;
        }
        if (message.workspaceId !== workspaceId) return;
        queue.push({ type: message.type, text: message.text });
        wake();
      });
      stream.onAbort(() => { closed = true; wake(); });
      let nextCheck = Date.now() + streamCheckMs;
      try {
        while (!closed) {
          while (queue.length) await stream.writeSSE({ event: "message", data: JSON.stringify(queue.shift()) });
          const wait = nextCheck - Date.now();
          if (wait > 0) {
            await Promise.race([new Promise<void>((resolve) => { wake = resolve; }), stream.sleep(wait)]);
            continue;
          }
          // Someone removed from the workspace must stop receiving, however long the stream has been open.
          if (!(await stillAllowed(c.req.raw, workspaceId, "content:read"))) break;
          nextCheck = Date.now() + streamCheckMs;
          await stream.writeSSE({ event: "ping", data: "" });
        }
      } finally {
        stop();
      }
    });
  });

  app.post(`${base}/sessions/:sessionId/messages`, requirePermission("runs:start"), validSession, async (c) => {
    const body = z.object({ text: z.string().trim().min(1).max(50_000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Write a message." }, 400);
    if (!(await allow(pool, `run-start:${scoped(c)}`, LIMITS.runStart))) return c.json({ error: "Too many messages. Try again in a minute." }, 429, { "retry-after": "60" });
    // Its replies go to the contact, so words typed here would reach them as the agent's.
    const { rows: [session] } = await inWorkspace(pool, scoped(c), (db) => db.query("select channel_id, agent_name from agent_sessions where id = $1", [c.req.param("sessionId")]));
    if (session?.channel_id) return c.json({ error: "This conversation belongs to a channel, so messages come from its contact." }, 403);
    // Someone with more rights may have opened this chat, and the agent would act for whoever writes next.
    const agent = session && await workspaceDirectory(pool, scoped(c), actor(c)).get(session.agent_name);
    if (agent && !mayUse(c, agent)) return c.json({ error: "Your role does not allow this agent." }, 403);
    try {
      await chat.send(scoped(c), c.req.param("sessionId"), body.data.text);
      return c.json({ sent: true }, 202);
    } catch (error) {
      if (error instanceof SessionBusy) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.post(`${base}/sessions/:sessionId/approvals/:approvalId`, requirePermission("runs:approve"), validSession, async (c) => {
    const body = z.object({ approved: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    const approvalId = uuid.safeParse(c.req.param("approvalId"));
    if (!body.success || !approvalId.success) return c.json({ error: "Choose approve or decline." }, 400);
    const workspaceId = scoped(c);
    let done: boolean;
    try {
      done = await chat.decide(workspaceId, approvalId.data, body.data.approved, actor(c));
    } catch (error) {
      if (error instanceof ApprovalRefused) return c.json({ error: error.message }, 403);
      throw error;
    }
    if (!done) return c.json({ error: "Nothing is waiting for this decision." }, 409);
    await inWorkspace(pool, workspaceId, (db) => recordAudit(db, { workspaceId, actorId: actor(c), action: body.data.approved ? "chat.action_approved" : "chat.action_declined", targetType: "approval", targetId: approvalId.data }));
    return c.json({ decided: true });
  });

  // Files, with folders. Every path is checked by workspace-files, so none can reach outside this workspace's folder.
  const filesRoot = (workspaceId: string) => workspaceFolders(workspaceId).files;
  const fileProblem = (c: any, error: unknown) => (error instanceof PathProblem ? c.json({ error: error.message }, 400) : bad(c, error));
  const pathsBody = z.object({ paths: z.array(z.string().max(400)).min(1).max(500) });
  const startsWith = "(file_name = $1 or left(file_name, length($1) + 1) = $1 || '/')";
  /** Search entries follow their files when a file or folder moves. */
  const moveIndex = (workspaceId: string, from: string, to: string) => inWorkspace(pool, workspaceId, (db) =>
    db.query(`update knowledge_documents set file_name = $2 || substr(file_name, length($1) + 1) where ${startsWith}`, [from, to]));
  const dropIndex = (workspaceId: string, path: string) => inWorkspace(pool, workspaceId, (db) => db.query(`delete from knowledge_documents where ${startsWith}`, [path]));
  const indexAll = async (workspaceId: string, folder: string) => {
    for (const file of allFiles(filesRoot(workspaceId), folder)) if (FILE_EXTENSIONS.includes(extname(file.path).toLowerCase())) await knowledge?.enqueue(workspaceId, file.path);
  };
  const fileCount = (workspaceId: string) => allFiles(filesRoot(workspaceId)).length;
  const audit = (c: any, action: string, targetId: string, details: Record<string, unknown> = {}) =>
    inWorkspace(pool, scoped(c), (db) => recordAudit(db, { workspaceId: scoped(c), actorId: actor(c), action, targetType: "file", targetId, details }));

  // One folder's contents. With ?all=1, every file in every folder, for pickers that need them all.
  app.get(`${base}/files`, requirePermission("content:read"), async (c) => {
    const workspaceId = scoped(c);
    try {
      const root = filesRoot(workspaceId);
      const folder = cleanPath(c.req.query("folder"));
      const documents = await inWorkspace(pool, workspaceId, async (db) => (await db.query("select file_name, status, chunks, embedded, error from knowledge_documents")).rows);
      const index = (path: string) => {
        const document = documents.find((d) => d.file_name === path);
        return document ? { status: document.status, passages: document.chunks, meaning: document.embedded, error: document.error } : undefined;
      };
      if (c.req.query("all") === "1") {
        return c.json({ files: allFiles(root).map(({ path, size }) => ({ name: path, path, size, index: index(path) })) });
      }
      const entries = listFolder(root, folder).map((entry) => ({ ...entry, index: entry.kind === "file" ? index(entry.path) : undefined }));
      return c.json({
        folder, entries,
        // The older shape, for anything that still asks for a flat list of files.
        files: entries.filter((entry) => entry.kind === "file").map((entry) => ({ name: entry.path, size: entry.size, modified: entry.modified, index: entry.index })),
      });
    } catch (error) {
      return fileProblem(c, error);
    }
  });

  // An answer or a run's result as a spreadsheet, PDF or CSV: downloaded, or saved into Files.
  const exportBody = z.object({ text: z.string().min(1).max(1_000_000), format: z.enum(["xlsx", "pdf", "csv"]), name: z.string().trim().min(1).max(120), folder: z.string().max(400).optional() });
  const exported = async (body: z.infer<typeof exportBody>) => {
    const title = body.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || "Report";
    return { file: `${title}.${body.format}`, title, data: await EXPORT_TYPES[body.format].make(body.text, title) };
  };
  app.post(`${base}/exports`, requirePermission("content:read"), async (c) => {
    const body = exportBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "There is nothing to export." }, 400);
    const { file, data } = await exported(body.data);
    return sendFile(c, file, data);
  });
  app.post(`${base}/exports/save`, requirePermission("runs:start"), async (c) => {
    const body = exportBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "There is nothing to save." }, 400);
    const workspaceId = scoped(c);
    const root = filesRoot(workspaceId);
    if (!env.HOSTED_MODE && fileCount(workspaceId) >= MAX_FILES) return c.json({ error: "This workspace has too many files." }, 400);
    try {
      const folder = cleanPath(body.data.folder);
      ensureFolder(root, folder);
      const { file, data } = await exported(body.data);
      const saved = within(folder, freeName(root, folder, cleanName(file)));
      await reserveStorage(pool, workspaceId, data.length);
      try {
        writeFileSync(join(root, saved), data, { flag: "wx", mode: 0o600 });
      } catch (error) {
        await releaseStorage(pool, workspaceId, data.length);
        throw error;
      }
      await audit(c, "file.uploaded", saved, { from: "export" });
      await knowledge?.enqueue(workspaceId, saved);
      return c.json({ name: saved }, 201);
    } catch (error) {
      return fileProblem(c, error);
    }
  });

  app.get(`${base}/folders`, requirePermission("content:read"), (c) => c.json({ folders: allFolders(filesRoot(scoped(c))) }));

  /** Only a plain file really in this workspace's folder. A path or a link can never reach outside it. */
  const ownFile = (workspaceId: string, raw: string) => {
    try {
      const path = cleanPath(raw);
      if (!path) return undefined;
      const place = onDisk(filesRoot(workspaceId), path);
      return lstatSync(place).isFile() ? { name: path, base: baseOf(path), path: place } : undefined;
    } catch {
      return undefined;
    }
  };
  const preview = async (c: any, raw: string) => {
    const file = ownFile(scoped(c), raw);
    if (!file) return missing(c);
    try {
      const text = await extractIsolated(file.path);
      return c.json({ name: file.name, kind: extname(file.name).slice(1).toLowerCase(), text: text.slice(0, PREVIEW_CHARS), cut: text.length > PREVIEW_CHARS });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  };
  const TYPES: Record<string, string> = { ".pdf": "application/pdf", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".zip": "application/zip" };
  // Always a download, never shown as a page, so nothing in a file can run here.
  const sendFile = (c: any, name: string, data: Buffer) => c.body(data, 200, {
    "content-type": TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${name.replace(/[^\w.() -]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox",
    "cache-control": "private, no-store",
  });
  const download = (c: any, raw: string) => {
    const file = ownFile(scoped(c), raw);
    return file ? sendFile(c, file.base, readFileSync(file.path)) : missing(c);
  };
  app.get(`${base}/files/preview`, requirePermission("content:read"), (c) => preview(c, c.req.query("path") ?? ""));
  app.get(`${base}/files/download`, requirePermission("content:read"), (c) => download(c, c.req.query("path") ?? ""));
  app.get(`${base}/files/:name/preview`, requirePermission("content:read"), (c) => preview(c, c.req.param("name")));
  app.get(`${base}/files/:name/download`, requirePermission("content:read"), (c) => download(c, c.req.param("name")));

  // Several files and folders as one zip, keeping their folders.
  app.post(`${base}/files/zip`, requirePermission("content:read"), async (c) => {
    const body = pathsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose what to download." }, 400);
    try {
      const root = filesRoot(scoped(c));
      const zip = new JSZip();
      let total = 0;
      for (const raw of body.data.paths) {
        const path = cleanPath(raw);
        onDisk(root, path);
        const files = isFolder(root, path) ? allFiles(root, path) : [{ path, size: statSync(onDisk(root, path)).size }];
        for (const file of files) {
          total += file.size;
          if (total > MAX_ZIP_BYTES) return c.json({ error: "That is too much to download at once. Choose fewer files." }, 400);
          zip.file(file.path.slice(parentOf(path).length ? parentOf(path).length + 1 : 0), readFileSync(onDisk(root, file.path)));
        }
      }
      return sendFile(c, body.data.paths.length === 1 ? `${baseOf(cleanPath(body.data.paths[0]))}.zip` : "files.zip", await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    } catch (error) {
      return fileProblem(c, error);
    }
  });

  app.post(`${base}/knowledge/search`, requirePermission("content:read"), async (c) => {
    const body = z.object({ query: z.string().trim().min(1).max(2_000) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success || !knowledge) return c.json({ error: "Enter something to search for." }, 400);
    const workspaceId = scoped(c);
    if (!(await allow(pool, `document-search:${workspaceId}`, LIMITS.documentSearch))) return c.json({ error: "Too many searches. Try again in a minute." }, 429, { "retry-after": "60" });
    try {
      await assertWithinBudget(pool, workspaceId);
    } catch (error) {
      if (error instanceof PermanentError) return c.json({ error: error.message }, 429);
      throw error;
    }
    return c.json({ results: await knowledge.search(workspaceId, body.data.query, 10) });
  });

  app.post(`${base}/files/index`, requirePermission("runs:start"), async (c) => {
    const workspaceId = scoped(c);
    const file = ownFile(workspaceId, String((await c.req.json().catch(() => ({})))?.path ?? ""));
    if (!knowledge || !file) return missing(c);
    // Asking again is a choice to spend, so it is refused while paused. An upload is kept, and its indexing waits for Resume.
    await inWorkspace(pool, workspaceId, (db) => assertNotPaused(db, workspaceId));
    await knowledge.enqueue(workspaceId, file.name);
    return c.json({ queued: true }, 202);
  });
  app.post(`${base}/files/:name/index`, requirePermission("runs:start"), async (c) => {
    const workspaceId = scoped(c);
    const file = ownFile(workspaceId, c.req.param("name"));
    if (!knowledge || !file) return missing(c);
    await inWorkspace(pool, workspaceId, (db) => assertNotPaused(db, workspaceId));
    await knowledge.enqueue(workspaceId, file.name);
    return c.json({ queued: true }, 202);
  });

  // A file keeps the name it was uploaded with. A clash gets " (2)" and so on, so nothing is overwritten.
  // A name with folders in it, from a folder upload, makes those folders.
  app.post(`${base}/files`, requirePermission("runs:start"), async (c) => {
    const body = z.object({ name: z.string().min(1).max(400), dataBase64: z.string(), folder: z.string().max(400).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose a file to upload." }, 400);
    const workspaceId = scoped(c);
    const root = filesRoot(workspaceId);
    // Hosted storage is limited by size, and the plans allow far more than this many files at the largest size.
    if (!env.HOSTED_MODE && fileCount(workspaceId) >= MAX_FILES) return c.json({ error: "This workspace has too many files." }, 400);
    try {
      const wanted = cleanPath(within(cleanPath(body.data.folder), cleanPath(body.data.name)));
      if (!wanted) throw new PathProblem("Choose a file to upload.");
      const data = Buffer.from(body.data.dataBase64, "base64");
      checkFile(wanted, data);
      const folder = parentOf(wanted);
      if (folder.split("/").length >= MAX_DEPTH) throw new PathProblem(`Folders can go ${MAX_DEPTH} levels deep.`);
      // Folders on the way are made as needed, each checked for links first.
      ensureFolder(root, folder);
      const saved = within(folder, freeName(root, folder, baseOf(wanted)));
      await reserveStorage(pool, workspaceId, data.length);
      try {
        writeFileSync(join(root, saved), data, { flag: "wx", mode: 0o600 });
      } catch (error) {
        await releaseStorage(pool, workspaceId, data.length);
        throw error;
      }
      await audit(c, "file.uploaded", saved);
      await knowledge?.enqueue(workspaceId, saved);
      return c.json({ name: saved }, 201);
    } catch (error) {
      return fileProblem(c, error);
    }
  });

  app.post(`${base}/files/folder`, requirePermission("runs:start"), async (c) => {
    const body = z.object({ folder: z.string().max(400).optional(), name: z.string().max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter a folder name." }, 400);
    try {
      const path = makeFolder(filesRoot(scoped(c)), cleanPath(body.data.folder), body.data.name);
      await audit(c, "file.folder_created", path);
      return c.json({ path }, 201);
    } catch (error) {
      return fileProblem(c, error);
    }
  });

  app.post(`${base}/files/rename`, requirePermission("runs:start"), async (c) => {
    const body = z.object({ path: z.string().max(400), name: z.string().max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Enter a new name." }, 400);
    const workspaceId = scoped(c);
    try {
      const from = cleanPath(body.data.path);
      const to = renameItem(filesRoot(workspaceId), from, body.data.name);
      if (to !== from) await moveIndex(workspaceId, from, to);
      await audit(c, "file.renamed", to, { from });
      return c.json({ path: to });
    } catch (error) {
      return fileProblem(c, error);
    }
  });

  // Moving and copying work through a list, and say which items could not be done and why.
  app.post(`${base}/files/move`, requirePermission("runs:start"), async (c) => {
    const body = pathsBody.extend({ to: z.string().max(400) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose what to move, and where." }, 400);
    const workspaceId = scoped(c);
    const root = filesRoot(workspaceId);
    const done: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const raw of body.data.paths) {
      try {
        const from = cleanPath(raw);
        const to = moveItem(root, from, cleanPath(body.data.to));
        if (to !== from) await moveIndex(workspaceId, from, to);
        done.push(to);
      } catch (error) {
        failed.push({ path: raw, error: (error as Error).message });
      }
    }
    if (done.length) await audit(c, "file.moved", cleanPath(body.data.to) || "/", { count: done.length });
    return c.json({ done, failed });
  });

  app.post(`${base}/files/copy`, requirePermission("runs:start"), async (c) => {
    const body = pathsBody.extend({ to: z.string().max(400) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose what to copy, and where." }, 400);
    const workspaceId = scoped(c);
    const root = filesRoot(workspaceId);
    const done: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const raw of body.data.paths) {
      try {
        const from = cleanPath(raw);
        const sizes = isFolder(root, from) ? allFiles(root, from) : [{ path: from, size: statSync(onDisk(root, from)).size }];
        if (!env.HOSTED_MODE && fileCount(workspaceId) + sizes.length > MAX_FILES) throw new PathProblem("This workspace would have too many files.");
        const bytes = sizes.reduce((sum, file) => sum + file.size, 0);
        await reserveStorage(pool, workspaceId, bytes);
        let to: string;
        try {
          to = copyItem(root, from, cleanPath(body.data.to));
        } catch (error) {
          await releaseStorage(pool, workspaceId, bytes);
          throw error;
        }
        await indexAll(workspaceId, to);
        done.push(to);
      } catch (error) {
        failed.push({ path: raw, error: (error as Error).message });
      }
    }
    if (done.length) await audit(c, "file.copied", cleanPath(body.data.to) || "/", { count: done.length });
    return c.json({ done, failed });
  });

  app.post(`${base}/files/delete`, requirePermission("runs:start"), async (c) => {
    const body = pathsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Choose what to delete." }, 400);
    const workspaceId = scoped(c);
    const root = filesRoot(workspaceId);
    const done: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const raw of body.data.paths) {
      try {
        const path = cleanPath(raw);
        const bytes = (isFolder(root, path) ? allFiles(root, path) : [{ path, size: statSync(onDisk(root, path)).size }]).reduce((sum, file) => sum + file.size, 0);
        removeItem(root, path);
        await releaseStorage(pool, workspaceId, bytes);
        await dropIndex(workspaceId, path);
        done.push(path);
      } catch (error) {
        failed.push({ path: raw, error: (error as Error).message });
      }
    }
    for (const path of done) await audit(c, "file.deleted", path);
    return c.json({ done, failed });
  });

  app.delete(`${base}/files/:name`, requirePermission("runs:start"), async (c) => {
    const workspaceId = scoped(c);
    const file = ownFile(workspaceId, c.req.param("name"));
    if (!file) return missing(c);
    const { size } = statSync(file.path);
    rmSync(file.path);
    await releaseStorage(pool, workspaceId, size);
    await dropIndex(workspaceId, file.name);
    await audit(c, "file.deleted", file.name);
    return c.json({ deleted: true });
  });
}

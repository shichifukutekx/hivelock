import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { runAgent } from "../runtime.ts";
import { workspaceDirectory } from "./agents-store.ts";
import { checkAnswer, runOptions } from "./agent-setup.ts";
import { guardEvents, looksLikeInjection, redactSecrets } from "./guardrails.ts";
import { jobFailures } from "./metrics.ts";
import { recordSpan, spanRecorder } from "./observability.ts";
import { inWorkspace } from "./db.ts";
import { admit, turnKey } from "./engine/fair-queue.ts";
import { extensions } from "./extensions.ts";
import { can } from "./permissions.ts";
import { assertActive, assertNotPaused, consumeRuns, isPaused, isSuspended, WorkspacePaused } from "./limits.ts";
import type { Knowledge } from "./knowledge.ts";
import { publishDone, tokenStream } from "./live.ts";
import { workspaceFolders } from "./engine/nodes.ts";
import type { NetworkPolicy } from "./net/safe-fetch.ts";
import { seal, unseal } from "./secrets.ts";
import { assertWithinBudget, isConfidential, recordTokens } from "./usage.ts";
import { hideDatabaseNames, namesFromToolCall } from "./answer-polish.ts";

export const AGENT_QUEUE = "agent-turn";
const MAX_HISTORY = 40;
const STALE_MINUTES = 35;

export interface TurnJob {
  workspaceId: string;
  sessionId: string;
}

interface Options {
  masterKey: string;
  network: NetworkPolicy;
  /** How long a run waits for a person before treating the action as declined. */
  approvalSeconds?: number;
  heartbeatSeconds?: number;
  search?: Knowledge["search"];
}

export class SessionBusy extends Error {}

/**
 * A conversation's lifecycle. idle → running when a message is sent; running ⇄ waiting while a person decides;
 * running or waiting → idle when the turn ends. A turn is named by the user message that started it, the newest one,
 * so a worker that outlived its turn (a stale takeover) can no longer change the conversation or answer in it.
 */
const ACTIVE_SESSION = ["running", "waiting"];
const latestUserMessage = "(select max(id) from agent_messages where session_id = $1 and role = 'user')";
export class ApprovalRefused extends Error {}

/** Text-level redaction can cut across JSON, so a result that no longer parses is shown as text. */
function safeArgs(args: unknown) {
  const text = redactSecrets(JSON.stringify(args ?? null)).text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createAgentChat(pool: Pool, boss: PgBoss, { masterKey, network, approvalSeconds = 900, heartbeatSeconds = 60, search }: Options) {
  const sealed = (workspaceId: string, value: unknown) => JSON.stringify(seal(masterKey, workspaceId, value));
  // A turn is never retried, because its tools may already have acted.
  const turnJobOptions = { retryLimit: 0, expireInSeconds: 1_800, heartbeatSeconds };

  async function send(workspaceId: string, sessionId: string, text: string) {
    await inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [session] } = await db.query("select status, updated_at < now() - make_interval(mins => $2) as stale from agent_sessions where id = $1 for update", [sessionId, STALE_MINUTES]);
      if (!session) throw new SessionBusy("This conversation no longer exists.");
      // A worker that died leaves a turn marked as running, so an old one does not block the conversation.
      if (session.status !== "idle" && !session.stale) throw new SessionBusy("The agent is still working on your last message.");
      await assertNotPaused(db, workspaceId);
      await consumeRuns(db, workspaceId);
      // A turn left behind by a worker that died can leave a question waiting that nobody can answer any more.
      if (session.status !== "idle") await db.query("update agent_approvals set status = 'expired' where session_id = $1 and status = 'pending'", [sessionId]);
      await db.query("insert into agent_messages (workspace_id, session_id, role, content) values ($1, $2, 'user', $3)", [workspaceId, sessionId, sealed(workspaceId, text)]);
      await db.query("update agent_sessions set status = 'running', updated_at = now() where id = $1", [sessionId]);
      const job = { workspaceId, sessionId };
      if (await admit(db, AGENT_QUEUE, workspaceId, turnKey(job), job)) {
        await boss.send(AGENT_QUEUE, { ...job }, { ...turnJobOptions, db: { executeSql: (sql: string, values?: unknown[]) => db.query(sql, values as unknown[]) } });
      }
    });
  }

  /** Moves a conversation between running and waiting, only while it is still this turn's. */
  const setStatus = (workspaceId: string, sessionId: string, turn: string, status: "running" | "waiting") =>
    inWorkspace(pool, workspaceId, (db) => db.query(
      `update agent_sessions set status = $2, updated_at = now() where id = $1 and status = any($3) and ${latestUserMessage} = $4`,
      [sessionId, status, ACTIVE_SESSION, turn],
    ));

  /** Sends text to the person on the far end of a channel. A plain chat has nobody to send to. It goes out through the customer's own account, so a pause or a suspension stops it. */
  async function notifyContact(workspaceId: string, sessionId: string, text: string) {
    if (await inWorkspace(pool, workspaceId, async (db) => (await isPaused(db, workspaceId)) || isSuspended(db, workspaceId))) return;
    for (const { notifyContact: notify } of extensions()) await notify?.({ pool, masterKey, network }, workspaceId, sessionId, text);
  }

  /** Waits for a person. The worker stays heartbeating, so a slow decision is not mistaken for a crash. */
  async function askPerson(workspaceId: string, sessionId: string, turn: string, tool: string, args: unknown) {
    // Anyone who can read the workspace can read a pending approval, so a key in the arguments must not reach it.
    const shown = safeArgs(args);
    await notifyContact(workspaceId, sessionId, "This needs an approval in the app before I can continue.");
    const id = await inWorkspace(pool, workspaceId, async (db) => {
      const { rowCount } = await db.query(
        `update agent_sessions set status = 'waiting', updated_at = now() where id = $1 and status = any($2) and ${latestUserMessage} = $3`,
        [sessionId, ACTIVE_SESSION, turn],
      );
      // This turn was taken over, so asking now would leave a question nobody's turn can use.
      if (!rowCount) return undefined;
      return (await db.query("insert into agent_approvals (workspace_id, session_id, tool, args) values ($1, $2, $3, $4) returning id", [workspaceId, sessionId, tool, sealed(workspaceId, shown)])).rows[0].id as string;
    });
    if (!id) return false;
    const deadline = Date.now() + approvalSeconds * 1_000;
    while (Date.now() < deadline) {
      const status = await inWorkspace(pool, workspaceId, async (db) => (await db.query("select status from agent_approvals where id = $1", [id])).rows[0]?.status);
      if (status !== "pending") {
        await setStatus(workspaceId, sessionId, turn, "running");
        return status === "approved";
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await inWorkspace(pool, workspaceId, (db) => db.query("update agent_approvals set status = 'expired' where id = $1 and status = 'pending'", [id]));
    await setStatus(workspaceId, sessionId, turn, "running");
    return false;
  }

  async function runTurn({ workspaceId, sessionId }: TurnJob) {
    // A turn must not run twice. A second copy of a job finds its conversation already finished.
    const { rows: [current] } = await inWorkspace(pool, workspaceId, (db) => db.query(`select status, ${latestUserMessage}::text as turn from agent_sessions where id = $1`, [sessionId]));
    if (current?.status !== "running" || !current.turn) return;
    const turn = current.turn as string;

    /** Ends this turn with its answer. A turn that was taken over writes nothing, so it cannot answer someone else's message. */
    const finish = (role: "assistant" | "error", text: string) => inWorkspace(pool, workspaceId, async (db) => {
      const { rows: [mine] } = await db.query(
        `select 1 from agent_sessions where id = $1 and status = any($2) and ${latestUserMessage} = $3 for update`,
        [sessionId, ACTIVE_SESSION, turn],
      );
      if (!mine) return;
      await db.query("insert into agent_messages (workspace_id, session_id, role, content) values ($1, $2, $3, $4)", [workspaceId, sessionId, role, sealed(workspaceId, text)]);
      await db.query("update agent_approvals set status = 'expired' where session_id = $1 and status = 'pending'", [sessionId]);
      await db.query("update agent_sessions set status = 'idle', updated_at = now() where id = $1", [sessionId]);
    });

    let writes = Promise.resolve();
    const live = tokenStream(pool, workspaceId, sessionId);
    try {
      await assertWithinBudget(pool, workspaceId);
      // A turn can wait in the queue, and the workspace may have stopped since it was sent.
      await inWorkspace(pool, workspaceId, async (db) => {
        await assertActive(db, workspaceId);
        await assertNotPaused(db, workspaceId);
      });
      const { session, messages } = await inWorkspace(pool, workspaceId, async (db) => ({
        session: (await db.query("select agent_name, created_by from agent_sessions where id = $1", [sessionId])).rows[0],
        messages: (await db.query("select role, content from agent_messages where session_id = $1 and role <> 'error' order by id desc limit $2", [sessionId, MAX_HISTORY])).rows.reverse(),
      }));
      const directory = workspaceDirectory(pool, workspaceId, session.created_by);
      const agent = await directory.get(session.agent_name);
      if (!agent) throw new Error("This agent no longer exists.");
      const off = await directory.turnedOff?.(agent.name);
      if (off) throw new Error(off);
      const opened = messages.map((m) => ({ role: m.role as "user" | "assistant", content: unseal(masterKey, workspaceId, m.content) as string }));
      const prompt = opened.at(-1)!.content;

      if (looksLikeInjection(prompt)) await recordSpan(pool, workspaceId, sessionId, "chat", { kind: "guardrail", name: "injection_attempt", agent: agent.name, status: "refused" });
      const spans = spanRecorder(pool, workspaceId, sessionId, "chat");
      const { rows: [settings] } = await inWorkspace(pool, workspaceId, (db) => db.query("select redact_personal_data from workspace_settings where workspace_id = $1", [workspaceId]));
      const onEvent = guardEvents(settings?.redact_personal_data, (event: any) => {
        writes = writes.then(() => inWorkspace(pool, workspaceId, (db) => db.query(
          "insert into agent_activity (workspace_id, session_id, event) values ($1, $2, $3)", [workspaceId, sessionId, sealed(workspaceId, event)],
        ))).then(async () => {
          await spans(event);
          if (event.type === "model" && event.tokens) await recordTokens(pool, workspaceId, event.tokens);
        }).then(() => undefined, (error) => console.error(JSON.stringify({ level: "error", event: "activity_lost", message: error.message })));
      });

      const context = { pool, workspaceId, masterKey, network, search };
      const queried = new Set<string>();
      const raw = await runAgent(agent, prompt, ({ tool, args }) => askPerson(workspaceId, sessionId, turn, tool, args), (event: any) => { namesFromToolCall(event, queried); onEvent(event); }, {
        directory,
        policy: { confidential: await isConfidential(pool, workspaceId) },
        folders: workspaceFolders(workspaceId),
        history: opened.slice(0, -1),
        ...runOptions(context),
        // Personal data can only be spotted in the finished answer, so those workspaces do not stream.
        onToken: settings?.redact_personal_data ? undefined : live.push,
      });
      await writes;
      const answer = hideDatabaseNames(await checkAnswer(context, sessionId, "chat", agent.name, raw), queried);
      await finish("assistant", answer);
      await live.end();
      await notifyContact(workspaceId, sessionId, answer);
    } catch (error) {
      await writes;
      // Nothing went wrong, and the turn is not kept for later: it ends here, says so, and its message can be sent again after Resume.
      if (error instanceof WorkspacePaused) {
        await finish("error", "The workspace was paused before this was answered. Send your message again after Resume.");
        await live.end();
        return;
      }
      jobFailures.inc({ queue: AGENT_QUEUE });
      await finish("error", error instanceof Error ? error.message : String(error));
      await live.end();
      await notifyContact(workspaceId, sessionId, "Sorry, something went wrong. Please try again.");
    }
  }

  /** Making an agent needs agents:write, from whoever started the chat or whoever approves. Approving alone is open to operators. */
  async function assertMayCreateAgent(workspaceId: string, approvalId: string, actorId: string) {
    const request = await inWorkspace(pool, workspaceId, async (db) => (await db.query(
      "select a.tool, s.created_by from agent_approvals a join agent_sessions s on s.id = a.session_id where a.id = $1", [approvalId],
    )).rows[0]);
    if (request?.tool !== "create_agent") return;
    const { rows } = await pool.query<{ role: string }>(`select role from member where "organizationId" = $1 and "userId" = any($2)`, [workspaceId, [actorId, request.created_by]]);
    if (!rows.some(({ role }) => can(role, "agents:write"))) throw new ApprovalRefused("Your role does not allow creating agents.");
  }

  async function decide(workspaceId: string, approvalId: string, approved: boolean, actorId: string) {
    if (approved) await assertMayCreateAgent(workspaceId, approvalId, actorId);
    return inWorkspace(pool, workspaceId, async (db) => {
      if (approved) await assertNotPaused(db, workspaceId);
      const { rowCount } = await db.query(
        "update agent_approvals set status = $2, decided_by = $3 where id = $1 and status = 'pending'",
        [approvalId, approved ? "approved" : "declined", actorId],
      );
      return rowCount === 1;
    });
  }

  /** A worker is stopping before this turn finished. It cannot safely be run again, so the person is told, and the conversation is free again. */
  async function interrupt(workspaceId: string, sessionId: string) {
    await inWorkspace(pool, workspaceId, async (db) => {
      // Only a turn still in progress is interrupted; one that already ended keeps its answer.
      const { rowCount } = await db.query("update agent_sessions set status = 'idle', updated_at = now() where id = $1 and status = any($2)", [sessionId, ACTIVE_SESSION]);
      if (!rowCount) return;
      await db.query("update agent_approvals set status = 'expired' where session_id = $1 and status = 'pending'", [sessionId]);
      await db.query("insert into agent_messages (workspace_id, session_id, role, content) values ($1, $2, 'error', $3)", [workspaceId, sessionId, sealed(workspaceId, "The server restarted before this finished. Check what was done, then send your message again.")]);
    });
    await publishDone(pool, workspaceId, sessionId);
  }

  return { send, runTurn, interrupt, decide, turnJobOptions };
}

export type AgentChat = ReturnType<typeof createAgentChat>;

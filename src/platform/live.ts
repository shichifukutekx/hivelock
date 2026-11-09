import pg, { type Pool } from "pg";
import { redactSecrets } from "./guardrails.ts";

const CHANNEL = "agent_stream";
const MAX_PAYLOAD = 7_000;
const FLUSH_MS = 40;

export interface LiveMessage {
  workspaceId: string;
  sessionId: string;
  /** "reconnect" tells a viewer's stream to end, because this server is stopping. It goes only to this server's viewers. */
  type: "token" | "done" | "reconnect";
  text?: string;
}

const KEY_END = /-----END [A-Z ]*-----/g;

/** How much of the text can be checked and sent. A private key block counts as one word, so it is never cut. */
function safeBoundary(text: string) {
  let end = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t")) + 1;
  let from = 0;
  for (;;) {
    const start = text.indexOf("-----BEGIN", from);
    if (start < 0) return end;
    KEY_END.lastIndex = start;
    const close = KEY_END.exec(text);
    if (!close) return Math.min(end, start);
    from = close.index + close[0].length;
    if (start < end) end = Math.max(end, from);
  }
}

const publish = (pool: Pool, message: LiveMessage) => pool.query("select pg_notify($1, $2)", [CHANNEL, JSON.stringify(message)]);

/** Tells viewers on every server that the live text has ended. */
export const publishDone = (pool: Pool, workspaceId: string, sessionId: string) => publish(pool, { workspaceId, sessionId, type: "done" });

/**
 * Sends tokens to viewers as they arrive. Text is checked before it leaves. Credentials contain no spaces, so
 * only finished words are sent, and a private key block is held until it closes.
 */
export function tokenStream(pool: Pool, workspaceId: string, sessionId: string) {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending = Promise.resolve();

  const send = (text: string) => {
    for (let start = 0; start < text.length; start += MAX_PAYLOAD / 2) {
      const part = text.slice(start, start + MAX_PAYLOAD / 2);
      sending = sending.then(() => publish(pool, { workspaceId, sessionId, type: "token", text: part })).then(() => undefined, () => undefined);
    }
  };

  const flush = (final: boolean) => {
    timer = undefined;
    // Only finished words are checked. Checking a half-arrived key would replace part of it and let the rest through.
    const safeEnd = final ? buffer.length : safeBoundary(buffer);
    if (safeEnd > 0) {
      send(redactSecrets(buffer.slice(0, safeEnd)).text);
      buffer = buffer.slice(safeEnd);
    }
  };

  return {
    push(text: string) {
      buffer += text;
      timer ??= setTimeout(() => flush(false), FLUSH_MS);
      timer.unref?.();
    },
    /** A model turn that ended in a tool call says nothing final, so its partial text is dropped on the next turn. */
    async end() {
      if (timer) clearTimeout(timer);
      // The saved answer replaces the live text at this point, so anything still unchecked is simply dropped.
      buffer = "";
      sending = sending.then(() => publish(pool, { workspaceId, sessionId, type: "done" })).then(() => undefined, () => undefined);
      await sending;
    },
    flushNow: () => flush(true),
  };
}

type Listener = (message: LiveMessage) => void;

/** One database connection per server, passing tokens to the browsers watching each chat. */
export function createLiveHub(connectionString: string) {
  const listeners = new Map<string, Set<Listener>>();
  let client: pg.Client | undefined;
  let stopped = false;

  const connect = async () => {
    if (stopped) return;
    const next = new pg.Client({ connectionString });
    // A lost connection reports itself more than once. Each report must not start its own replacement, or every token would arrive twice.
    let gone = false;
    const lost = () => {
      if (gone) return;
      gone = true;
      if (client === next) client = undefined;
      next.end().catch(() => {});
      // Runs again if this attempt fails too, so the hub comes back however long the database is away.
      if (!stopped) setTimeout(() => void connect().catch(() => {}), 2_000).unref();
    };
    next.on("error", lost);
    next.on("end", lost);
    next.on("notification", ({ payload }) => {
      if (!payload) return;
      const message = JSON.parse(payload) as LiveMessage;
      for (const listener of listeners.get(message.sessionId) ?? []) listener(message);
    });
    try {
      await next.connect();
      await next.query(`listen ${CHANNEL}`);
    } catch (error) {
      lost();
      throw error;
    }
    // Stopped while this was connecting, so nothing would ever close it.
    if (stopped) {
      await next.end().catch(() => {});
      return;
    }
    client = next;
  };

  return {
    start: connect,
    /** Whether tokens can reach this server right now. */
    connected: () => !!client,
    /** Ends this server's open streams, so browsers reconnect to another one. Polling carries on regardless. */
    closeStreams() {
      for (const [sessionId, set] of listeners) for (const listener of set) listener({ workspaceId: "", sessionId, type: "reconnect" });
    },
    subscribe(sessionId: string, listener: Listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(sessionId);
      };
    },
    async stop() {
      stopped = true;
      await client?.end().catch(() => {});
    },
  };
}

export type LiveHub = ReturnType<typeof createLiveHub>;

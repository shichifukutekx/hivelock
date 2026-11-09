import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Job, PgBoss, SendOptions } from "pg-boss";
import { hostedMode } from "../../config.ts";
import { inWorkspace } from "../db.ts";
import { reportError } from "../error-reporting.ts";
import { hostedPolicy } from "../extensions.ts";
import { log } from "../log.ts";
import { jobDuration, jobFailures, queueDeferrals, queueWait } from "../metrics.ts";

/**
 * Keeps one busy workspace from taking every worker. Each workspace has a limit on places across all worker processes, and a step or turn
 * needs a place to run. Work over the limit stays in work_waiting and never enters the shared queue, so the queue holds only a few jobs from
 * each workspace and a flood from one cannot sit in front of another. When a place frees, the oldest waiting job goes on the queue.
 * A running job holds a lease that its worker keeps renewing, so a dead worker's place comes back by itself.
 *
 * pg-boss's own group limits were not enough: they count one queue at a time, and steps and turns share one limit here.
 */

/** How long a lease lasts unrenewed. A dead worker's place comes back within this time plus one sweep. */
export const LEASE_SECONDS = 60;
const SWEEP_SECONDS = 10;
const LIMIT_CACHE_MS = 60_000;
/** Below one worker's capacity, so a workspace at its limit leaves room for the others. */
export const DEFAULT_WORK_LIMIT = 4;

const limits = new Map<string, { limit: number; until: number }>();

/** The server's limit, or in hosted mode the plan's. The plan is remembered for a minute, as this is asked for every job. `db` is scoped to the workspace. */
async function limitFor(db: PoolClient, workspaceId: string) {
  const fallback = Number(process.env.WORKSPACE_WORK_LIMIT) || DEFAULT_WORK_LIMIT;
  if (!hostedMode()) return fallback;
  const known = limits.get(workspaceId);
  if (known && known.until > Date.now()) return known.limit;
  const limit = (await hostedPolicy().workLimit?.(db, workspaceId)) ?? fallback;
  if (limits.size > 10_000) limits.clear();
  limits.set(workspaceId, { limit, until: Date.now() + LIMIT_CACHE_MS });
  return limit;
}

const noted = (queue: string) => queueDeferrals.inc({ queue });

/**
 * Called where work is created, with `db` the transaction creating it. True means send the job now, in that transaction. False means it was
 * kept back, and goes on the queue when a place frees.
 */
export async function admit(db: PoolClient, queue: string, workspaceId: string, key: string, data: object) {
  const { rows: [row] } = await db.query<{ admitted: boolean }>(
    "select work_admit($1, $2, $3, $4, $5) as admitted", [workspaceId, queue, key, JSON.stringify(data), await limitFor(db, workspaceId)],
  );
  if (!row!.admitted) noted(queue);
  return row!.admitted;
}

export const stepKey = ({ runId, nodeId }: { runId: string; nodeId: string }) => `step:${runId}:${nodeId}`;
export const turnKey = ({ sessionId }: { sessionId: string }) => `turn:${sessionId}`;

export interface FairOptions {
  leaseSeconds?: number;
  sweepSeconds?: number;
}

interface Running {
  queue: string;
  key: string;
  data: object;
  /** Tidies up when the worker has to stop before this finishes. */
  handBack?: () => Promise<void>;
  /** Run it again elsewhere. A turn says no, because its tools may already have acted. */
  requeue: boolean;
  done: Promise<void>;
}

const asExecutor = (db: PoolClient) => ({ executeSql: (text: string, values?: unknown[]) => db.query(text, values as unknown[]) });

export function createFairQueue(pool: Pool, boss: PgBoss, { leaseSeconds = LEASE_SECONDS, sweepSeconds = SWEEP_SECONDS }: FairOptions = {}) {
  const holder = randomUUID();
  const running = new Map<string, Running>();
  const sendOptions = new Map<string, SendOptions>();
  let stopping = false;
  let renewer: ReturnType<typeof setInterval> | undefined;
  let sweeper: ReturnType<typeof setInterval> | undefined;

  /** Puts waiting work on the queue. Each row and its job change in one transaction, so a crash cannot lose one or send it twice. */
  const release = (workspaceId: string) => inWorkspace(pool, workspaceId, async (db) => {
    const { rows } = await db.query<{ queue: string; data: object }>("select queue, data from work_claim($1, $2)", [workspaceId, await limitFor(db, workspaceId)]);
    for (const { queue, data } of rows) await boss.send(queue, data, { ...sendOptions.get(queue), db: asExecutor(db) });
  });

  /** Runs on every worker, so it does not matter which ones are alive. Finds what no finishing job released, such as a crashed worker's place. */
  async function sweep() {
    const { rows } = await pool.query<{ workspace: string }>("select work_sweep($1) as workspace", [holder]);
    for (const { workspace } of rows) await release(workspace);
  }

  async function renew() {
    const keys = [...running.keys()];
    if (!keys.length) return;
    const { rows } = await pool.query<{ key: string }>("select work_renew($1, $2, $3) as key", [holder, keys, leaseSeconds]);
    if (rows.length < keys.length) log("warn", "lease_lost", { lost: keys.length - rows.length });
  }

  const inBackground = (name: string, work: () => Promise<unknown>) => () => {
    work().catch((error: Error) => {
      if (!stopping) log("warn", name, { message: error.message });
    });
  };

  /** Runs `work` once this workspace has a free place, or leaves the job waiting. Either way the queue sees the job as finished unless `work` throws. */
  async function run<T extends { workspaceId: string }>(queue: string, job: Job<T>, key: string, work: () => Promise<unknown>, { handBack, requeue = true }: { handBack?: () => Promise<void>; requeue?: boolean } = {}) {
    const { workspaceId } = job.data;
    // A retried job means the queue gave up on the worker that had it.
    const takeover = ((job as { retryCount?: number }).retryCount ?? 0) > 0;
    const { rows: [lease] } = await inWorkspace(pool, workspaceId, async (db) => db.query<{ granted: boolean; waited_seconds: number }>(
      "select * from work_acquire($1, $2, $3, $4, $5, $6, $7, $8)",
      // While stopping, everything waits for a worker that is staying.
      [workspaceId, queue, key, JSON.stringify(job.data), holder, stopping ? 0 : await limitFor(db, workspaceId), leaseSeconds, takeover],
    ));
    if (!lease!.granted) {
      noted(queue);
      return;
    }
    const createdOn = (job as { createdOn?: Date }).createdOn;
    if (!takeover) queueWait.observe({ queue }, Math.max(lease!.waited_seconds, createdOn ? (Date.now() - createdOn.getTime()) / 1_000 : 0));

    const started = Date.now();
    let finished = () => {};
    const entry: Running = { queue, key, data: job.data, handBack, requeue, done: new Promise((resolve) => { finished = resolve; }) };
    running.set(key, entry);
    try {
      await work();
    } catch (error) {
      jobFailures.inc({ queue });
      reportError(error, { queue });
      throw error;
    } finally {
      running.delete(key);
      finished();
      jobDuration.observe({ queue }, (Date.now() - started) / 1_000);
      await pool.query("select work_release($1, $2)", [key, holder]).catch((error: Error) => log("warn", "lease_release_failed", { message: error.message }));
      if (!stopping) await release(workspaceId).catch((error: Error) => log("warn", "release_failed", { message: error.message }));
    }
  }

  /** Puts anything still running back safely, and gives up its places so another worker can start at once. */
  async function handBackRunning() {
    for (const [key, entry] of running) {
      const { workspaceId } = entry.data as { workspaceId: string };
      await entry.handBack?.().catch((error: Error) => log("error", "hand_back_failed", { message: error.message }));
      // A limit of 0 can only leave it waiting. The queue's own retry can arrive too, and whichever comes second finds the work done.
      if (entry.requeue) await pool.query("select * from work_acquire($1, $2, $3, $4, $5, 0, 0, true)", [workspaceId, entry.queue, key, JSON.stringify(entry.data), holder]);
      else await pool.query("select work_release($1, $2)", [key, holder]);
    }
  }

  return {
    holder,
    run,
    release,
    sweep,
    /** The options a queue's jobs are sent with, so work sent back is treated as it was the first time. */
    register: (queue: string, options: SendOptions) => sendOptions.set(queue, options),
    start() {
      renewer = setInterval(inBackground("lease_renew_failed", renew), (leaseSeconds * 1_000) / 3);
      sweeper = setInterval(inBackground("sweep_failed", sweep), sweepSeconds * 1_000);
      renewer.unref();
      sweeper.unref();
      return sweep();
    },
    /**
     * Stops starting new work, waits up to `graceMs` for what is running, and hands back the rest.
     * The caller stops the queue at the same time, which stops new jobs arriving.
     */
    async drain(graceMs: number) {
      stopping = true;
      const deadline = new Promise<void>((resolve) => { setTimeout(resolve, graceMs).unref(); });
      await Promise.race([Promise.all([...running.values()].map(({ done }) => done)), deadline]);
      const left = running.size;
      if (left) {
        log("warn", "work_handed_back", { count: left });
        await handBackRunning();
      }
      return left;
    },
    /** Timers only. The queue's own stop may close the connections these use. */
    stop() {
      stopping = true;
      clearInterval(renewer);
      clearInterval(sweeper);
    },
    async leave() {
      await pool.query("select worker_left($1)", [holder]);
    },
  };
}

export type FairQueue = ReturnType<typeof createFairQueue>;

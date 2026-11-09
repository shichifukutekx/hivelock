import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import type { LiveHub } from "../live.ts";
import { databaseMetrics, renderMetrics } from "../metrics.ts";
import { migrationsInOrder } from "../migrate.ts";

const CHECK_TIMEOUT_MS = 3_000;
const STATUS_CACHE_MS = 10_000;
/** Work held back this long means the workers are behind, and the status page says so. */
const BUSY_AFTER_SECONDS = 300;

interface Deps {
  pool: Pool;
  boss?: PgBoss;
  live?: LiveHub;
  /** True once this process has been told to stop. */
  stopping?: () => boolean;
}

const withinTime = <T>(work: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("too slow")), CHECK_TIMEOUT_MS); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

const passes = async (check: () => Promise<boolean>) => {
  try {
    return await withinTime(check());
  } catch {
    return false;
  }
};

/** True if every migration this code needs has run. Newer migrations are fine: old code runs on the new schema during an upgrade. */
async function migrationsApplied(pool: Pool) {
  const { rows } = await pool.query<{ name: string }>("select applied_migrations() as name");
  const applied = new Set(rows.map(({ name }) => name));
  return migrationsInOrder().every(({ name, replaces }) => [name, ...replaces].some((one) => applied.has(one)));
}

/**
 * What must be true for this process to be given traffic or work. A standby database accepts reads but no writes, so that counts as not ready.
 * Only the names and results are shown, as this address is public.
 */
export async function readiness({ pool, boss, live, stopping }: Deps) {
  if (stopping?.()) return { ready: false, checks: { stopping: "failing" as const } };
  const named: [string, () => Promise<boolean>][] = [
    ["database", async () => (await pool.query<{ standby: boolean }>("select pg_is_in_recovery() as standby")).rows[0]!.standby === false],
    ["migrations", () => migrationsApplied(pool)],
  ];
  if (boss) named.push(["queue", () => boss.isInstalled()]);
  if (live) named.push(["streaming", async () => live.connected()]);
  const results = await Promise.all(named.map(async ([name, check]) => [name, (await passes(check)) ? "ok" : "failing"] as const));
  return { ready: results.every(([, result]) => result === "ok"), checks: Object.fromEntries(results) };
}

/** Whether a request holds the operator's metrics token. Off unless one is set, so server numbers are never public by accident. */
export function metricsAllowed(token: string | undefined, header: string | undefined) {
  const given = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  return !!token && given.length === Buffer.byteLength(token) && timingSafeEqual(given, Buffer.from(token));
}

export const metricsText = async (pool: Pool, boss?: PgBoss) => renderMetrics(await databaseMetrics(pool, boss));

/** A public summary, kept apart from /ready so that it can be shown to anyone: no counts, no names, nothing about any workspace. */
function createStatus({ pool, boss }: Deps) {
  let cached: { body: object; down: boolean; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached;
    const database = await passes(async () => (await pool.query("select 1")).rowCount === 1);
    const workers = database && await passes(async () => Number((await pool.query<{ alive: string }>("select workers_alive() as alive")).rows[0]!.alive) > 0);
    const queue = database && await passes(async () => {
      const { rows } = await pool.query<{ oldest_seconds: number }>("select oldest_seconds from work_depth()");
      return rows.every(({ oldest_seconds }) => oldest_seconds < BUSY_AFTER_SECONDS) && (!boss || await boss.isInstalled());
    });
    const status = !database ? "down" : workers && queue ? "ok" : "degraded";
    cached = {
      body: { status, components: { web: "ok", database: database ? "ok" : "down", workers: workers ? "ok" : "degraded", queue: queue ? "ok" : "degraded" }, checkedAt: new Date().toISOString() },
      down: !database,
      until: Date.now() + STATUS_CACHE_MS,
    };
    return cached;
  };
}

export function addHealthRoutes(app: Hono<any>, deps: Deps) {
  const status = createStatus(deps);
  // Says only that the process answers. A restart would not fix anything /ready can find.
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/ready", async (c) => {
    const { ready, checks } = await readiness(deps);
    return c.json({ status: ready ? "ready" : "unavailable", checks }, ready ? 200 : 503);
  });
  app.get("/status", async (c) => {
    const { body, down } = await status();
    c.header("cache-control", "public, max-age=10");
    return c.json(body, down ? 503 : 200);
  });
}

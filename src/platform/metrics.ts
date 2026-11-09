import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Pool } from "pg";

/**
 * Numbers for /metrics, in the Prometheus text format. Each process keeps its own, and Prometheus adds them up.
 * A label here must come from a short fixed list: a route pattern, a queue, a status class. Never a workspace, a person or an id,
 * because every new label value is a new series kept forever.
 */
type Labels = Record<string, string>;

const PREFIX = "agent_platform_";
const collected: (() => string[]) [] = [];

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelText = (labels: Labels) => {
  const parts = Object.entries(labels).map(([name, value]) => `${name}="${escape(value)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
};
const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

export function counter(name: string, help: string) {
  const full = `${PREFIX}${name}`;
  const values = new Map<string, { labels: Labels; value: number }>();
  collected.push(() => [`# HELP ${full} ${help}`, `# TYPE ${full} counter`, ...[...values.values()].map(({ labels, value }) => `${full}${labelText(labels)} ${value}`)]);
  return {
    inc(labels: Labels = {}, by = 1) {
      const key = keyOf(labels);
      const entry = values.get(key) ?? { labels, value: 0 };
      entry.value += by;
      values.set(key, entry);
    },
    /** For tests. */
    value: (labels: Labels = {}) => values.get(keyOf(labels))?.value ?? 0,
  };
}

/** A value read when /metrics is asked for. */
export function gauge(name: string, help: string, read: () => { labels?: Labels; value: number }[]) {
  const full = `${PREFIX}${name}`;
  collected.push(() => [`# HELP ${full} ${help}`, `# TYPE ${full} gauge`, ...read().map(({ labels = {}, value }) => `${full}${labelText(labels)} ${value}`)]);
}

export function histogram(name: string, help: string, buckets: number[]) {
  const full = `${PREFIX}${name}`;
  const values = new Map<string, { labels: Labels; counts: number[]; sum: number; total: number }>();
  collected.push(() => {
    const lines = [`# HELP ${full} ${help}`, `# TYPE ${full} histogram`];
    for (const { labels, counts, sum, total } of values.values()) {
      let running = 0;
      buckets.forEach((limit, index) => {
        running += counts[index]!;
        lines.push(`${full}_bucket${labelText({ ...labels, le: String(limit) })} ${running}`);
      });
      lines.push(`${full}_bucket${labelText({ ...labels, le: "+Inf" })} ${total}`, `${full}_sum${labelText(labels)} ${sum}`, `${full}_count${labelText(labels)} ${total}`);
    }
    return lines;
  });
  return {
    observe(labels: Labels, seconds: number) {
      const key = keyOf(labels);
      const entry = values.get(key) ?? { labels, counts: buckets.map(() => 0), sum: 0, total: 0 };
      const index = buckets.findIndex((limit) => seconds <= limit);
      if (index >= 0) entry.counts[index]! += 1;
      entry.sum += seconds;
      entry.total += 1;
      values.set(key, entry);
    },
    count: (labels: Labels) => values.get(keyOf(labels))?.total ?? 0,
  };
}

const LATENCY = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const WAITS = [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600];
const JOBS = [0.1, 1, 5, 15, 60, 300, 900, 1800];

export const httpRequests = counter("http_requests_total", "Requests answered, by method, route pattern and status class.");
export const httpLatency = histogram("http_request_duration_seconds", "Time to answer a request, by method and route pattern.", LATENCY);
export const jobFailures = counter("job_failures_total", "Steps and turns that ended in an error, by queue.");
export const jobDuration = histogram("job_duration_seconds", "Time steps and turns spent running, by queue.", JOBS);
export const queueWait = histogram("queue_wait_seconds", "Time from being queued to starting, including any time deferred, by queue.", WAITS);
export const queueDeferrals = counter("queue_deferrals_total", "Times work was held back because its workspace was at its limit, by queue.");
export const runOutcomes = counter("run_outcomes_total", "Workflow runs that ended, by outcome.");
export const errorsReported = counter("errors_reported_total", "Errors sent to the error tracker, or dropped by its rate limit.");

let inFlight = 0;
gauge("http_requests_in_flight", "Requests being answered now.", () => [{ value: inFlight }]);
export const requestStarted = () => { inFlight += 1; };
export const requestEnded = () => { inFlight -= 1; };

const pools = new Map<string, Pool>();
/** Reports a connection pool's numbers under this name. */
export const watchPool = (name: string, pool: Pool) => pools.set(name, pool);
gauge("db_pool_connections", "Connections in a pool, by pool and state.", () => [...pools].flatMap(([pool, { totalCount, idleCount }]) => [
  { labels: { pool, state: "idle" }, value: idleCount },
  { labels: { pool, state: "busy" }, value: totalCount - idleCount },
]));
gauge("db_pool_waiting", "Queries waiting for a connection, by pool.", () => [...pools].map(([pool, { waitingCount }]) => ({ labels: { pool }, value: waitingCount })));

const started = Date.now() / 1000;
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
gauge("process_start_time_seconds", "When this process started.", () => [{ value: started }]);
gauge("process_resident_memory_bytes", "Memory held by this process.", () => [{ value: process.memoryUsage.rss() }]);
gauge("event_loop_delay_seconds", "How late the event loop has been lately, at the 99th percentile.", () => {
  const value = loopDelay.percentile(99) / 1e9;
  loopDelay.reset();
  return [{ value: Number.isFinite(value) ? value : 0 }];
});

/** Everything this process has counted, as the text /metrics returns. */
export const renderMetrics = (extra: string[] = []) => `${[...collected.flatMap((collect) => collect()), ...extra].join("\n")}\n`;

/** Asked when /metrics is read, because these numbers live in the database and any process can read them. Shared by the web and worker processes. */
export async function databaseMetrics(pool: Pool, boss?: { getQueues(): Promise<{ name: string; queuedCount: number; activeCount: number; deferredCount: number }[]> }) {
  const lines: string[] = [];
  const family = (name: string, kind: string, help: string, values: { labels?: Labels; value: number | string }[]) => {
    lines.push(`# HELP ${PREFIX}${name} ${help}`, `# TYPE ${PREFIX}${name} ${kind}`, ...values.map(({ labels = {}, value }) => `${PREFIX}${name}${labelText(labels)} ${value}`));
  };
  const { rows } = await pool.query<{ name: string; value: string }>("select name, value from platform_metrics()");
  for (const { name, value } of rows) family(name, "gauge", "A server-wide total from the database.", [{ value }]);
  const depth = (await pool.query<{ queue: string; running: string; waiting: string; oldest_seconds: number; workspaces_waiting: string }>("select * from work_depth()")).rows;
  const queues = boss ? await boss.getQueues() : [];
  family("queue_depth", "gauge", "Jobs by queue and state. Deferred means held back by a workspace limit or a later start time, waiting means held back by a workspace limit.", [
    ...queues.flatMap(({ name, queuedCount, activeCount, deferredCount }) => [
      { labels: { queue: name, state: "queued" }, value: queuedCount },
      { labels: { queue: name, state: "active" }, value: activeCount },
      { labels: { queue: name, state: "deferred" }, value: deferredCount },
    ]),
    ...depth.flatMap(({ queue, running, waiting }) => [
      { labels: { queue, state: "leased" }, value: running },
      { labels: { queue, state: "waiting" }, value: waiting },
    ]),
  ]);
  family("queue_oldest_waiting_seconds", "gauge", "Age of the oldest work held back by a workspace limit, by queue.", depth.map(({ queue, oldest_seconds }) => ({ labels: { queue }, value: oldest_seconds })));
  family("queue_workspaces_waiting", "gauge", "How many workspaces have work held back, by queue. A count, so no workspace is named.", depth.map(({ queue, workspaces_waiting }) => ({ labels: { queue }, value: workspaces_waiting })));
  const { rows: [alive] } = await pool.query<{ count: string }>("select workers_alive() as count");
  family("workers_alive", "gauge", "Worker processes seen in the last minute.", [{ value: alive!.count }]);
  return lines;
}

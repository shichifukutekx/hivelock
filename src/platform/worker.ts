// The worker records runs in the database, so it does not also write prompts to the local log file.
process.env.AUDIT_LOG ??= "off";

const { createPool, WORKER_STATEMENT_TIMEOUT_MS } = await import("./db.ts");
const { loadEnv, networkPolicy } = await import("./env.ts");
const { createEngine } = await import("./engine/engine.ts");
const { createBoss, ensureQueues, startWorker } = await import("./engine/queue.ts");
const { createAgentChat } = await import("./agent-chat.ts");
const { flushErrors, reportCrashes, startErrorReporting } = await import("./error-reporting.ts");
const { loadExtensions } = await import("./extensions.ts");
const { createKnowledge } = await import("./knowledge.ts");
const { log } = await import("./log.ts");
const { watchPool } = await import("./metrics.ts");
const { flushSpans } = await import("./observability.ts");
const { startWorkerHttp } = await import("./worker-http.ts");

await loadExtensions();
const env = loadEnv("worker");
startErrorReporting(env.ERROR_REPORTING_DSN, { role: "worker", release: process.env.npm_package_version });
reportCrashes();
const pool = createPool(env.DATABASE_URL, 20, WORKER_STATEMENT_TIMEOUT_MS);
watchPool("worker", pool);
const boss = createBoss(env.DATABASE_URL, "worker");
await boss.start();
await ensureQueues(boss);
const base = { masterKey: env.SECRETS_MASTER_KEY, network: networkPolicy(env) };
const knowledge = createKnowledge(pool, boss, base);
const options = { ...base, search: knowledge.search };
const fair = await startWorker(boss, pool, createEngine(pool, boss, options), env.WORKER_CONCURRENCY, createAgentChat(pool, boss, options), knowledge);
let stopping = false;
const http = env.WORKER_HTTP_PORT ? startWorkerHttp({ pool, boss, port: env.WORKER_HTTP_PORT, host: env.PLATFORM_HOST, metricsToken: env.METRICS_TOKEN, stopping: () => stopping }) : undefined;
log("info", "worker_started", { holder: fair.holder, concurrency: env.WORKER_CONCURRENCY, workLimit: env.WORKSPACE_WORK_LIMIT });

/**
 * Takes no new work and lets running work finish. What is still running at the deadline is handed back: a step goes back in line for
 * another worker, without counting as a failed attempt, and a turn ends with a message, because its tools may already have acted.
 */
async function stop() {
  if (stopping) return;
  stopping = true;
  const graceMs = env.SHUTDOWN_GRACE_SECONDS * 1_000;
  log("info", "worker_stopping");
  // Started first, because this stops new jobs arriving. Its own deadline is after the hand-back, so what it fails is already safe.
  const stopped = boss.stop({ graceful: true, timeout: graceMs + 2_000 });
  const handedBack = await fair.drain(graceMs);
  await stopped;
  fair.stop();
  await fair.leave().catch(() => {});
  await flushSpans();
  await flushErrors();
  http?.close();
  await pool.end();
  log("info", "worker_stopped", { handedBack });
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());

import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { API_STATEMENT_TIMEOUT_MS, createPool } from "./db.ts";
import { createAgentChat } from "./agent-chat.ts";
import { createEngine } from "./engine/engine.ts";
import { createKnowledge } from "./knowledge.ts";
import { createLiveHub } from "./live.ts";
import { createBoss } from "./engine/queue.ts";
import { loadEnv, networkPolicy } from "./env.ts";
import { editionOf } from "./edition.ts";
import { extensions, loadExtensions } from "./extensions.ts";
import { flushErrors, reportCrashes, startErrorReporting } from "./error-reporting.ts";
import { log } from "./log.ts";
import { mailSource } from "./mailer.ts";
import { watchPool } from "./metrics.ts";
import { flushSpans } from "./observability.ts";

await loadExtensions();
const env = loadEnv();
startErrorReporting(env.ERROR_REPORTING_DSN, { role: "web", release: process.env.npm_package_version });
reportCrashes();
const pool = createPool(env.DATABASE_URL, 10, API_STATEMENT_TIMEOUT_MS);
watchPool("web", pool);
const options = { masterKey: env.SECRETS_MASTER_KEY, network: networkPolicy(env) };
const boss = createBoss(env.DATABASE_URL, "api");
await boss.start();
const live = createLiveHub(env.DATABASE_URL);
await live.start();
// Email verification is fixed at start, so turning it on after saving mail in Settings takes a restart.
const mailConfigured = (await mailSource(pool, env)) !== "none";
// Open sign-up rests on proving addresses, so a hosted server without mail must not start.
if (env.HOSTED_MODE && !mailConfigured) throw new Error("Hosted mode cannot start without mail. Set SMTP_URL and MAIL_FROM.");
let stopping = false;
const app = createApp({ pool, stopping: () => stopping, auth: createAuth(pool, env, { mailConfigured }), env, workflows: { engine: createEngine(pool, boss, options), boss, chat: createAgentChat(pool, boss, options), knowledge: createKnowledge(pool, boss, options), live } });

if (!env.HOSTED_MODE) {
  const { id, notice } = await editionOf(pool);
  log(notice ? "warn" : "info", "edition", { edition: id, notice });
}

const server = serve({ fetch: app.fetch, port: env.PLATFORM_PORT, hostname: env.PLATFORM_HOST }, ({ port }) => {
  log("info", "platform_started", { port });
});

/**
 * Fails /ready first so the proxy moves traffic away, keeps answering while it does, then ends streams so browsers reconnect elsewhere.
 * Requests in progress finish. Anything still open when the grace period ends is cut, because an orchestrator would kill it soon anyway.
 */
async function stop() {
  if (stopping) return;
  stopping = true;
  log("info", "platform_stopping");
  await new Promise((resolve) => setTimeout(resolve, env.SHUTDOWN_DRAIN_SECONDS * 1_000));
  live.closeStreams();
  const closed = new Promise((resolve) => { server.close(resolve); });
  (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, env.SHUTDOWN_GRACE_SECONDS * 1_000))]);
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await boss.stop({ graceful: false });
  await live.stop();
  await flushSpans();
  await flushErrors();
  for (const { close } of extensions()) await close?.();
  await pool.end();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());

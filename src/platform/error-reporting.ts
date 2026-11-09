import { randomUUID } from "node:crypto";
import { errorsReported } from "./metrics.ts";
import { log } from "./log.ts";
import { scrub } from "./scrub.ts";

/** Speaks the event format every Sentry-compatible service accepts, over plain HTTP, so it needs no package. */

interface Target { envelopeUrl: string; publicKey: string }
interface Details { requestId?: string; route?: string; queue?: string; level?: "error" | "fatal" }

const MAX_PER_MINUTE = 30;
const REPEAT_WINDOW_MS = 60_000;
const MAX_MESSAGE = 2_000;
const MAX_FRAMES = 40;

/** The form is https://key@host/project, and a project may sit under a path. Returns nothing for anything else. */
export function parseDsn(dsn: string): Target | undefined {
  try {
    const url = new URL(dsn);
    const project = url.pathname.split("/").filter(Boolean).pop();
    if (!url.username || !project || !["http:", "https:"].includes(url.protocol)) return undefined;
    const path = url.pathname.slice(0, url.pathname.lastIndexOf(`/${project}`));
    return { envelopeUrl: `${url.protocol}//${url.host}${path}/api/${project}/envelope/`, publicKey: url.username };
  } catch {
    return undefined;
  }
}

/** Paths are cut back to the project, because the rest says nothing useful and can name the operator. */
function frames(stack: string | undefined) {
  const here = process.cwd();
  return (stack ?? "").split("\n").slice(1, MAX_FRAMES + 1).flatMap((line) => {
    const found = /at (?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!found) return [];
    const [, name, file, lineno, colno] = found;
    return [{ function: scrub(name ?? "?"), filename: scrub(file!.replace(here, "").replace(/^.*\/node_modules\//, "node_modules/")), lineno: Number(lineno), colno: Number(colno), in_app: !file!.includes("node_modules") }];
  }).reverse();
}

let target: Target | undefined;
let role = "server";
let release: string | undefined;
let sent: number[] = [];
const lastSeen = new Map<string, number>();
const sending = new Set<Promise<unknown>>();

/** Off until a DSN is given. A DSN that cannot be read is said once, and the server carries on. */
export function startErrorReporting(dsn: string | undefined, options: { role: string; release?: string }) {
  target = dsn ? parseDsn(dsn) : undefined;
  role = options.role;
  release = options.release;
  if (dsn && !target) log("warn", "error_reporting_off", { message: "ERROR_REPORTING_DSN could not be read, so errors are not being sent." });
}

const allowed = (fingerprint: string) => {
  const now = Date.now();
  sent = sent.filter((at) => at > now - 60_000);
  if ((lastSeen.get(fingerprint) ?? 0) > now - REPEAT_WINDOW_MS || sent.length >= MAX_PER_MINUTE) return false;
  if (lastSeen.size > 500) lastSeen.clear();
  lastSeen.set(fingerprint, now);
  sent.push(now);
  return true;
};

/** Never throws and never waits for the tracker. The message and stack are scrubbed, and nothing from a request's body or headers is included. */
export function reportError(error: unknown, { requestId, route, queue, level = "error" }: Details = {}) {
  if (!target) return;
  const { envelopeUrl, publicKey } = target;
  const name = error instanceof Error ? error.name : "Error";
  const message = scrub((error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE));
  const stack = error instanceof Error ? error.stack : undefined;
  const fingerprint = `${name}:${message.slice(0, 200)}:${(stack ?? "").split("\n")[1] ?? ""}`;
  if (!allowed(fingerprint)) {
    errorsReported.inc({ result: "dropped" });
    return;
  }
  const eventId = randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const event = {
    event_id: eventId, timestamp: now, platform: "node", level, release, environment: process.env.NODE_ENV ?? "development",
    tags: { role, ...(route ? { route } : {}), ...(queue ? { queue } : {}) },
    ...(requestId ? { extra: { requestId } } : {}),
    exception: { values: [{ type: name, value: message, stacktrace: { frames: frames(stack) } }] },
  };
  const body = [JSON.stringify({ event_id: eventId, sent_at: now }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
  const request = fetch(envelopeUrl, {
    method: "POST", body,
    headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_client=hivelock/1.0, sentry_key=${publicKey}` },
    signal: AbortSignal.timeout(3_000),
  }).then((response) => {
    errorsReported.inc({ result: response.ok ? "sent" : "refused" });
  }, (failure: Error) => {
    errorsReported.inc({ result: "failed" });
    log("warn", "error_report_failed", { message: failure.message });
  }).finally(() => sending.delete(request));
  sending.add(request);
}

/** Gives reports on their way a moment to arrive before the process ends. */
export const flushErrors = async () => {
  await Promise.all(sending);
};

/** A process that hits these is in an unknown state, so it reports and stops, and its supervisor starts a new one. */
export function reportCrashes() {
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.on(event, (error: unknown) => {
      log("error", "process_crashed", { message: error instanceof Error ? error.message : String(error) });
      reportError(error, { level: "fatal" });
      void flushErrors().finally(() => process.exit(1));
    });
  }
}

import dotenv from "dotenv";
import { z } from "zod";
import { HOSTED_MODE_VALUES } from "../config.ts";
import { hostedPolicy, type Program } from "./extensions.ts";
import { setPreviousMasterKey } from "./secrets.ts";

dotenv.config({ quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  /** Only migrations and key rotation use this. The running app must not have it. */
  DATABASE_ADMIN_URL: z.string().optional().transform((value) => value || undefined),
  BETTER_AUTH_SECRET: z.string().min(32),
  SECRETS_MASTER_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes in base64"),
  /** The old key, only while rotating. See docs/key-rotation.md. */
  SECRETS_MASTER_KEY_PREVIOUS: z.string().optional().transform((value) => value || undefined)
    .refine((value) => value === undefined || Buffer.from(value, "base64").length === 32, "must be 32 bytes in base64"),
  PUBLIC_URL: z.url(),
  /** Only this address can create the first account. Everyone after that needs an invitation. */
  BOOTSTRAP_ADMIN_EMAIL: z.email(),
  /** Internal hosts connectors may reach, comma-separated. Everything private is blocked otherwise. */
  ALLOWED_PRIVATE_HOSTS: z.string().default(""),
  /** The platform's own mail, used when none is saved in Settings. */
  SMTP_URL: z.string().optional().transform((value) => value || undefined),
  MAIL_FROM: z.string().optional().transform((value) => value || undefined),
  /** Turns on /metrics for a monitoring system. Leave empty to keep it off. */
  METRICS_TOKEN: z.string().optional().transform((value) => value || undefined),
  /** A Sentry-compatible address. Errors are sent there, scrubbed. Leave empty to keep it off. */
  ERROR_REPORTING_DSN: z.string().optional().transform((value) => value || undefined),
  /** How many steps and agent turns one workspace may run at once, across all workers. Hosted plans set their own. */
  WORKSPACE_WORK_LIMIT: z.coerce.number().int().min(1).default(4),
  /** How many steps, and separately how many agent turns, one worker process runs at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  /** Gives a worker /health, /ready and /metrics on this port. Leave empty to keep it off. */
  WORKER_HTTP_PORT: z.coerce.number().int().optional().catch(undefined),
  /** How long a stopping process lets running work finish. The orchestrator must wait longer than this. */
  SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(1).default(25),
  /** How long a stopping server keeps answering after /ready fails, so its proxy can stop sending it requests. */
  SHUTDOWN_DRAIN_SECONDS: z.coerce.number().int().min(0).default(0),
  PLATFORM_PORT: z.coerce.number().int().default(4320),
  PLATFORM_HOST: z.string().default("127.0.0.1"),
  /** Turns on the multi-tenant cloud version. It needs the paid package, and the server refuses to start without it. */
  HOSTED_MODE: z.enum(HOSTED_MODE_VALUES).optional().transform((value) => value === "true"),
});

export type PlatformEnv = z.infer<typeof schema>;

export function adminUrl(env: PlatformEnv) {
  if (!env.DATABASE_ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required for this command.");
  return env.DATABASE_ADMIN_URL;
}

export const networkPolicy = (env: PlatformEnv) => ({
  allowedPrivateHosts: env.ALLOWED_PRIVATE_HOSTS.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
});

/** Reads settings once and refuses to start if any is missing or unsafe. Errors name the setting, never its value. */
export function loadEnv(program: Program = "web"): PlatformEnv {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Platform settings are invalid. ${problems.join("; ")}`);
  }
  const env = parsed.data;
  if (env.HOSTED_MODE) {
    const problems = hostedPolicy().problems(process.env, program);
    if (problems.length) throw new Error(`Hosted mode cannot start. ${problems.join(" ")}`);
    // One file would mix every customer's prompts.
    process.env.AUDIT_LOG = "off";
  }
  if (env.NODE_ENV === "production" && !env.PUBLIC_URL.startsWith("https://")) {
    throw new Error("PUBLIC_URL must use https in production.");
  }
  // Mail can be set up in Settings, which needs a running server, so this cannot stop it starting.
  if (env.NODE_ENV === "production" && (!env.SMTP_URL || !env.MAIL_FROM)) {
    console.warn(JSON.stringify({ level: "warn", event: "mail_not_in_environment", message: "SMTP_URL and MAIL_FROM are not set. Unless mail is saved in Settings, email verification stays off and no invitation or reset mail is sent." }));
  }
  setPreviousMasterKey(env.SECRETS_MASTER_KEY_PREVIOUS);
  return env;
}

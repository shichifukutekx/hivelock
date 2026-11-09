/**
 * The one way to add to this server from outside it. Hivelock runs alone as the Community edition, and a package at ee/ can add to it through
 * what is below. Nothing else in the core knows that package exists. See docs/extensions.md.
 */
import { existsSync } from "node:fs";
import type { Context, Hono } from "hono";
import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import type { z } from "zod";
import type { AgentChat } from "./agent-chat.ts";
import type { Auth, Person } from "./auth.ts";
import type { EncryptedColumn } from "./rotate-keys.ts";
import type { Engine } from "./engine/engine.ts";
import type { PlatformEnv } from "./env.ts";
import type { Knowledge } from "./knowledge.ts";
import type { LiveHub } from "./live.ts";
import type { NetworkPolicy } from "./net/safe-fetch.ts";
import type { Permission } from "./permissions.ts";
import type { Edition, PaidFeature } from "./plans.ts";

/** Everything a route needs from the app it joins. */
export interface RouteContext {
  app: Hono<any>;
  pool: Pool;
  env: PlatformEnv;
  auth: Auth;
  network: NetworkPolicy;
  /** Present once the job queue is running. */
  workflows?: { engine: Engine; boss: PgBoss; chat?: AgentChat; knowledge?: Knowledge; live?: LiveHub };
  requirePermission: (permission: Permission, options?: GateOptions) => any;
  stillAllowed: (request: Request, workspaceId: string, permission: Permission) => Promise<boolean>;
  /** Whatever a caller of createApp passed for this extension. Tests replace outside services through it. */
  options: Record<string, unknown>;
}

/** A route that must stay open when a gate would otherwise refuse. */
export interface GateOptions {
  breakGlassRoute?: boolean;
  /** Stays open while a workspace is suspended. */
  suspendedRoute?: boolean;
  /** Stays open while a workspace is read-only. For what stops work, never for what starts it. */
  readOnlyRoute?: boolean;
}

/** Runs after sign-in on every workspace request, before the role is checked. */
export interface WorkspaceGate {
  /** Throws HTTPException to refuse. Applies to every role. */
  check(person: Person, workspaceId: string, options: GateOptions): Promise<void>;
  /** For the list of workspaces in /me. Undefined hides the workspace. Anything else is added to its entry. */
  listing?(person: Person, workspaceId: string): Promise<Record<string, unknown> | undefined>;
}

/** What an extension adds to sign-in. Every member is optional. */
export interface AuthExtension {
  /** better-auth plugins. */
  plugins?(pool: Pool, env: PlatformEnv): unknown[];
  /** Library paths no request may reach. */
  closedPaths?: string[];
  /** Asked on each request, so an origin can be trusted only while one request runs. */
  trustedOrigins?(): string[];
  sessionFields?: Record<string, { type: "string"; required: false; input: false }>;
  rateLimits?: Record<string, { window: number; max: number }>;
  /** Fields to store on a session being created. */
  sessionCreating?(session: Record<string, unknown>): Record<string, unknown>;
  sessionCreated?(pool: Pool, session: { userId: string; ipAddress?: string | null }): Promise<void>;
  workspaceCreated?(pool: Pool, env: PlatformEnv, workspaceId: string): Promise<void>;
  /** May answer a request under /api/auth itself. Runs first, before any other check. */
  request?(c: Context, context: { pool: Pool; env: PlatformEnv; auth: Auth }): Promise<Response | undefined>;
  /** Looks at a session on every request. Returning false ends it. May set the person's scope. */
  session?(found: { session?: any; user?: any }, person: Person, pool: Pool): Promise<boolean>;
}

/** A kind of workflow trigger beyond schedules and webhooks. */
export interface TriggerKind {
  kind: string;
  /** The pg-boss queue its timers use, so deleting one can stop them. */
  queue: string;
  /** Needed on top of the feature check. */
  feature: PaidFeature;
  /** The right needed to add or remove one, on top of workflows:write, and what to say otherwise. */
  manage?: { permission: Permission; refused: string };
  schema: z.ZodType<any>;
  /** Inside the same transaction as the audit entry. Writes the trigger row and whatever else it needs. */
  create(db: PoolClient, input: { id: string; workspaceId: string; workflowId: string; actorId: string; body: any; env: PlatformEnv; boss: PgBoss }): Promise<void>;
  /** Fields to add to each trigger in a workflow's list, by trigger id. */
  details?(db: PoolClient, workflowId: string): Promise<Map<string, Record<string, unknown>>>;
  /** A workflow was turned back on. */
  workflowEnabled?(db: PoolClient, workflowId: string): Promise<void>;
}

export interface WorkerContext {
  boss: PgBoss;
  pool: Pool;
  engine: Engine;
  concurrency: number;
  chat?: AgentChat;
  knowledge?: Knowledge;
}

export interface HostedPlan { name: string; agents: number | null; runsPerMonth: number; storageBytes: number }

/** Which program is reading its settings, because a worker runs customers' agents and must hold less than the web server. */
export type Program = "web" | "worker";

/** The multi-tenant rules. Without this the server refuses HOSTED_MODE=true, because customers would share it unprotected. */
export interface HostedPolicy {
  /** Names settings only, never values. Any entry stops the server starting. */
  problems(settings: Record<string, string | undefined>, program?: Program): string[];
  maxOwnedWorkspaces: number;
  /** Stops new work in a read-only workspace, and otherwise says which plan it is on. */
  assertActive(db: PoolClient, workspaceId: string): Promise<HostedPlan>;
  /** Asked before each step, because work queued before a suspension passed every check when it was sent. */
  isSuspended(db: PoolClient, workspaceId: string): Promise<boolean>;
  consumeRuns(db: PoolClient, workspaceId: string, plan: HostedPlan, count: number): Promise<void>;
  hasFeature(pool: Pool, workspaceId: string, feature: PaidFeature): Promise<boolean>;
  /** What to say when a plan leaves a feature out. */
  featureRefusal(feature: PaidFeature): string;
  /** How many steps and agent turns a workspace may run at once. Undefined uses the server's default. */
  workLimit?(db: PoolClient, workspaceId: string): Promise<number | undefined>;
}

/** Where an agent stands after its latest change, for the agent page and the Agents list. */
export interface AgentGateState {
  /** clear: tests passed. untested: no run since the change. testing: a run is going. failed: the latest run failed. overridden: someone chose to use it anyway. */
  state: "clear" | "untested" | "testing" | "failed" | "overridden";
  /** Says it in plain words. */
  message: string;
  changedAt: string;
  failedTests?: string[];
  overriddenBy?: string | null;
  overriddenAt?: string | null;
}

/**
 * A release gate: a changed agent with saved tests is tested before live workflows use it.
 * The core asks it at the three points below. Without a package that adds one, nothing is ever held back.
 */
export interface AgentGate {
  /** After an agent's change is saved. Starts its tests, if it has any. Never refuses the change itself. */
  changed(context: { pool: Pool; boss: PgBoss }, workspaceId: string, agentName: string, actorId: string): Promise<AgentGateState | undefined>;
  /** Why a workflow step may not use this agent now. Undefined lets it run. */
  held(context: { pool: Pool; masterKey: string }, workspaceId: string, agentName: string): Promise<string | undefined>;
  /** Each agent's state, by name. An agent missing from the map has nothing to show. */
  states(context: { pool: Pool; masterKey: string }, workspaceId: string): Promise<Map<string, AgentGateState>>;
}

/** A login of a package's own, for functions the app role must never reach. migrate.ts makes it, and it can do nothing but call them. */
export interface DatabaseRole {
  /** Where this role connects, from the settings. Undefined makes no role, and the app role still loses the functions. */
  address(settings: Record<string, string | undefined>): string | undefined;
  functions: string[];
}

/**
 * One package's additions. Every member is optional.
 * Connectors need no entry here: a module that calls registerConnector (from connectors/types.ts) when imported has added itself.
 */
export interface Extension {
  name: string;
  /** A folder of .sql files. They run after the core's, in name order. See migrate.ts for `-- replaces:`. */
  migrations?: string;
  /** Names of database functions the app role may call. */
  databaseFunctions?: string[];
  databaseRoles?: DatabaseRole[];
  /** Runs as the admin role at the end of every migration, for what only the settings know and the app role must not be able to change. */
  prepareDatabase?(admin: Pool, env: PlatformEnv): Promise<void>;
  /** Encrypted columns in this package's tables, so key rotation covers them. */
  encryptedColumns?: EncryptedColumn[];
  /** pg-boss queues to create. */
  queues?: string[];
  /** Starts this package's job handlers in the worker. */
  worker?(context: WorkerContext): Promise<void>;
  /** The name people on this server know the product by, for mail. */
  productName?(pool: Pool): Promise<string | undefined>;
  /** Added to the app before the core's workflow routes, so a specific path wins over a general one. */
  routes?(context: RouteContext): void;
  /** Paths the web app must not answer, because only POST exists there. */
  reservedPaths?: RegExp[];
  /** Fields to add to what /api/v1/me says about this person. */
  meFields?(context: { pool: Pool; env: PlatformEnv }, person: Person): Promise<Record<string, unknown>>;
  gates?: (pool: Pool) => WorkspaceGate[];
  auth?: AuthExtension;
  /** Says which edition this server is. Without it, it is Community. */
  edition?: { current(db: Pool | PoolClient): Promise<Edition>; upgrade: string };
  triggerKinds?: TriggerKind[];
  /** Sends text to the person on the far end of a conversation that came from outside the app. */
  notifyContact?(context: { pool: Pool; masterKey: string; network: NetworkPolicy }, workspaceId: string, sessionId: string, text: string): Promise<void>;
  /** Nightly. Runs once for each workspace, inside its transaction. */
  maintainWorkspace?(db: PoolClient, workspaceId: string): Promise<void>;
  /** Nightly, after every workspace. */
  maintainServer?(pool: Pool): Promise<void>;
  /** Frees what this package opened. Runs as the server stops. */
  close?(): Promise<void>;
  hosted?: HostedPolicy;
  agentGate?: AgentGate;
}

const registered: Extension[] = [];

export const extensions = (): readonly Extension[] => registered;

/** Never stops a mail: if the name cannot be read, the standard one is used. */
export async function productName(pool: Pool) {
  for (const { productName: named } of registered) {
    const name = await named?.(pool).catch(() => undefined);
    if (name) return name;
  }
  return "Hivelock";
}

export function registerExtension(extension: Extension) {
  if (registered.some(({ name }) => name === extension.name)) throw new Error(`Extension ${extension.name} is already registered.`);
  registered.push(extension);
}

/** For tests that need to see the core alone. */
export const withoutExtensionsForTests = async <T>(work: () => Promise<T> | T) => {
  const saved = registered.splice(0);
  try {
    return await work();
  } finally {
    registered.splice(0, registered.length, ...saved);
  }
};

let loading: Promise<void> | undefined;

/**
 * Finds the optional package. The path is built at run time, so the core builds and type-checks with the folder deleted.
 * Every program calls this before reading settings. Forgetting to can only make a hosted server refuse to start.
 */
export function loadExtensions() {
  loading ??= (async () => {
    const entry = new URL("../../ee/index.ts", import.meta.url);
    if (!existsSync(entry)) return;
    const { default: extension } = await import(entry.href) as { default: Extension };
    registerExtension(extension);
  })();
  return loading;
}

/** The hosted rules. There is no way to get past this with hosted mode on and no package to enforce them. */
export function hostedPolicy() {
  const policy = registered.find(({ hosted }) => hosted)?.hosted;
  if (!policy) throw new Error("Hosted mode needs the paid package, which holds the rules that keep customers apart. It is not installed, so this server will not run as hosted.");
  return policy;
}

/** Same as the hosted rules, for the things that may be missing. */
export const triggerKinds = () => registered.flatMap((extension) => extension.triggerKinds ?? []);
export const triggerKind = (kind: unknown) => triggerKinds().find((item) => item.kind === kind);
/** Undefined when no package adds a release gate, so every agent change goes live at once. */
export const agentGate = () => registered.find(({ agentGate: gate }) => gate)?.agentGate;

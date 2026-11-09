import type { PgBoss } from "pg-boss";
import type { Pool, PoolClient } from "pg";
import { workspaceDirectory } from "../agents-store.ts";
import { recordAudit } from "../audit-log.ts";
import { inWorkspace } from "../db.ts";
import { seal, sealText, unseal } from "../secrets.ts";
import { guardEvents } from "../guardrails.ts";
import { runOutcomes } from "../metrics.ts";
import { sendAlert, spanRecorder } from "../observability.ts";
import { assertWithinBudget, recordTokens } from "../usage.ts";
import { assertNotPaused, consumeRuns, isPaused, isSuspended, PAUSE_CHECK_SECONDS, PlanLimit, WorkspacePaused } from "../limits.ts";
import { admit, stepKey } from "./fair-queue.ts";
import { incoming, inOrder, outgoing, parseDefinition, type WorkflowDefinition } from "./definition.ts";
import { getNodeType } from "./nodes.ts";
import "../connectors/index.ts";
import { PermanentError } from "../connectors/types.ts";
import type { NetworkPolicy } from "../net/safe-fetch.ts";
import { ACTIVE_RUN, movesInto, RUN_MOVES, STEP_MOVES } from "./states.ts";

export const STEP_QUEUE = "workflow-step";
export const TRIGGER_QUEUE = "workflow-trigger";
export const MAINTENANCE_QUEUE = "platform-maintenance";
export const MAX_ATTEMPTS = 3;
export const MAX_ACTIVE_RUNS = 50;
/** Sits above the agent's own step and model time limits. */
const STEP_TIME_LIMIT_SECONDS = 30 * 60;

export interface StepJob {
  workspaceId: string;
  runId: string;
  nodeId: string;
}

interface Step {
  node_id: string;
  status: string;
  branch: string | null;
  output: unknown;
  attempt: number;
}

export class TooManyRuns extends Error {}

const stepJobOptions = (retryDelay: number, heartbeatSeconds: number) => ({
  retryLimit: MAX_ATTEMPTS,
  retryDelay,
  // A worker that stops reporting in is treated as dead, and another one takes over its step.
  heartbeatSeconds,
  retryBackoff: true,
  expireInSeconds: STEP_TIME_LIMIT_SECONDS,
});

/** Connects each piece of run state to the job that continues it, in one transaction, so a crash cannot lose a step. */
const jobOptions = (client: PoolClient, retryDelay: number, heartbeatSeconds: number) => ({
  ...stepJobOptions(retryDelay, heartbeatSeconds),
  db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values as unknown[]) },
});

interface EngineOptions {
  masterKey: string;
  network: NetworkPolicy;
  retryDelay?: number;
  heartbeatSeconds?: number;
  search?: (workspaceId: string, query: string) => Promise<import("../knowledge.ts").Passage[]>;
}

export function createEngine(pool: Pool, boss: PgBoss, { masterKey, network, retryDelay = 5, heartbeatSeconds = 60, search }: EngineOptions) {
  const enqueue = async (client: PoolClient, job: StepJob) => {
    if (await admit(client, STEP_QUEUE, job.workspaceId, stepKey(job), job)) await boss.send(STEP_QUEUE, { ...job }, jobOptions(client, retryDelay, heartbeatSeconds));
  };

  /** Decides what happens next. Holds a lock on the run, so two steps finishing together cannot both act. */
  async function advance(client: PoolClient, workspaceId: string, runId: string) {
    const { rows: [run] } = await client.query("select status, definition from runs where id = $1 for update", [runId]);
    if (!run || !ACTIVE_RUN.includes(run.status)) return;
    const definition = run.definition as WorkflowDefinition;
    const { rows } = await client.query<Step>("select node_id, status, branch, output, attempt from run_steps where run_id = $1", [runId]);
    const steps = new Map(rows.map((s) => [s.node_id, s]));

    const failed = rows.find((s) => s.status === "failed");
    if (failed) {
      await client.query("update run_steps set status = 'skipped', finished_at = now() where run_id = $1 and status in ('pending', 'waiting')", [runId]);
      await client.query("update runs set status = 'failed', error = $2, finished_at = now() where id = $1", [runId, `Step ${failed.node_id} failed.`]);
      runOutcomes.inc({ outcome: "failed" });
      return;
    }

    for (const node of inOrder(definition)) {
      if (steps.has(node.id) || incoming(definition, node.id).length === 0) continue;
      const sources = incoming(definition, node.id).map((edge) => ({ edge, source: steps.get(edge.from) }));
      if (sources.some(({ source }) => !source || !["done", "skipped"].includes(source.status))) continue;
      const active = sources.some(({ edge, source }) => {
        if (source!.status !== "done") return false;
        if (edge.when !== undefined) return edge.when === source!.branch;
        return source!.branch !== "declined";
      });
      const status = active ? "pending" : "skipped";
      await client.query(
        `insert into run_steps (workspace_id, run_id, node_id, node_type, status) values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [workspaceId, runId, node.id, node.type, status],
      );
      steps.set(node.id, { node_id: node.id, status, branch: null, output: null, attempt: 0 });
      if (active) await enqueue(client, { workspaceId, runId, nodeId: node.id });
    }

    const all = [...steps.values()];
    if (all.some((s) => s.status === "pending" || s.status === "running")) {
      await client.query("update runs set status = 'running' where id = $1", [runId]);
    } else if (all.some((s) => s.status === "waiting")) {
      await client.query("update runs set status = 'waiting' where id = $1", [runId]);
    } else {
      const results = definition.nodes.filter((n) => outgoing(definition, n.id).length === 0 && steps.get(n.id)?.status === "done");
      const output = Object.fromEntries(results.map((n) => [n.id, steps.get(n.id)!.output]));
      await client.query("update runs set status = 'succeeded', output = $2, finished_at = now() where id = $1", [runId, JSON.stringify(output)]);
      runOutcomes.inc({ outcome: "succeeded" });
    }
  }

  async function startRun(options: {
    workspaceId: string; workflowId: string; input: unknown; triggerKind: "manual" | "schedule" | "webhook" | "email";
    triggerId?: string; actorId?: string; requireEnabled?: boolean; maxActive?: number;
    /** Runs in the run's own transaction, so a retry cannot start the same work twice. False starts nothing. */
    claim?: (client: PoolClient) => Promise<boolean>;
    /** The new run's id, for a claim that has to name it. */
    runId?: string;
    /** Keeps a retried run confidential even if the workspace has since turned the setting off. */
    keepConfidential?: boolean;
  }): Promise<string | undefined> {
    const { workspaceId, workflowId, input, triggerKind, triggerId, actorId, requireEnabled = true, maxActive = MAX_ACTIVE_RUNS, claim, runId, keepConfidential = false } = options;
    const attempt = inWorkspace(pool, workspaceId, async (client) => {
      const { rows: [workflow] } = await client.query("select name, version, definition, enabled from workflows where id = $1", [workflowId]);
      if (!workflow || (requireEnabled && !workflow.enabled)) return undefined;
      // Serializes starts in a workspace, so the limit below cannot be raced past.
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`runs:${workspaceId}`]);
      const { rows: [{ active }] } = await client.query("select count(*)::int as active from runs where status in ('running', 'waiting')");
      if (active >= maxActive) throw new TooManyRuns("This workspace has too many runs in progress. Wait for some to finish, or cancel them on the Runs page.");
      await assertNotPaused(client, workspaceId);
      if (claim && !(await claim(client))) return undefined;
      await consumeRuns(client, workspaceId);

      const { rows: [settings] } = await client.query("select confidential_mode from workspace_settings where workspace_id = $1", [workspaceId]);
      const confidential = keepConfidential || (settings?.confidential_mode ?? true);
      const definition = parseDefinition(workflow.definition);
      const { rows: [run] } = await client.query(
        `insert into runs (id, workspace_id, workflow_id, workflow_name, workflow_version, definition, trigger_kind, trigger_id, input, confidential, created_by)
         values (coalesce($11::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [workspaceId, workflowId, workflow.name, workflow.version, JSON.stringify(definition), triggerKind, triggerId ?? null, JSON.stringify(seal(masterKey, workspaceId, input ?? {})), confidential, actorId ?? null, runId ?? null],
      );
      const start = definition.nodes.find((n) => n.type === "start")!;
      await client.query(
        "insert into run_steps (workspace_id, run_id, node_id, node_type) values ($1, $2, $3, 'start')",
        [workspaceId, run.id, start.id],
      );
      await enqueue(client, { workspaceId, runId: run.id, nodeId: start.id });
      await recordAudit(client, { workspaceId, actorId, action: "run.started", targetType: "run", targetId: run.id, details: { workflowId, trigger: triggerKind } });
      return run.id as string;
    });
    // Nobody is watching a schedule or a webhook, so a refused one leaves a failed run to find. A person sees the refusal, and mail waits in the mailbox.
    // A pause is not a failure: someone chose it, and it would only fill the run list and set off an alert. The caller of a webhook gets the refusal and can send it again.
    if (triggerKind !== "schedule" && triggerKind !== "webhook") return attempt;
    return attempt.catch(async (error) => {
      if (error instanceof PlanLimit && !(error instanceof WorkspacePaused)) await recordRefusedRun(workspaceId, workflowId, triggerKind, triggerId, error.message);
      throw error;
    });
  }

  async function recordRefusedRun(workspaceId: string, workflowId: string, triggerKind: string, triggerId: string | undefined, reason: string) {
    const id = await inWorkspace(pool, workspaceId, async (client) => {
      const { rows: [run] } = await client.query(
        `insert into runs (workspace_id, workflow_id, workflow_name, workflow_version, definition, trigger_kind, trigger_id, input, confidential, status, error, finished_at)
         select workspace_id, id, name, version, definition, $2, $3, $4, true, 'failed', $5, now() from workflows where id = $1 returning id`,
        [workflowId, triggerKind, triggerId ?? null, JSON.stringify(seal(masterKey, workspaceId, {})), reason],
      );
      if (run) await recordAudit(client, { workspaceId, action: "run.refused", targetType: "run", targetId: run.id, details: { workflowId, trigger: triggerKind, reason } });
      return run?.id as string | undefined;
    });
    if (id) await sendAlert({ type: "run_failed", workspaceId, id, name: "plan_limit" });
  }

  /** Runs one step. Throwing asks the queue to retry, and the attempt count stops that going on forever. */
  async function executeStep({ workspaceId, runId, nodeId }: StepJob) {
    const claim = await inWorkspace(pool, workspaceId, async (client) => {
      const { rows: [run] } = await client.query("select status, definition, input, confidential, created_by from runs where id = $1", [runId]);
      if (!run) return undefined;
      if (!ACTIVE_RUN.includes(run.status)) {
        // The run was stopped while this step was queued or working. Without this it would show as running for ever.
        await client.query(
          "update run_steps set status = 'skipped', finished_at = now() where run_id = $1 and node_id = $2 and status = any($3)",
          [runId, nodeId, movesInto(STEP_MOVES, "skipped").filter((from) => from !== "waiting")],
        );
        return undefined;
      }
      const { rows: [step] } = await client.query<Step>("select * from run_steps where run_id = $1 and node_id = $2 for update", [runId, nodeId]);
      if (!step || !["pending", "running"].includes(step.status)) return undefined;
      // A suspension cancels what it can see, but a run committed just after it is missed, and would otherwise go on to the end.
      if (await isSuspended(client, workspaceId)) {
        await client.query("update run_steps set status = 'skipped', finished_at = now() where run_id = $1 and node_id = $2 and status = any($3)", [runId, nodeId, movesInto(STEP_MOVES, "skipped")]);
        if (await stop(client, runId, "The workspace was suspended.")) {
          await recordAudit(client, { workspaceId, action: "run.cancelled", targetType: "run", targetId: runId, details: { reason: "suspended" } });
        }
        return undefined;
      }
      // Held, not failed. The job comes back until Resume, so a crash loses nothing and Resume has nothing to restart.
      if (await isPaused(client, workspaceId)) {
        await boss.send(STEP_QUEUE, { workspaceId, runId, nodeId }, { ...jobOptions(client, retryDelay, heartbeatSeconds), startAfter: PAUSE_CHECK_SECONDS });
        return undefined;
      }
      if (step.attempt >= MAX_ATTEMPTS) {
        // The worker stopped on the last attempt, so nothing else would ever finish this step.
        await client.query(
          "update run_steps set status = 'failed', error = 'The step did not finish.', finished_at = now() where run_id = $1 and node_id = $2 and status = any($3)",
          [runId, nodeId, movesInto(STEP_MOVES, "failed")],
        );
        await advance(client, workspaceId, runId);
        return undefined;
      }
      await client.query(
        "update run_steps set status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, now()) where run_id = $1 and node_id = $2 and status = any($3)",
        [runId, nodeId, movesInto(STEP_MOVES, "running")],
      );
      const { rows: done } = await client.query("select node_id, output from run_steps where run_id = $1 and status = 'done'", [runId]);
      const { rows: [settings] } = await client.query("select redact_personal_data from workspace_settings where workspace_id = $1", [workspaceId]);
      return {
        run,
        personal: settings?.redact_personal_data as boolean | undefined,
        attempt: step.attempt + 1,
        input: unseal(masterKey, workspaceId, run.input),
        steps: Object.fromEntries(done.map((s) => [s.node_id, { output: unseal(masterKey, workspaceId, s.output) }])),
      };
    });
    if (!claim) return;

    const definition = claim.run.definition as WorkflowDefinition;
    const node = definition.nodes.find((n) => n.id === nodeId)!;
    const type = getNodeType(node.type)!;

    // Events are written in order, and a failed write never stops the work.
    let writes = Promise.resolve();
    const spans = spanRecorder(pool, workspaceId, runId, "run");
    const onEvent = guardEvents(claim.personal, (event: object) => {
      writes = writes.then(() => inWorkspace(pool, workspaceId, (client) => client.query(
        "insert into run_events (workspace_id, run_id, node_id, event) values ($1, $2, $3, $4)",
        [workspaceId, runId, nodeId, JSON.stringify(seal(masterKey, workspaceId, event))],
      )).then(async () => {
        await spans(event);
        const tokens = (event as { type?: string; tokens?: number }).type === "model" ? (event as { tokens?: number }).tokens ?? 0 : 0;
        if (tokens) await recordTokens(pool, workspaceId, tokens);
      })).then(() => undefined, (error) => {
        console.error(JSON.stringify({ level: "error", event: "run_event_lost", runId, message: error.message }));
      });
    });

    try {
      const result = await type.run(type.configSchema.parse(node.config), {
        data: { input: claim.input, steps: claim.steps },
        directory: workspaceDirectory(pool, workspaceId, claim.run.created_by ?? "workflow"),
        confidential: claim.run.confidential,
        onEvent,
        pool, workspaceId, runId, nodeId, network, masterKey, search,
        checkBudget: () => assertWithinBudget(pool, workspaceId),
      });
      await writes;
      await inWorkspace(pool, workspaceId, async (client) => {
        await client.query(
          `update run_steps set status = $3, branch = $4, output = $5, finished_at = case when $3 = 'done' then now() end
           where run_id = $1 and node_id = $2 and status = 'running'`,
          [runId, nodeId, result.wait ? "waiting" : "done", result.branch ?? null, JSON.stringify(seal(masterKey, workspaceId, result.output ?? null))],
        );
        await advance(client, workspaceId, runId);
      });
    } catch (error) {
      await writes;
      const message = error instanceof Error ? error.message : String(error);
      if (claim.attempt < MAX_ATTEMPTS && !(error instanceof PermanentError)) throw error;
      // Only a step still running can fail: one a later worker finished, or one whose run was stopped, stays as it is.
      const failedNow = await inWorkspace(pool, workspaceId, async (client) => {
        const { rowCount } = await client.query(
          "update run_steps set status = 'failed', error = $3, finished_at = now() where run_id = $1 and node_id = $2 and status = 'running'",
          [runId, nodeId, sealText(masterKey, workspaceId, message.slice(0, 2_000))],
        );
        await advance(client, workspaceId, runId);
        const { rows: [run] } = await client.query("select status from runs where id = $1", [runId]);
        return !!rowCount && run?.status === "failed";
      });
      if (failedNow) await sendAlert({ type: "run_failed", workspaceId, id: runId, name: nodeId });
    }
  }

  /** A worker is stopping before this step finished. That is not the step's fault, so the attempt does not count against it. */
  async function handBack({ workspaceId, runId, nodeId }: StepJob) {
    await inWorkspace(pool, workspaceId, (client) => client.query(
      "update run_steps set attempt = greatest(attempt - 1, 0) where run_id = $1 and node_id = $2 and status = 'running'", [runId, nodeId],
    ));
  }

  /** Records a person's decision on a waiting approval step. Returns false if nothing was waiting. */
  async function decide(workspaceId: string, runId: string, nodeId: string, approved: boolean, actorId: string) {
    return inWorkspace(pool, workspaceId, async (client) => {
      // Declining stops something, so it stays open while paused.
      if (approved) await assertNotPaused(client, workspaceId);
      const { rows: [run] } = await client.query("select status, definition from runs where id = $1 for update", [runId]);
      if (!run || !["running", "waiting"].includes(run.status)) return false;
      const { rowCount } = await client.query(
        `update run_steps set status = 'done', branch = $3, decided_by = $4, finished_at = now()
         where run_id = $1 and node_id = $2 and status = 'waiting' and node_type = 'approval'`,
        [runId, nodeId, approved ? "approved" : "declined", actorId],
      );
      if (!rowCount) return false;
      await recordAudit(client, { workspaceId, actorId, action: approved ? "run.approved" : "run.declined", targetType: "run", targetId: runId, details: { nodeId } });
      const definition = run.definition as WorkflowDefinition;
      const handlesDecline = outgoing(definition, nodeId).some((edge) => edge.when === "declined");
      if (!approved && !handlesDecline) {
        await stop(client, runId, "A person declined this run.");
        return true;
      }
      await advance(client, workspaceId, runId);
      return true;
    });
  }

  /** Cancels a run that is still active. A finished run keeps its outcome, so a late cancel cannot overwrite a failure. */
  const stop = async (client: PoolClient, runId: string, reason: string) => {
    const { rowCount } = await client.query(
      "update runs set status = 'cancelled', error = $2, finished_at = now() where id = $1 and status = any($3)",
      [runId, reason, movesInto(RUN_MOVES, "cancelled")],
    );
    if (!rowCount) return false;
    // A step already working finishes or is cleared when its job next looks at the run.
    await client.query("update run_steps set status = 'skipped', finished_at = now() where run_id = $1 and status in ('pending', 'waiting')", [runId]);
    runOutcomes.inc({ outcome: "cancelled" });
    return true;
  };

  /** Stops a run. A step already working finishes, but nothing after it starts. */
  async function cancel(workspaceId: string, runId: string, actorId: string) {
    return inWorkspace(pool, workspaceId, async (client) => {
      const { rows: [run] } = await client.query("select status from runs where id = $1 for update", [runId]);
      if (!run || !["running", "waiting"].includes(run.status)) return false;
      await stop(client, runId, "A person cancelled this run.");
      await recordAudit(client, { workspaceId, actorId, action: "run.cancelled", targetType: "run", targetId: runId });
      return true;
    });
  }

  return { startRun, executeStep, handBack, decide, cancel, stepJobOptions: stepJobOptions(retryDelay, heartbeatSeconds), settings: { masterKey, network } };
}

export type Engine = ReturnType<typeof createEngine>;

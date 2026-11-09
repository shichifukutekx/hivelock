import { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { createEngine, MAINTENANCE_QUEUE, STEP_QUEUE, TRIGGER_QUEUE, type StepJob } from "./engine.ts";
import { AGENT_QUEUE, type AgentChat, type TurnJob } from "../agent-chat.ts";
import { KNOWLEDGE_QUEUE, type IndexJob, type Knowledge } from "../knowledge.ts";
import { runMaintenance } from "../maintenance.ts";
import { inWorkspace } from "../db.ts";
import { PlanLimit } from "../limits.ts";
import { extensions } from "../extensions.ts";
import { log } from "../log.ts";
import { createFairQueue, stepKey, turnKey, type FairOptions } from "./fair-queue.ts";

export const createBoss = (connectionString: string, role: "api" | "worker", { superviseIntervalSeconds = 60, monitorIntervalSeconds = 60 } = {}) => {
  const boss = new PgBoss({
    connectionString,
    max: 4,
    migrate: false,
    createSchema: false,
    schedule: role === "worker",
    supervise: role === "worker",
    superviseIntervalSeconds,
    // How often dead workers are looked for, so a crash is noticed within a minute or two.
    monitorIntervalSeconds,
  });
  boss.on("error", (error: Error) => log("error", "queue_error", { message: error.message }));
  return boss;
};

export const ensureQueues = async (boss: PgBoss) => {
  await boss.createQueue(STEP_QUEUE);
  await boss.createQueue(TRIGGER_QUEUE);
  await boss.createQueue(MAINTENANCE_QUEUE);
  await boss.createQueue(AGENT_QUEUE);
  await boss.createQueue(KNOWLEDGE_QUEUE);
  for (const name of extensions().flatMap(({ queues }) => queues ?? [])) await boss.createQueue(name);
};

interface TriggerJob {
  workspaceId: string;
  triggerId: string;
}

/** Starts taking work. Run more worker processes to do more at once. */
export async function startWorker(boss: PgBoss, pool: Pool, engine: ReturnType<typeof createEngine>, concurrency = 5, chat?: AgentChat, knowledge?: Knowledge, fairness: FairOptions = {}) {
  const fair = createFairQueue(pool, boss, fairness);
  fair.register(STEP_QUEUE, engine.stepJobOptions);
  if (chat) fair.register(AGENT_QUEUE, chat.turnJobOptions);
  boss.once("stopped", () => fair.stop());
  if (knowledge) {
    await boss.work<IndexJob>(KNOWLEDGE_QUEUE, { pollingIntervalSeconds: 1 }, async ([job]) => {
      await knowledge.index(job!.data);
    });
  }
  if (chat) {
    await boss.work<TurnJob>(AGENT_QUEUE, { localConcurrency: concurrency, pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
      await fair.run(AGENT_QUEUE, job!, turnKey(job!.data), () => chat.runTurn(job!.data), { requeue: false, handBack: () => chat.interrupt(job!.data.workspaceId, job!.data.sessionId) });
    });
  }
  await boss.schedule(MAINTENANCE_QUEUE, "0 3 * * *", {}, { tz: "UTC" });
  await boss.work(MAINTENANCE_QUEUE, async () => {
    await runMaintenance(pool);
  });
  await boss.work<StepJob>(STEP_QUEUE, { localConcurrency: concurrency, pollingIntervalSeconds: 0.5, includeMetadata: true }, async ([job]) => {
    await fair.run(STEP_QUEUE, job!, stepKey(job!.data), () => engine.executeStep(job!.data), { handBack: () => engine.handBack(job!.data) });
  });
  for (const { worker } of extensions()) await worker?.({ boss, pool, engine, concurrency, chat, knowledge });
  await boss.work<TriggerJob>(TRIGGER_QUEUE, { pollingIntervalSeconds: 1 }, async ([job]) => {
    const { workspaceId, triggerId } = job!.data;
    const trigger = await inWorkspace(pool, workspaceId, async (client) =>
      (await client.query("select workflow_id, enabled from triggers where id = $1", [triggerId])).rows[0]);
    if (!trigger?.enabled) return;
    // A refusal is already recorded as a failed run, or was a pause, and repeating the job would only record it again or start late.
    await engine.startRun({ workspaceId, workflowId: trigger.workflow_id, input: { scheduledAt: new Date().toISOString() }, triggerKind: "schedule", triggerId }).catch((error) => {
      if (!(error instanceof PlanLimit)) throw error;
    });
  });
  await fair.start();
  return fair;
}

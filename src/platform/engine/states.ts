/**
 * The lifecycles of a run and its steps, in one place. Every status write in the engine says which states it may
 * move from, using these tables, so a finished run or step can never be moved back or overwritten by a late writer.
 * The database check constraints in 002_workflows.sql list the same names.
 */

export const RUN_STATES = ["running", "waiting", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATES)[number];

export const STEP_STATES = ["pending", "running", "waiting", "done", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATES)[number];

/** Which states each state may move to. A state with no moves is final. */
export const RUN_MOVES: Record<RunStatus, readonly RunStatus[]> = {
  running: ["running", "waiting", "succeeded", "failed", "cancelled"],
  waiting: ["running", "waiting", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const STEP_MOVES: Record<StepStatus, readonly StepStatus[]> = {
  // A pending step can fail without running when its attempts are used up, and is skipped when the run stops.
  pending: ["running", "failed", "skipped"],
  // Running again is a retry. Skipped is a step whose run was stopped while it worked.
  running: ["running", "done", "waiting", "failed", "skipped"],
  waiting: ["done", "skipped"],
  done: [],
  failed: [],
  skipped: [],
};

/** A run in one of these still has work to do or a decision to wait for. */
export const ACTIVE_RUN: readonly RunStatus[] = ["running", "waiting"];

/** The states that may move to `to`, for a guarded `where status = any($n)`. */
export function movesInto<S extends string>(moves: Record<S, readonly S[]>, to: S): S[] {
  return (Object.keys(moves) as S[]).filter((from) => moves[from].includes(to));
}

export const isFinalRun = (status: string) => (RUN_MOVES[status as RunStatus]?.length ?? 0) === 0;

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./config.ts";

/** Appends one JSON line per event, so every model call and tool call can be reviewed later. */
export function audit(runId: string, event: string, details: Record<string, unknown> = {}): void {
  const file = paths.auditLog();
  // The platform worker records each run in the database instead, where workspaces are kept apart.
  if (file === "off") return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), runId, event, ...details }) + "\n");
}

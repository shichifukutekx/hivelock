import { AsyncLocalStorage } from "node:async_hooks";
import { scrub } from "./scrub.ts";

type Fields = Record<string, unknown>;

const context = new AsyncLocalStorage<Fields>();

/** Everything logged while `work` runs carries these fields, such as the request id. */
export const withLogFields = <T>(fields: Fields, work: () => T) => context.run({ ...context.getStore(), ...fields }, work);

/** One JSON line. Ids and measurements only: bodies, headers and prompts never go here. A message is checked for credentials first. */
export function log(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const { message, ...rest } = fields;
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...context.getStore(), ...rest, ...(message === undefined ? {} : { message: scrub(String(message)) }) });
  if (level === "info") console.log(line);
  else console.error(line);
}

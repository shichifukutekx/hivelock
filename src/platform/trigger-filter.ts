import { z } from "zod";

/**
 * A webhook's filter: plain conditions on the JSON it receives, checked in code before a run starts,
 * so deliveries nobody needs never reach a model or use up a run.
 */

export const FILTER_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "exists", "missing", "greater", "less"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

const condition = z.object({
  // A dotted path into the JSON, such as "order.status" or "items.0.sku".
  field: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/),
  op: z.enum(FILTER_OPERATORS),
  value: z.string().max(500).optional(),
}).refine((item) => item.op === "exists" || item.op === "missing" || (item.value ?? "").trim() !== "", { message: "needs a value" })
  .refine((item) => (item.op !== "greater" && item.op !== "less") || Number.isFinite(Number(item.value)), { message: "needs a number" });

export const triggerFilter = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(condition).min(1).max(10),
});
export type TriggerFilter = z.infer<typeof triggerFilter>;

function valueAt(input: unknown, field: string): unknown {
  let current = input;
  for (const part of field.split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value) ?? "").trim().toLowerCase();

function holds(input: unknown, { field, op, value = "" }: TriggerFilter["conditions"][number]): boolean {
  const found = valueAt(input, field);
  const wanted = value.trim().toLowerCase();
  switch (op) {
    case "exists": return found !== undefined && found !== null;
    case "missing": return found === undefined || found === null;
    case "equals": return found !== undefined && text(found) === wanted;
    case "not_equals": return found === undefined || text(found) !== wanted;
    case "contains": return Array.isArray(found) ? found.some((item) => text(item) === wanted) : found !== undefined && text(found).includes(wanted);
    case "not_contains": return !holds(input, { field, op: "contains", value });
    case "greater": return found !== undefined && found !== null && found !== "" && Number(found) > Number(value);
    case "less": return found !== undefined && found !== null && found !== "" && Number(found) < Number(value);
  }
}

/** True when a delivery should start a run. No filter lets everything through. */
export function passesFilter(filter: TriggerFilter | null | undefined, input: unknown) {
  if (!filter?.conditions?.length) return true;
  return filter.match === "any" ? filter.conditions.some((item) => holds(input, item)) : filter.conditions.every((item) => holds(input, item));
}

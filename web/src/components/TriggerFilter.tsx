import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Filter, Plus, Save, X } from "lucide-react";
import { useState } from "react";
import { ago, api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { Button, Input, Notice, Select } from "./ui.tsx";

interface Condition { field: string; op: string; value?: string }
interface FilterValue { match: "all" | "any"; conditions: Condition[] }

const CHECKS: [string, string][] = [
  ["equals", "is"], ["not_equals", "is not"], ["contains", "contains"], ["not_contains", "does not contain"],
  ["greater", "is more than"], ["less", "is less than"], ["exists", "is present"], ["missing", "is missing"],
];
const needsValue = (op: string) => op !== "exists" && op !== "missing";
const checkName = (op: string) => CHECKS.find(([value]) => value === op)?.[1] ?? op;

/** One line a person can read, such as: status is "paid" and total is more than 500. */
export const filterSummary = (filter: FilterValue) =>
  filter.conditions.map((item) => `${item.field} ${checkName(item.op)}${needsValue(item.op) ? ` "${item.value}"` : ""}`).join(filter.match === "any" ? " or " : " and ");

/** Only deliveries that match start a run. Checked in code, before any model is used. */
export function TriggerFilter({ trigger, canEdit, queryKey }: { trigger: any; canEdit: boolean; queryKey: unknown[] }) {
  const { path } = useWorkspace();
  const client = useQueryClient();
  const current: FilterValue | null = trigger.filter ?? null;
  const [draft, setDraft] = useState<FilterValue | null>(null);
  const save = useMutation({
    mutationFn: (filter: FilterValue | null) => api(`${path}/triggers/${trigger.id}/filter`, { method: "PUT", body: { filter } }),
    onSuccess: () => { setDraft(null); client.invalidateQueries({ queryKey }); },
  });
  const update = (index: number, change: Partial<Condition>) =>
    setDraft((before) => before && { ...before, conditions: before.conditions.map((item, at) => (at === index ? { ...item, ...change } : item)) });
  const ready = !!draft && draft.conditions.every((item) => item.field.trim() && (!needsValue(item.op) || (item.value ?? "").trim()));

  if (!draft) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1"><Filter size={12} /> {current ? <>Runs only when {filterSummary(current)}</> : "Every delivery starts a run."}</span>
        {current && trigger.skipped_count > 0 && <span>{trigger.skipped_count} skipped, last {ago(trigger.last_skipped_at)}</span>}
        {canEdit && (
          <span className="flex gap-2">
            <button type="button" className="text-accent hover:underline" onClick={() => { save.reset(); setDraft(current ?? { match: "all", conditions: [{ field: "", op: "equals", value: "" }] }); }}>{current ? "Change filter" : "Add a filter"}</button>
            {current && <button type="button" className="hover:text-danger hover:underline" onClick={() => save.mutate(null)}>Remove</button>}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg bg-raised p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span>Start a run only when</span>
        <Select aria-label="Match" className="w-auto" value={draft.match} onChange={(event) => setDraft({ ...draft, match: event.target.value as "all" | "any" })}>
          <option value="all">all of these hold</option>
          <option value="any">any of these holds</option>
        </Select>
      </div>
      {draft.conditions.map((item, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-center">
          <Input aria-label="Field" className="font-mono" placeholder="order.status" value={item.field} onChange={(event) => update(index, { field: event.target.value })} />
          <Select aria-label="Check" value={item.op} onChange={(event) => update(index, { op: event.target.value })}>
            {CHECKS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          {needsValue(item.op) ? <Input aria-label="Value" placeholder={item.op === "greater" || item.op === "less" ? "500" : "paid"} value={item.value ?? ""} onChange={(event) => update(index, { value: event.target.value })} /> : <span className="hidden sm:block" />}
          <button type="button" aria-label="Remove condition" className="icon-btn justify-self-end" disabled={draft.conditions.length === 1} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, at) => at !== index) })}><X size={14} /></button>
        </div>
      ))}
      <p className="text-[12px] text-muted">Fields are paths in the JSON sent, with dots between levels, such as <span className="font-mono">customer.country</span> or <span className="font-mono">items.0.sku</span>. Text checks ignore capital letters.</p>
      {save.isError && <Notice>{save.error.message}</Notice>}
      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" disabled={draft.conditions.length >= 10} onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: "", op: "equals", value: "" }] })}><Plus size={14} /> Add a condition</Button>
        <span className="flex gap-2">
          <Button type="button" onClick={() => setDraft(null)}>Cancel</Button>
          <Button type="button" variant="primary" busy={save.isPending} disabled={!ready}
            onClick={() => save.mutate({ match: draft.match, conditions: draft.conditions.map((item) => ({ field: item.field.trim(), op: item.op, ...(needsValue(item.op) ? { value: (item.value ?? "").trim() } : {}) })) })}>
            <Save size={14} /> Save filter
          </Button>
        </span>
      </div>
    </div>
  );
}

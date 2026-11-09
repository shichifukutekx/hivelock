import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, BarChart3, Cable, Check, CheckCircle2, ClipboardCheck, Cpu, LayoutDashboard, LayoutTemplate, Play, Plus, Workflow, X, type LucideIcon, Rocket } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { DataTable } from "../components/DataTable.tsx";
import { PauseButton } from "../components/PauseAll.tsx";
import { Badge, Button, Card, cardHover, Empty, IconTile, PageHeader, SkeletonRows, SkeletonStats, TriggerLabel, Heading } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import type { Column } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

/** A short view of the newest runs. It has no sort or filter of its own: All runs has those, over everything. */
const columns: Column[] = [
  { key: "workflow", header: "Workflow" },
  { key: "trigger", header: "Started by" },
  { key: "status", header: "Status" },
  { key: "when", header: "When" },
];

const hiddenKey = (workspaceId: string) => `hivelock.setup-hidden:${workspaceId}`;
const remembered = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const remember = (key: string) => { try { localStorage.setItem(key, "1"); } catch {} };

/** The first day, in order. It goes away by itself once everything is done, and the steps go by what exists, not by what was clicked. */
function GettingStarted({ setup }: { setup: { models: boolean; modelNotCleared: boolean; connections: boolean; work: boolean; ran: boolean } }) {
  const { id, link, can } = useWorkspace();
  const [hidden, setHidden] = useState(() => remembered(hiddenKey(id)));
  const steps: { done: boolean; title: string; hint: string; to: string; action: string; icon: LucideIcon; needs?: boolean }[] = [
    {
      done: setup.models, title: "Add an AI model", to: link("/settings#models"), action: setup.modelNotCleared ? "Fix this" : "Add a model", icon: Cpu, needs: can("connections:write"),
      hint: setup.modelNotCleared ? "Confidential mode is on, and no model is cleared for it yet, so runs will stop. Clear one, or turn the mode off." : "Agents need one to think. Bring a key, or point at a local model.",
    },
    { done: setup.connections, title: "Connect a tool", hint: "Link the apps your agents will work with, such as mail or a spreadsheet.", to: link("/connections?add=1"), action: "Connect", icon: Cable, needs: can("connections:write") },
    { done: setup.work, title: "Install a template, or build your own", hint: "Start from a ready-made agent or workflow.", to: link("/templates"), action: "Browse templates", icon: LayoutTemplate },
    { done: setup.ran, title: "Run it", hint: "Start a workflow, or chat with an agent, and see the result.", to: link("/workflows"), action: "Open workflows", icon: Play },
  ];
  const left = steps.filter((step) => !step.done).length;
  if (hidden || left === 0) return null;
  const next = steps.find((step) => !step.done);
  return (
    <Card className="mb-3 p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Heading icon={Rocket}>Get started <span className="ml-1 text-[12px] font-normal text-muted tabular-nums">{steps.length - left} of {steps.length} done</span></Heading>
        <button type="button" aria-label="Hide getting started" title="Hide" className="icon-btn" onClick={() => { remember(hiddenKey(id)); setHidden(true); }}><X size={14} /></button>
      </div>
      <ol className="divide-y divide-line">
        {steps.map((step) => (
          <li key={step.title} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${step.done ? "bg-ok-soft text-ok" : "border border-line-strong text-faint"}`}>{step.done && <Check size={12} />}</span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[13px] font-medium ${step.done ? "text-muted line-through" : ""}`}>{step.title}<span className="sr-only">{step.done ? ", done" : ""}</span></span>
              {!step.done && <span className="block text-[12px] text-muted">{step.needs === false ? "Ask an admin to do this." : step.hint}</span>}
            </span>
            {!step.done && step.needs !== false && <Link to={step.to}><Button variant={step === next ? "primary" : "secondary"} className="h-8"><step.icon size={13} /> {step.action}</Button></Link>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Stat({ label, value, note, to, icon, tone }: { label: string; value: number | string; note?: string; to?: string; icon: LucideIcon; tone?: "accent" | "warn" | "info" | "ok" }) {
  const body = (
    <div className="flex items-start justify-between gap-2 p-4">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-muted">{label}</div>
        <div className="mt-1 font-display text-[26px] leading-tight font-semibold tabular-nums tracking-tight">{value}</div>
        {note && <div className="text-[12px] text-faint">{note}</div>}
      </div>
      <IconTile icon={icon} tone={tone} size={30} className={tone ? undefined : "brand-tile"} />
    </div>
  );
  return <Card className={to ? cardHover : ""}>{to ? <Link to={to} className="block">{body}</Link> : body}</Card>;
}

/** Two weeks of runs. Failures sit on top in a separate color, and each day names its numbers on hover. */
function RunChart({ days }: { days: { day: string; succeeded: number; failed: number }[] }) {
  const highest = Math.max(1, ...days.map((d) => d.succeeded + d.failed));
  const total = days.reduce((sum, d) => sum + d.succeeded + d.failed, 0);
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <Heading icon={BarChart3}>Runs, last 14 days</Heading>
        <div className="flex gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-ok" /> Succeeded</span>
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-danger" /> Failed</span>
        </div>
      </div>
      {total === 0 ? <p className="flex items-center justify-center gap-1.5 py-10 text-[13px] text-faint"><Activity size={14} /> No runs yet.</p> : (
        <div role="img" aria-label={`${total} runs in the last 14 days`} className="flex h-32 items-end gap-1">
          {days.map((d) => (
            <div key={d.day} title={`${d.day}: ${d.succeeded} succeeded, ${d.failed} failed`} className="flex h-full flex-1 flex-col justify-end gap-px">
              {d.failed > 0 && <div className="rounded-sm bg-danger" style={{ height: `${(d.failed / highest) * 100}%` }} />}
              {d.succeeded > 0 && <div className="rounded-sm bg-ok" style={{ height: `${(d.succeeded / highest) * 100}%` }} />}
              {d.succeeded + d.failed === 0 && <div className="h-px bg-line" />}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function Dashboard() {
  const { path, link, workspace, can } = useWorkspace();
  const overview = useQuery({ queryKey: ["overview", path], queryFn: () => api(`${path}/overview`), refetchInterval: 15_000 });
  if (overview.isLoading || !overview.data) return <><SkeletonStats /><Card className="mt-3"><SkeletonRows /></Card></>;
  const { counts, daily, recent, setup } = overview.data;
  const finished = counts.succeeded_week + counts.failed_week;
  const waiting = counts.waiting_approvals + counts.waiting_chats;
  return (
    <>
      <PageHeader icon={LayoutDashboard} title={workspace?.name ?? "Overview"} description="What your agents and workflows are doing."
        actions={<><PauseButton />{can("workflows:write") && <Link to={link("/workflows?new=1")}><Button variant="primary"><Plus size={14} /> New workflow</Button></Link>}</>} />
      {setup && <GettingStarted setup={setup} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat icon={ClipboardCheck} tone="warn" label="Needs approval" value={waiting} to={link("/approvals")} note={waiting ? "Waiting for a person" : "Nothing waiting"} />
        <Stat icon={Activity} tone="info" label="Running now" value={counts.active_runs} to={link("/runs")} />
        <Stat icon={Workflow} label="Live workflows" value={counts.live_workflows} note={`of ${counts.workflows}`} to={link("/workflows")} />
        <Stat icon={CheckCircle2} tone="ok" label="Success, 7 days" value={finished ? `${Math.round((counts.succeeded_week / finished) * 100)}%` : "—"} note={counts.failed_week ? `${counts.failed_week} failed, see runs` : `${finished} finished`} to={link("/runs")} />
      </div>
      <div className="mt-3"><RunChart days={daily} /></div>
      <Card className="mt-3">
        <div className="flex items-center justify-between px-4 py-3">
          <Heading icon={Activity}>Recent runs</Heading>
          <Link to={link("/runs")} className="flex items-center gap-1 text-[12px] text-muted hover:text-ink">All runs <ArrowRight size={13} /></Link>
        </div>
        {recent.length === 0 ? (
          <Empty icon={Activity} title="No runs yet" action={<Link to={link("/workflows")}><Button variant="primary"><Workflow size={14} /> Open workflows</Button></Link>}>Build a workflow and run it to see it here.</Empty>
        ) : (
          <DataTable id="recent-runs" columns={columns} rows={recent} searchable={false}>
            {(run: any) => (
              <tr key={run.id} className="hover:bg-raised">
                <td className="px-4 py-2.5"><Link className="font-medium hover:underline" to={link(`/runs/${run.id}`)}>{run.workflow_name}</Link></td>
                <td className="px-4 py-2.5 text-muted capitalize"><TriggerLabel kind={run.trigger_kind} /></td>
                <td className="px-4 py-2.5"><Badge status={run.status} /></td>
                <td className="px-4 py-2.5 text-muted">{ago(run.created_at)}</td>
              </tr>
            )}
          </DataTable>
        )}
      </Card>
    </>
  );
}

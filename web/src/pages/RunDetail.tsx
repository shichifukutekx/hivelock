import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Background, Controls, ReactFlow, ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { Activity, ArrowLeft, ArrowRight, Ban, Check, Copy, FileText, GitBranch, Hourglass, ListChecks, Lock, RotateCcw, Settings, Workflow, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ExportMenu } from "../components/ExportMenu.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { nodeTypes, stepTitle } from "../components/StepNode.tsx";
import { Badge, Button, Code, Notice, Spinner, Heading } from "../components/ui.tsx";
import { api, cost, duration, pointsToSettings, when } from "../lib/api.ts";
import { toCanvas } from "../lib/flow.ts";
import { useRetryRun } from "../components/RetryDialog.tsx";
import { canRetry } from "../lib/runs.ts";
import { useWorkspace } from "../lib/workspace.ts";

const active = (status?: string) => status === "running" || status === "waiting";

function eventLine(event: any): string | undefined {
  const who = event.parentRunId ? `${event.agent}: ` : "";
  if (event.type === "tool_started") return `${who}used ${event.tool}`;
  if (event.type === "started") return `${event.agent} started`;
  if (event.type === "finished") return `${event.agent} finished`;
  if (event.type === "failed") return `${event.agent} failed: ${event.message}`;
  if (event.type === "model") return `${who}${event.model ?? "model"} · ${event.tokens?.toLocaleString() ?? "?"} tokens`;
  if (event.type === "approval_decided") return `${who}${event.tool} was refused, because it needs approval`;
  return undefined;
}

/** Finished steps out of all of them. A branch not taken never finishes, so a run that succeeded always reads as full. */
function RunProgress({ run, steps }: { run: any; steps: any[] }) {
  const finished = steps.filter((s) => ["done", "skipped", "failed"].includes(s.status)).length;
  const share = run.status === "succeeded" ? 1 : Math.min(1, finished / Math.max(1, run.definition.nodes.length));
  const color = run.status === "failed" ? "bg-danger" : run.status === "waiting" ? "bg-warn" : run.status === "succeeded" ? "bg-ok" : run.status === "cancelled" ? "bg-line-strong" : "bg-accent";
  return (
    <div role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} className="h-0.5 shrink-0 overflow-hidden bg-sunken">
      <div className={`progress-fill h-full ${color}`} style={{ transform: `scaleX(${share})` }} />
    </div>
  );
}

function StepPanel({ step, events, label }: { step: any; events: any[]; label: string }) {
  const { link } = useWorkspace();
  const lines = events.filter((e) => e.node_id === step.node_id).map((e) => eventLine(e.event)).filter(Boolean) as string[];
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between gap-2"><h2 className="truncate text-[14px] font-medium">{label}</h2><Badge status={step.status} /></div>
        <p className="text-[12px] text-muted">
          {step.started_at ? `${when(step.started_at)} · ${duration(step.started_at, step.finished_at)}` : "Not started"}
          {step.attempt > 1 && ` · attempt ${step.attempt}`}
        </p>
      </div>
      {step.error && <Notice>{step.error}{pointsToSettings(step.error) && <> <Link to={link("/settings#models")} className="inline-flex items-center gap-1 underline"><Settings size={12} /> Open Settings</Link></>}</Notice>}
      {step.branch && <p className="flex items-center gap-1.5 text-[13px] text-muted"><GitBranch size={13} className="shrink-0" /> <span>Outcome: <span className="font-medium text-ink">{step.branch}</span></span></p>}
      {step.output !== null && step.output !== undefined && <div><h3 className="mb-1 text-[12px] font-medium text-muted">Output</h3><Code value={step.output} /></div>}
      {lines.length > 0 && (
        <div>
          <h3 className="mb-1 text-[12px] font-medium text-muted">Activity</h3>
          <ol className="space-y-0.5 text-[12px] text-muted">{lines.map((line, index) => <li key={index} className="break-words">{line}</li>)}</ol>
        </div>
      )}
    </div>
  );
}

function RunView() {
  const { runId } = useParams();
  const { path, link, can } = useWorkspace();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<"result" | "steps">();
  const [copied, setCopied] = useState(false);
  const key = ["run", runId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api(`${path}/runs/${runId}`),
    refetchInterval: (state) => (active(state.state.data?.run.status) ? 1_000 : false),
    staleTime: 0,
  });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const retry = useRetryRun();
  const cancel = useMutation({ mutationFn: () => api(`${path}/runs/${runId}/cancel`, { method: "POST" }), onSuccess: refresh });
  const decide = useMutation({
    mutationFn: ({ nodeId, approved }: { nodeId: string; approved: boolean }) => api(`${path}/runs/${runId}/steps/${nodeId}/decision`, { body: { approved } }),
    onSuccess: () => { refresh(); client.invalidateQueries({ queryKey: ["approvals", path] }); client.invalidateQueries({ queryKey: ["overview", path] }); },
  });
  const data = query.data;
  const canvas = useMemo(() => {
    if (!data) return undefined;
    const statuses = Object.fromEntries(data.steps.map((s: any) => [s.node_id, s.status]));
    return toCanvas(data.run.definition, statuses);
  }, [data]);

  if (query.isLoading) return <Spinner />;
  if (!data || !canvas) return <div className="p-6"><Notice>That run could not be opened.</Notice></div>;
  const { run, steps, events } = data;
  const waiting = steps.find((s: any) => s.status === "waiting");
  const step = steps.find((s: any) => s.node_id === selected);
  const nodeLabel = (id: string) => {
    const node = run.definition.nodes.find((n: any) => n.id === id);
    return node?.label || stepTitle(node?.type ?? "") || id;
  };
  const failed = steps.find((s: any) => s.status === "failed");
  // What the run wrote: the newest finished agent step's text. People come here for this, not for the diagram.
  const agentSteps = new Set(run.definition.nodes.filter((n: any) => n.type === "agent").map((n: any) => n.id));
  const report = [...steps].filter((s: any) => agentSteps.has(s.node_id) && s.status === "done" && typeof s.output === "string" && s.output.trim())
    .sort((a: any, b: any) => String(a.finished_at ?? "").localeCompare(String(b.finished_at ?? ""))).at(-1);
  const showing_ = view ?? (report ? "result" : "steps");
  const copy = async () => { await navigator.clipboard.writeText(report.output); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const showing = step ?? (selected ? undefined : failed ?? waiting);

  return (
    <div className="flex h-full flex-col">
      {retry.dialog}
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Link to={link("/runs")} className="flex items-center gap-1 rounded-lg p-1.5 text-[13px] text-muted hover:bg-sunken hover:text-ink"><ArrowLeft size={16} /> Runs</Link>
        {run.workflow_id ? <Link to={link(`/workflows/${run.workflow_id}`)} className="min-w-0 truncate hover:underline"><h1 className="truncate text-[14px] font-semibold">{run.workflow_name}</h1></Link> : <h1 className="min-w-0 truncate text-[14px] font-semibold">{run.workflow_name}</h1>}
        <span className="text-[12px] text-faint tabular-nums">v{run.workflow_version}</span>
        <Badge status={run.status} />
        {run.confidential && <span title="Only AI providers cleared for confidential work could be used for this run." className="flex items-center gap-1 text-[12px] text-muted"><Lock size={12} /> Confidential</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-muted"><span className="capitalize">{run.trigger_kind}</span> · {when(run.created_at)}{run.finished_at && ` · took ${duration(run.created_at, run.finished_at)}`}{data.used && cost(data.used.cost_usd, data.used.tokens) !== "—" && ` · ${cost(data.used.cost_usd, data.used.tokens)}`}</span>
          <Link to={link(`/traces/${run.id}`)}><Button><Activity size={14} /> Timeline</Button></Link>
          {run.retried_as
            ? <Link to={link(`/runs/${run.retried_as}`)}><Button><ArrowRight size={14} /> New run</Button></Link>
            : canRetry(run.status) && can("runs:start") && run.workflow_id && <Button onClick={() => retry.start(run.id)}><RotateCcw size={14} /> Run again</Button>}
          {active(run.status) && can("runs:start") && <Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()}><Ban size={14} /> Cancel run</Button>}
        </div>
      </header>
      <RunProgress run={run} steps={steps} />
      {waiting && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-warn-soft px-4 py-2.5">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium text-warn"><Hourglass size={14} className="shrink-0" /> {waiting.output?.message ?? "This run needs a decision."}</p>
          {can("runs:approve") && (
            <div className="flex gap-2">
              <Button variant="danger" disabled={decide.isPending} onClick={() => decide.mutate({ nodeId: waiting.node_id, approved: false })}><X size={14} /> Decline</Button>
              <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ nodeId: waiting.node_id, approved: true })}><Check size={14} /> Approve</Button>
            </div>
          )}
        </div>
      )}
      {decide.isError && <div className="p-2"><Notice>{decide.error.message}</Notice></div>}
      {report && (
        <div role="tablist" aria-label="Run view" className="flex gap-1 border-b border-line bg-surface px-3">
          {([["result", "Result", FileText], ["steps", "Steps", Workflow]] as const).map(([key, label, Icon]) => (
            <button key={key} role="tab" type="button" aria-selected={showing_ === key} onClick={() => setView(key)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${showing_ === key ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      )}
      {report && showing_ === "result" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="enter-fade mx-auto max-w-3xl rounded-2xl border border-line bg-surface p-5 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
              <p className="text-[12px] text-muted">Written by the step <span className="font-medium text-ink">{nodeLabel(report.node_id)}</span>{report.finished_at && ` · ${when(report.finished_at)}`}</p>
              <span className="flex items-center gap-2">
                <Button className="h-8" onClick={copy}>{copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}</Button>
                <ExportMenu text={report.output} name={`${run.workflow_name} ${new Date(report.finished_at ?? run.created_at).toISOString().slice(0, 10)}`} />
              </span>
            </div>
            <div className="text-[14px] leading-relaxed"><Markdown text={report.output} /></div>
          </div>
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="min-h-64 min-w-0 flex-1">
          <ReactFlow nodes={canvas.nodes as Node[]} edges={canvas.edges as Edge[]} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null}
            onNodeClick={(_, node) => setSelected(node.id)} onPaneClick={() => setSelected(undefined)} fitView fitViewOptions={{ maxZoom: 1, padding: 0.25 }} minZoom={0.3}>
            <Background gap={20} color="var(--line-strong)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside aria-label="Run details" className="max-h-[45%] shrink-0 overflow-y-auto border-t border-line bg-surface p-4 md:max-h-none md:w-96 md:border-t-0 md:border-l">
          {showing ? <div key={showing.node_id} className="enter-fade"><StepPanel step={showing} events={events} label={nodeLabel(showing.node_id)} />{Object.keys(run.input ?? {}).length > 0 && <div className="mt-3"><h3 className="mb-1 text-[12px] font-medium text-muted">Run input</h3><Code value={run.input} /></div>}</div> : (
            <div className="space-y-3">
              {selected ? <p className="text-[13px] text-muted">This step has not started.</p> : (
                <>
                  <Heading icon={ListChecks}>Run summary</Heading>
                  {run.error && <Notice>{run.error}</Notice>}
                  <p className="text-[12px] text-muted">Took {duration(run.created_at, run.finished_at)}. Click a step to see its details.</p>
                  {Object.keys(run.input ?? {}).length > 0 && <div><h3 className="mb-1 text-[12px] font-medium text-muted">Input</h3><Code value={run.input} /></div>}
                  {run.output && <div><h3 className="mb-1 text-[12px] font-medium text-muted">Result</h3><Code value={run.output} /></div>}
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      )}
    </div>
  );
}

export const RunDetail = () => <ReactFlowProvider><RunView /></ReactFlowProvider>;

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, ArrowLeft, Bot, Brain, Shield, Wrench, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Pager } from "../components/DataTable.tsx";
import { Badge, Card, Empty, PageHeader, SkeletonRows } from "../components/ui.tsx";
import { api, cost } from "../lib/api.ts";
import { DEFAULT_PAGE_SIZE, pageForSize } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

const kindNames: Record<string, string> = { model: "Model", tool: "Tool", guardrail: "Guardrail", agent: "Agent" };
const kindIcons: Record<string, LucideIcon> = { model: Brain, tool: Wrench, guardrail: Shield, agent: Bot };

/** A timeline of one run or chat. Each row is a step, placed by when it started and sized by how long it took. */
export function Trace() {
  const { traceId } = useParams();
  const { path, link } = useWorkspace();
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE * 4);
  const trace = useQuery({ queryKey: ["trace", traceId, page, size], queryFn: () => api(`${path}/traces/${traceId}?limit=${size}&offset=${(page - 1) * size}`), refetchInterval: 5_000, placeholderData: keepPreviousData });
  if (trace.isLoading) return <Card><SkeletonRows rows={8} /></Card>;
  const spans: any[] = trace.data?.spans ?? [];
  const summary = trace.data?.summary;
  const placed = spans.map((span) => {
    const end = new Date(span.at).getTime();
    return { ...span, end, start: end - (span.duration_ms ?? 0) };
  });
  const first = Math.min(...placed.map((s) => s.start));
  const last = Math.max(...placed.map((s) => s.end));
  const length = Math.max(1, last - first);
  const whole = summary?.started ? (new Date(summary.finished).getTime() - new Date(summary.started).getTime()) / 1000 : 0;
  const isRun = spans[0]?.trace_kind === "run";
  return (
    <>
      {isRun
        ? <Link to={link(`/runs/${traceId}`)} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft size={14} /> Back to the run</Link>
        : spans[0]?.agent
          ? <Link to={link(`/agents/${encodeURIComponent(spans[0].agent)}?session=${traceId}`)} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft size={14} /> Back to the chat</Link>
          : <Link to={link("/observability")} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft size={14} /> Back to usage</Link>}
      <PageHeader icon={Activity} title="Timeline" description={summary?.steps ? `${Number(summary.steps).toLocaleString()} steps · ${whole.toFixed(1)} s · ${Number(summary.tokens).toLocaleString()} tokens · ${cost(summary.cost_usd)}` : "Each model and tool call, in order."} />
      <Card>
        {spans.length === 0 ? <Empty icon={Activity} title="No steps recorded">Steps appear once an agent has run.</Empty> : (
          <ul className="divide-y divide-line">
            {placed.map((span) => {
              const KindIcon = kindIcons[span.kind] ?? Wrench;
              return (
              <li key={span.id} className="grid grid-cols-[minmax(0,1fr)] gap-1 px-4 py-2 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_7rem] sm:items-center sm:gap-3">
                <div className="min-w-0">
                  <div className="truncate font-mono text-[12px]" title={span.name}>{span.name}</div>
                  <div className="flex items-center gap-1 text-[11px] text-muted"><KindIcon size={11} className="shrink-0" /><span className="truncate">{kindNames[span.kind]}{span.agent ? ` · ${span.agent}` : ""}</span></div>
                </div>
                <div className="relative h-3 rounded bg-sunken" role="img" aria-label={`${span.duration_ms ?? 0} milliseconds`}>
                  <div className={`absolute inset-y-0 min-w-1 rounded ${span.status === "error" ? "bg-danger" : "bg-accent"}`} style={{ left: `${((span.start - first) / length) * 100}%`, width: `${((span.duration_ms ?? 0) / length) * 100}%` }} />
                </div>
                <div className="flex items-center justify-end gap-2 text-[12px] text-muted tabular-nums">
                  {span.status !== "ok" && <Badge status={span.status === "error" ? "failed" : "declined"}>{span.status === "error" ? "Failed" : "Stopped"}</Badge>}
                  {span.duration_ms !== null && <span>{(span.duration_ms / 1000).toFixed(2)} s</span>}
                </div>
              </li>
              );
            })}
          </ul>
        )}
        <Pager page={page} total={Number(summary?.steps ?? 0)} size={size} label="steps" onPage={setPage} onSize={(next) => { setPage(pageForSize(page, size, next)); setSize(next); }} />
      </Card>
    </>
  );
}

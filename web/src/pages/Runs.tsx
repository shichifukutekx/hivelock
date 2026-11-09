import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, ArrowRight, Eye, RotateCcw, Workflow } from "lucide-react";
import { Link } from "react-router-dom";
import { DataTable, useTable, useTableParams } from "../components/DataTable.tsx";
import { Badge, Button, Card, Empty, PageHeader, SkeletonRows, statusLabel, TriggerLabel } from "../components/ui.tsx";
import { api, cost, duration, when } from "../lib/api.ts";
import { useRetryRun } from "../components/RetryDialog.tsx";
import { canRetry } from "../lib/runs.ts";
import { capitalize, hasFilters, setFilter, type Column } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

const STATUSES = ["waiting", "running", "failed", "succeeded", "cancelled"].map((value) => ({ value, label: statusLabel(value) }));
const TRIGGERS = ["manual", "schedule", "webhook", "email"].map((value) => ({ value, label: capitalize(value) }));

const columns: Column[] = [
  { key: "workflow", header: "Workflow", value: (run) => run.workflow_name, server: { sort: true } },
  { key: "status", header: "Status", value: (run) => statusLabel(run.status), server: { sort: true, options: STATUSES } },
  { key: "trigger", header: "Started by", value: (run) => capitalize(run.trigger_kind), server: { sort: true, options: TRIGGERS } },
  { key: "started", header: "Started", kind: "date", value: (run) => run.created_at, server: { sort: true, range: true } },
  { key: "took", header: "Took", kind: "number", value: (run) => run.finished_at, server: { sort: true } },
  { key: "cost", header: "Cost" },
  { key: "actions", header: "" },
];

const daysAgo = (days: number) => {
  const date = new Date(Date.now() - days * 86_400_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export function Runs() {
  const { path, link, can } = useWorkspace();
  const table = useTable("runs");
  const params = useTableParams(table, columns);
  const list = useQuery({ queryKey: ["runs", path, params], queryFn: () => api(`${path}/runs?${params}`), refetchInterval: 4_000, placeholderData: keepPreviousData });
  const overview = useQuery({ queryKey: ["overview", path], queryFn: () => api(`${path}/overview`), refetchInterval: 15_000 });
  const retry = useRetryRun();
  const counts = overview.data?.counts;
  const show = (status: string, started?: string) => table.setState((state) => setFilter(setFilter(state, "status", { values: [status] }), "started", started ? { from: started } : {}));
  const quick: { label: string; value: number; status: string; from?: string }[] | undefined = counts && [
    { label: "Needs approval", value: counts.waiting_approvals, status: "waiting" },
    { label: "Running now", value: Math.max(0, counts.active_runs - counts.waiting_approvals), status: "running" },
    { label: "Failed, 7 days", value: counts.failed_week, status: "failed", from: daysAgo(7) },
  ];
  return (
    <>
      <PageHeader icon={Activity} title="Runs" description="Every time a workflow ran: how it ended, how long it took and what it cost." />
      {quick && (
        <div className="mb-3 flex flex-wrap gap-2">
          {quick.map(({ label, value, status, from }) => (
            <button key={status} type="button" onClick={() => show(status, from)} className="press card-soft flex items-baseline gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] text-muted hover:bg-raised">
              <span className="text-[15px] font-semibold text-ink tabular-nums">{value}</span> {label}
            </button>
          ))}
        </div>
      )}
      {retry.dialog}
      <Card>
        {list.isLoading || !list.data ? <SkeletonRows rows={8} /> : list.data.total === 0 && !hasFilters(table.state) ? <Empty icon={Activity} title="No runs yet" action={<Link to={link("/workflows")}><Button variant="primary"><Workflow size={14} /> Open workflows</Button></Link>}>Runs appear here once a workflow starts.</Empty> : (
          <DataTable id="runs" table={table} total={list.data.total} columns={columns} rows={list.data.runs}>
            {(run: any) => (
              <tr key={run.id} className="hover:bg-raised">
                <td className="max-w-sm px-4 py-2.5">
                  <Link className="font-medium hover:underline" to={link(`/runs/${run.id}`)}>{run.workflow_name}</Link> <span className="text-faint tabular-nums">v{run.workflow_version}</span>
                  {run.status === "failed" && run.failure && <p className="mt-0.5 line-clamp-2 text-[12px] text-danger" title={run.failure}>{run.failure}</p>}
                </td>
                <td className="px-4 py-2.5"><Badge status={run.status} /></td>
                <td className="px-4 py-2.5 text-muted capitalize"><TriggerLabel kind={run.trigger_kind} /></td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted">{when(run.created_at)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted tabular-nums">{duration(run.created_at, run.finished_at)}</td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted tabular-nums">{cost(run.cost_usd, run.tokens)}</td>
                <td className="px-4 py-2.5 text-right">
                  {run.retried_as
                    ? <Link to={link(`/runs/${run.retried_as}`)}><Button className="h-8"><ArrowRight size={13} /> New run</Button></Link>
                    : canRetry(run.status) && can("runs:start") && run.workflow_id && <Button className="h-8" onClick={() => retry.start(run.id)}><RotateCcw size={13} /> Run again</Button>}
                  {run.status === "waiting" && <Link to={link(`/runs/${run.id}`)}><Button className="h-8"><Eye size={13} /> Review</Button></Link>}
                </td>
              </tr>
            )}
          </DataTable>
        )}
      </Card>
    </>
  );
}

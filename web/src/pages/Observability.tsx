import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Ban, BarChart3, CheckCircle2, CircleDollarSign, Coins, Cpu, Shield, ShieldAlert, Sparkles, Timer, Wrench, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { DataTable, useTable, useTableParams } from "../components/DataTable.tsx";
import { Badge, Card, Empty, PageHeader, Select, SkeletonRows, SkeletonStats, Heading, IconTile } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { hasFilters, type Column } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

const number = (value: unknown) => Number(value ?? 0).toLocaleString();
const seconds = (ms: unknown) => (ms === null || ms === undefined ? "—" : `${(Number(ms) / 1000).toFixed(1)} s`);
const money = (value: unknown) => (value === null || value === undefined ? "Not priced" : `$${Number(value).toFixed(2)}`);
const share = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

const countColumn = (key: string, header: string): Column => ({ key, header, kind: "number", value: (row) => Number(row[key] ?? 0), text: (row) => number(row[key]) });
const timeColumn = (key: string, header: string): Column => ({
  key, header, kind: "number", value: (row) => row[key], text: (row) => (row[key] === null || row[key] === undefined ? "" : seconds(row[key])), unit: { label: "seconds", factor: 1000 },
});
const costColumn: Column = { key: "cost_usd", header: "Cost", kind: "number", value: (row) => row.cost_usd, text: (row) => money(row.cost_usd) };

const agentColumns: Column[] = [
  { key: "agent", header: "Agent", value: (row) => row.agent },
  countColumn("model_calls", "Model calls"), countColumn("tool_calls", "Tool calls"), countColumn("errors", "Errors"), countColumn("tokens", "Tokens"),
  timeColumn("model_p95", "Slowest"), costColumn,
];
const modelColumns: Column[] = [
  { key: "name", header: "Model", value: (row) => row.name },
  countColumn("calls", "Calls"), countColumn("errors", "Errors"), countColumn("tokens", "Tokens"),
  timeColumn("p50", "Typical"), timeColumn("p95", "Slowest"), costColumn,
];
const resultName = (status: string) => (status === "ok" ? "Completed" : status === "error" ? "Failed" : "Refused");
const riskColumns: Column[] = [
  { key: "tool", header: "Tool", value: (row) => row.name, server: { sort: true } },
  { key: "agent", header: "Agent", value: (row) => row.agent, server: { sort: true } },
  { key: "result", header: "Result", value: (row) => resultName(row.status), server: { sort: true, options: ["ok", "error", "refused"].map((value) => ({ value, label: resultName(value) })) } },
  { key: "risk", header: "Risk", kind: "number", value: (row) => row.risk, text: (row) => Number(row.risk).toFixed(2), server: { sort: true } },
  { key: "when", header: "When", kind: "date", value: (row) => row.at, server: { sort: true } },
];

/** Every call in the time range worth a look, however many there are. */
function RiskyCalls({ days }: { days: number }) {
  const { path, link } = useWorkspace();
  const table = useTable("risky-calls");
  const params = useTableParams(table, riskColumns);
  const calls = useQuery({ queryKey: ["observability-calls", path, days, params], queryFn: () => api(`${path}/observability/calls?days=${days}&${params}`), refetchInterval: 30_000, placeholderData: keepPreviousData });
  return (
    <Card>
      <Heading icon={Wrench} className="px-4 pt-3 pb-2">Tool calls to look at</Heading>
      {!calls.data ? <SkeletonRows rows={3} /> : calls.data.total === 0 && !hasFilters(table.state) ? <Empty icon={CheckCircle2} title="Nothing unusual">High-risk, failed and refused calls appear here.</Empty> : (
        <DataTable id="risky-calls" table={table} total={calls.data.total} columns={riskColumns} rows={calls.data.calls}>
          {(row: any) => (
            <tr key={row.id} className="hover:bg-raised">
              <td className="px-4 py-2.5 font-mono text-[12px]"><Link className="hover:underline" to={link(`/traces/${row.trace_id}`)}>{row.name}</Link></td>
              <td className="px-4 py-2.5 text-muted">{row.agent}</td>
              <td className="px-4 py-2.5"><Badge status={row.status === "ok" ? "done" : row.status === "error" ? "failed" : "declined"}>{resultName(row.status)}</Badge></td>
              <td className="px-4 py-2.5 text-muted tabular-nums">{Number(row.risk).toFixed(2)}</td>
              <td className="px-4 py-2.5 text-muted">{ago(row.at)}</td>
            </tr>
          )}
        </DataTable>
      )}
    </Card>
  );
}

function Stat({ label, value, note, icon }: { label: string; value: string; note?: string; icon: LucideIcon }) {
  return (
    <Card className="flex items-start justify-between gap-2 p-4">
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-muted">{label}</div>
        <div className="mt-1 font-display text-[26px] leading-tight font-semibold tracking-tight tabular-nums">{value}</div>
        {note && <div className="text-[12px] text-faint">{note}</div>}
      </div>
      <IconTile icon={icon} size={30} className="brand-tile" />
    </Card>
  );
}

/** One measure over time, so one color and no legend: the title names it. */
function TokenChart({ days }: { days: { day: string; tokens: string; errors: number }[] }) {
  const highest = Math.max(1, ...days.map((d) => Number(d.tokens)));
  const total = days.reduce((sum, d) => sum + Number(d.tokens), 0);
  const peak = days.reduce((best, d) => (Number(d.tokens) > Number(best.tokens) ? d : best), days[0]!);
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <Heading icon={BarChart3}>Tokens per day</Heading>
        <span className="text-[12px] text-muted">Peak {number(peak.tokens)} on {peak.day}</span>
      </div>
      {total === 0 ? <p className="flex items-center justify-center gap-1.5 py-10 text-[13px] text-faint"><BarChart3 size={14} /> Nothing recorded yet.</p> : (
        <div role="img" aria-label={`${number(total)} tokens in ${days.length} days`} className="flex h-36 items-end gap-0.5 border-b border-line">
          {days.map((d) => {
            const tokens = Number(d.tokens);
            return (
              <div key={d.day} className="group relative flex h-full flex-1 items-end" title={`${d.day}: ${number(tokens)} tokens, ${d.errors} errors`}>
                {tokens > 0 && <div className="w-full rounded-t bg-accent group-hover:brightness-110" style={{ height: `${Math.max(2, (tokens / highest) * 100)}%` }} />}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-1 flex justify-between text-[11px] text-faint"><span>{days[0]?.day}</span><span>{days.at(-1)?.day}</span></div>
    </Card>
  );
}

export function Observability() {
  const { path, link } = useWorkspace();
  const [days, setDays] = useState(7);
  const report = useQuery({ queryKey: ["observability", path, days], queryFn: () => api(`${path}/observability?days=${days}`), refetchInterval: 30_000 });
  const data = report.data;
  return (
    <>
      <PageHeader icon={BarChart3} title="Usage and costs" description="What your agents cost, how fast they are, and what went wrong. Only measurements are stored here, never content."
        actions={<Select aria-label="Time range" className="w-36" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={1}>Last day</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></Select>} />
      {report.isLoading || !data ? <div className="space-y-3"><SkeletonStats /><Card><SkeletonRows /></Card></div> : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={Coins} label="Tokens" value={number(data.totals.tokens)} note={`${number(data.totals.model_calls)} model calls`} />
            <Stat icon={CircleDollarSign} label="Cost" value={money(data.totals.cost_usd)} note={data.totals.unpriced_calls ? `${number(data.totals.unpriced_calls)} calls have no price set` : undefined} />
            <Stat icon={Timer} label="Slowest model replies" value={seconds(data.totals.model_p95)} note={`Typical ${seconds(data.totals.model_p50)}`} />
            <Stat icon={Wrench} label="Tool failure rate" value={share(data.totals.tool_errors, data.totals.tool_calls)} note={`${number(data.totals.tool_errors)} of ${number(data.totals.tool_calls)} calls`} />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={AlertTriangle} label="Model errors" value={number(data.totals.model_errors)} />
            <Stat icon={Ban} label="Actions refused" value={number(data.totals.tool_refused)} />
            <Stat icon={ShieldAlert} label="High-risk calls" value={number(data.totals.risky_calls)} />
            <Stat icon={Shield} label="Guardrail hits" value={number(data.totals.guardrail_hits)} />
          </div>
          <TokenChart days={data.daily} />
          <Card>
            <Heading icon={Sparkles} className="px-4 pt-3 pb-2">By agent</Heading>
            {data.agents.length === 0 ? <Empty icon={Sparkles} title="No agent activity yet" /> : (
              <DataTable id="agents" columns={agentColumns} rows={data.agents} note={data.agents.length >= data.groupLimit ? `Shows the ${data.groupLimit} agents that used the most tokens.` : undefined}>
                {(row: any) => (
                  <tr key={row.agent}>
                    <td className="px-4 py-2.5 font-medium"><Link className="hover:underline" to={link(`/agents/${row.agent}`)}>{row.agent}</Link></td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.model_calls)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.tool_calls)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.errors)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.tokens)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{seconds(row.model_p95)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{money(row.cost_usd)}</td>
                  </tr>
                )}
              </DataTable>
            )}
          </Card>
          <Card>
            <Heading icon={Cpu} className="px-4 pt-3 pb-2">By model</Heading>
            {data.models.length === 0 ? <Empty icon={Cpu} title="No model calls yet" /> : (
              <DataTable id="models" columns={modelColumns} rows={data.models} note={data.models.length >= data.groupLimit ? `Shows the ${data.groupLimit} most used models.` : undefined}>
                {(row: any) => (
                  <tr key={row.name}>
                    <td className="px-4 py-2.5 font-mono text-[12px]">{row.name}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.calls)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.errors)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{number(row.tokens)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{seconds(row.p50)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{seconds(row.p95)}</td>
                    <td className="px-4 py-2.5 text-muted tabular-nums">{money(row.cost_usd)}</td>
                  </tr>
                )}
              </DataTable>
            )}
          </Card>
          <RiskyCalls days={days} />
        </div>
      )}
    </>
  );
}

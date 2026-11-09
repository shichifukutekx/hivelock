import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, Bot, Cable, CircleDot, FileText, KeyRound, MessageCircle, LifeBuoy, ScrollText, Settings, ShieldAlert, ShieldCheck, Sparkles, Users, Workflow, type LucideIcon } from "lucide-react";
import { DataTable, useTable, useTableParams } from "../components/DataTable.tsx";
import { Card, Empty, Notice, PageHeader, SkeletonRows } from "../components/ui.tsx";
import { api, when } from "../lib/api.ts";
import { capitalize, hasFilters, type Column } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

const ACTION_ICONS: Record<string, LucideIcon> = {
  agent: Sparkles, channel: MessageCircle, chat: MessageCircle, connection: Cable, file: FileText, member: Users, memory: Bot, model_provider: Bot,
  operator: ShieldCheck, run: Activity, secret: KeyRound, settings: Settings, skill: Sparkles, sso: KeyRound, support: LifeBuoy, trigger: CircleDot, workflow: Workflow,
};

const AREAS: [string, string][] = [
  ["workflow", "Workflows"], ["run", "Runs"], ["trigger", "Triggers"], ["agent", "Agents"], ["chat", "Chats"], ["skill", "Skills"], ["memory", "Agent notes"], ["connection", "Connections"], ["mcp", "MCP tools"],
  ["model_provider", "AI models"], ["file", "Files"], ["member", "People"], ["secret", "Secrets"], ["settings", "Settings"], ["template", "Templates"], ["workspace", "Workspace"], ["operator", "Hivelock staff"], ["support", "Support access"],
];

const target = (event: any) => (event.target_id ? `${event.target_type} ${event.target_id.slice(0, 16)}` : null);
/** "workflow.updated" reads as "Workflow updated". The stored name stays in the row's tooltip. */
export const actionName = (action: string) => capitalize(action.replace(/[._]/g, " "));

const columns: Column[] = [
  { key: "when", header: "When", kind: "date", value: (event) => event.at, server: { sort: true, range: true } },
  { key: "action", header: "Action", value: (event) => event.action, server: { options: AREAS.map(([value, label]) => ({ value, label })) } },
  { key: "by", header: "By" },
  { key: "target", header: "Target" },
];

export function Audit() {
  const { path } = useWorkspace();
  const table = useTable("audit");
  const params = useTableParams(table, columns);
  // Rehashes the whole log, so it runs once on opening rather than on every page.
  const chain = useQuery({ queryKey: ["audit-chain", path], queryFn: () => api(`${path}/audit?limit=1`), staleTime: 60_000 });
  const log = useQuery({ queryKey: ["audit", path, params], queryFn: () => api(`${path}/audit?${params}&verify=false`), placeholderData: keepPreviousData });
  const head = log.data?.head;
  return (
    <>
      <PageHeader icon={ScrollText} title="Audit log" description="Every important action, recorded permanently." />
      {chain.data && (
        <div className="mb-3">
          {chain.data.chainIntact
            ? <Notice tone="ok" icon={ShieldCheck}>Verified: nothing in this log has been changed.</Notice>
            : <Notice icon={ShieldAlert}>Warning: this log has been changed outside the platform.</Notice>}
        </div>
      )}
      {chain.isError && <div className="mb-3"><Notice tone="warn">The log could not be checked just now. Reload the page to try again.</Notice></div>}
      {head && <p className="mb-3 text-[12px] text-faint">Latest entry {head.seq}: <code className="font-mono break-all select-all">{head.hash}</code>. Save this somewhere outside the platform to prove later that nothing was removed.</p>}
      <Card>
        {log.isLoading || !log.data ? <SkeletonRows rows={8} /> : log.data.total === 0 && !hasFilters(table.state) ? <Empty icon={ScrollText} title="Nothing recorded yet" /> : (
          <DataTable id="audit" table={table} total={log.data.total} columns={columns} rows={log.data.events}>
            {(event: any) => {
              const Icon = ACTION_ICONS[event.action.split(".")[0]] ?? CircleDot;
              return (
                <tr key={event.id}>
                  <td className="px-4 py-2.5 whitespace-nowrap text-muted">{when(event.at)}</td>
                  <td className="px-4 py-2.5" title={event.action}><span className="inline-flex items-center gap-2"><Icon size={13} className="shrink-0 text-faint" />{actionName(event.action)}</span>{event.details?.reason && <p className="mt-0.5 max-w-md text-[12px] text-muted">{String(event.details.reason)}</p>}</td>
                  <td className="px-4 py-2.5 text-muted">{event.actor_name ?? "System"}</td>
                  <td className="px-4 py-2.5 text-muted">{target(event) ?? "—"}</td>
                </tr>
              );
            }}
          </DataTable>
        )}
      </Card>
    </>
  );
}

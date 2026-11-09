import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Check, CheckCircle2, ClipboardCheck, MessageSquare, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Pager } from "../components/DataTable.tsx";
import { Button, Card, Empty, IconTile, Notice, PageHeader, SkeletonCards } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { clampPage, loadPageSize, pageForSize, savePageSize } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

const show = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

export function Approvals() {
  const { path, link, can } = useWorkspace();
  const client = useQueryClient();
  const sizeKey = `${path}:approvals`;
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(() => loadPageSize(sizeKey));
  const list = useQuery({
    queryKey: ["approvals", path, page, size], queryFn: () => api(`${path}/approvals?limit=${size}&offset=${(page - 1) * size}`), refetchInterval: 4_000, placeholderData: keepPreviousData,
  });
  const decide = useMutation({
    mutationFn: ({ runId, nodeId, approved }: { runId: string; nodeId: string; approved: boolean }) =>
      api(`${path}/runs/${runId}/steps/${nodeId}/decision`, { body: { approved } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["approvals", path] });
      client.invalidateQueries({ queryKey: ["overview", path] });
      client.invalidateQueries({ queryKey: ["runs", path] });
    },
  });
  const total: number = list.data?.total ?? 0;
  const shownPage = clampPage(page, total, size);
  if (shownPage !== page && list.data && !list.isFetching) setPage(shownPage);
  const chats: any[] = list.data?.chats ?? [];
  const busy = (runId: string, nodeId: string) => decide.isPending && decide.variables?.runId === runId && decide.variables.nodeId === nodeId;
  return (
    <>
      <PageHeader icon={ClipboardCheck} title="Approvals" description={list.data && total + chats.length > 0 ? `${total + chats.length} waiting for a decision, oldest first.` : "Work paused for a person's decision."} />
      {decide.isError && <div className="mb-3"><Notice>{decide.error.message}</Notice></div>}
      {list.isLoading ? <SkeletonCards count={3} className="space-y-3" /> : total + chats.length === 0 ? <Card><Empty icon={CheckCircle2} title="Nothing is waiting" action={<Link to={link("/runs")}><Button><Activity size={14} /> See runs</Button></Link>}>When a workflow or a chat needs a decision, it appears here.</Empty></Card> : (
        <div className="space-y-3">
          {chats.map((item) => (
            <Card key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 items-start gap-3">
                <IconTile icon={MessageSquare} tone="warn" />
                <div className="min-w-0">
                  <p className="font-medium">{item.agent_name} wants to use {item.tool}</p>
                  <p className="mt-0.5 truncate text-[12px] text-muted">{item.title} · {ago(item.created_at)}</p>
                </div>
              </div>
              <Link to={link(`/agents/${item.agent_name}?session=${item.session_id}`)}><Button>Open the chat</Button></Link>
            </Card>
          ))}
          {list.data?.approvals.map((item: any) => (
            <Card key={`${item.run_id}-${item.node_id}`} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <IconTile icon={ShieldCheck} tone="warn" />
                  <div className="min-w-0">
                    <p className="font-medium">{item.output?.message || "This run needs a decision."}</p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      <Link to={link(`/runs/${item.run_id}`)} className="hover:underline">{item.workflow_name}</Link> · {ago(item.started_at)}
                    </p>
                  </div>
                </div>
                {can("runs:approve") ? (
                  <div className="flex gap-2">
                    <Button variant="danger" disabled={busy(item.run_id, item.node_id)} onClick={() => decide.mutate({ runId: item.run_id, nodeId: item.node_id, approved: false })}><X size={14} /> Decline</Button>
                    <Button variant="primary" disabled={busy(item.run_id, item.node_id)} onClick={() => decide.mutate({ runId: item.run_id, nodeId: item.node_id, approved: true })}><Check size={14} /> Approve</Button>
                  </div>
                ) : <p className="text-[12px] text-faint">An operator or admin decides this.</p>}
              </div>
              {Object.keys(item.input ?? {}).length > 0 && (
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 pl-11 text-[12px]">
                  {Object.entries(item.input).map(([name, value]) => (
                    <div key={name} className="flex min-w-0 max-w-full gap-1.5"><dt className="shrink-0 text-muted">{name}</dt><dd className="truncate font-medium" title={show(value)}>{show(value)}</dd></div>
                  ))}
                </dl>
              )}
            </Card>
          ))}
          <Card className="overflow-hidden empty:hidden [&:not(:has(nav))]:hidden">
            <Pager page={shownPage} total={total} size={size} label="approvals" onPage={setPage} onSize={(next) => { savePageSize(sizeKey, next); setPage(pageForSize(shownPage, size, next)); setSize(next); }} />
          </Card>
        </div>
      )}
    </>
  );
}

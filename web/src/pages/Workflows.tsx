import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleDashed, LayoutTemplate, Play, Plus, Power, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DataTable, useTable, useTableParams } from "../components/DataTable.tsx";
import { DescribeWorkflow } from "../components/DescribeWorkflow.tsx";
import { RunModal } from "../components/RunModal.tsx";
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, PageHeader, SkeletonRows } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { hasFilters, type Column } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

const columns: Column[] = [
  { key: "name", header: "Name", value: (workflow) => workflow.name, server: { sort: true } },
  { key: "status", header: "Status", value: (workflow) => (workflow.enabled ? "Live" : "Draft"), server: { sort: true, options: [{ value: "live", label: "Live" }, { value: "draft", label: "Draft" }] } },
  { key: "last", header: "Last run" },
  { key: "changed", header: "Last changed", kind: "date", value: (workflow) => workflow.updated_at, server: { sort: true } },
  { key: "actions", header: "" },
];

export function Workflows() {
  const { path, link, can } = useWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const creating = searchParams.get("new") === "1";
  const setCreating = (on: boolean) => setSearchParams(on ? { new: "1" } : {}, { replace: true });
  const [name, setName] = useState("");
  const [blank, setBlank] = useState(false);
  const [running, setRunning] = useState<string>();
  const table = useTable("workflows");
  const params = useTableParams(table, columns);
  const list = useQuery({ queryKey: ["workflows", path, params], queryFn: () => api(`${path}/workflows?${params}`), placeholderData: keepPreviousData });
  const refresh = () => client.invalidateQueries({ queryKey: ["workflows", path] });
  const create = useMutation({
    mutationFn: () => api(`${path}/workflows`, { body: { name, definition: { nodes: [{ id: "start", type: "start", config: {}, position: { x: 80, y: 200 } }], edges: [] } } }),
    onSuccess: ({ id }) => {
      refresh();
      navigate(link(`/workflows/${id}`), { replace: true });
    },
  });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api(`${path}/workflows/${id}/enabled`, { body: { enabled } }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api(`${path}/workflows/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  const button = can("workflows:write") && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={14} /> New workflow</Button>;
  const gallery = <Link to={link("/templates")}><Button><LayoutTemplate size={14} /> Browse templates</Button></Link>;
  const problem = toggle.error ?? remove.error;
  return (
    <>
      <PageHeader icon={WorkflowIcon} title="Workflows" description="Connect agents, tools and approvals into automated work." actions={<>{gallery}{button}</>} />
      {problem && <div className="mb-3"><Notice>{problem.message}</Notice></div>}
      <Card>
        {list.isLoading || !list.data ? <SkeletonRows /> : list.data.total === 0 && !hasFilters(table.state) ? (
          <Empty icon={WorkflowIcon} title="No workflows yet" action={<div className="flex flex-wrap justify-center gap-2">{gallery}{button}</div>}>Start from a ready-made template, or draw your own chain of steps. Run it by hand, on a schedule, or from a webhook.</Empty>
        ) : (
          <DataTable id="workflows" table={table} total={list.data.total} columns={columns} rows={list.data.workflows}>
            {(workflow: any) => (
              <tr key={workflow.id} className="hover:bg-raised">
                <td className="px-4 py-2.5">
                  <Link to={link(`/workflows/${workflow.id}`)} className="flex items-center gap-2 font-medium hover:underline"><WorkflowIcon size={14} className="shrink-0 text-muted" /> {workflow.name}</Link>
                </td>
                <td className="px-4 py-2.5"><Badge status={workflow.enabled ? "live" : "draft"} icon={workflow.enabled ? undefined : CircleDashed}>{workflow.enabled ? "Live" : "Draft"}</Badge></td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                  {workflow.last_run_id ? <Link to={link(`/runs/${workflow.last_run_id}`)} title="Open this run and its result" className="group inline-flex items-center gap-2"><Badge status={workflow.last_run_status} /> <span className="group-hover:underline">{ago(workflow.last_run_at)}</span> <span className="text-[12px] font-medium text-accent group-hover:underline">{workflow.last_run_status === "waiting" ? "Review" : "See result"}</span></Link> : "Not run yet"}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-muted">{ago(workflow.updated_at)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-2">
                    {can("runs:start") && <Button className="h-8" onClick={() => setRunning(workflow.id)}><Play size={13} /> Run</Button>}
                    {can("workflows:write") && <Button className="h-8" busy={toggle.isPending && toggle.variables?.id === workflow.id} onClick={() => toggle.mutate({ id: workflow.id, enabled: !workflow.enabled })}><Power size={13} /> {workflow.enabled ? "Turn off" : "Go live"}</Button>}
                    {can("workflows:write") && <button aria-label={`Delete ${workflow.name}`} className="icon-btn" onClick={() => confirm(`Delete ${workflow.name}? Its schedules and webhooks stop. Past runs stay listed.`) && remove.mutate(workflow.id)}><Trash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            )}
          </DataTable>
        )}
      </Card>
      {creating && (
        <Modal title={blank ? "New workflow" : "Describe your workflow"} onClose={() => { setCreating(false); setBlank(false); }} wide={!blank}>
          {!blank ? <DescribeWorkflow onBlank={() => setBlank(true)} onClose={() => setCreating(false)} /> : (
          <form onSubmit={submit} className="space-y-4">
            {create.isError && <Notice>{create.error.message}</Notice>}
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Check incoming RFQs" autoFocus required /></Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={create.isPending}><ArrowRight size={14} /> Create and open</Button>
            </div>
          </form>
          )}
        </Modal>
      )}
      {running && <RunModal workflowId={running} onClose={() => setRunning(undefined)} />}
    </>
  );
}

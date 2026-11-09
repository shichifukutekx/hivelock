import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addEdge, Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node } from "@xyflow/react";
import { Pencil, ArrowLeft, ArrowRight, CircleDashed, Copy, Check, Clock, History, Mail, Play, Power, Save, Trash2, Webhook, Zap } from "lucide-react";
import { useCallback, useMemo, useState, type DragEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ConnectorIcon } from "../components/ConnectorIcon.tsx";
import { RunModal } from "../components/RunModal.tsx";
import { nodeTypes, stepTitle, StepTile } from "../components/StepNode.tsx";
import { Badge, Button, Field, Input, Modal, Notice, Select, SkeletonRows, Spinner, StatusDot, Textarea } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { availableValues, makesLoop, nextStepId, STEP_BRANCHES, toCanvas, toDefinition, type CanvasEdge, type CanvasNode } from "../lib/flow.ts";
import { Locked, useLocked } from "../lib/edition.tsx";
import { web } from "../lib/extensions.ts";
import { useUnsavedWarning } from "../lib/unsaved.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { useConnectors } from "./Connections.tsx";
import { HistoryPanel } from "./History.tsx";
import { TriggerFilter } from "../components/TriggerFilter.tsx";

const PALETTE = [
  { type: "agent", hint: "An AI agent does a task" },
  { type: "connector", hint: "Use an app or service" },
  { type: "condition", hint: "Split on a value" },
  { type: "approval", hint: "Wait for a person" },
];

const defaults: Record<string, Record<string, unknown>> = {
  agent: { agent: "", prompt: "" },
  condition: { path: "", operator: "equals", value: "" },
  approval: { message: "" },
  connector: { connectionId: "", action: "", params: {} },
};

function PlaceholderHints({ values, onPick }: { values: { path: string; label: string }[]; onPick: (path: string) => void }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {values.map((value) => (
        <button key={value.path} type="button" title={`Insert {{${value.path}}}`} onClick={() => onPick(value.path)} className="max-w-full truncate rounded bg-sunken px-1.5 py-0.5 text-[11px] text-muted hover:text-ink">+ {value.label}</button>
      ))}
    </div>
  );
}

/** Draws a form from an action's description. Fields accept placeholders, so numbers stay as text here. */
function ParamForm({ schema, value, onChange, values }: { schema: any; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; values: { path: string; label: string }[] }) {
  const required: string[] = schema?.required ?? [];
  return (
    <div className="space-y-3">
      {Object.entries<any>(schema?.properties ?? {}).map(([name, field]) => {
        const label = name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) + (required.includes(name) && field.default === undefined ? " *" : "");
        const current = value[name];
        const set = (next: unknown) => {
          const copy = { ...value };
          if (next === "" || next === undefined) delete copy[name];
          else copy[name] = next;
          onChange(copy);
        };
        if (field.enum) {
          return <Field key={name} label={label}><Select value={String(current ?? field.default ?? "")} onChange={(e) => set(e.target.value)}>{field.enum.map((option: string) => <option key={option}>{option}</option>)}</Select></Field>;
        }
        if (field.type === "string" && ["text", "sql", "subject"].includes(name) || field.type === "string" && (field.maxLength ?? 0) > 1000) {
          return (
            <Field key={name} label={label}>
              <Textarea rows={4} className={name === "sql" ? "font-mono" : ""} value={String(current ?? "")} onChange={(e) => set(e.target.value)} />
              <PlaceholderHints values={values} onPick={(path) => set(`${current ?? ""}{{${path}}}`)} />
            </Field>
          );
        }
        if (field.type === "string" || field.type === "number" || field.type === "integer") {
          return (
            <Field key={name} label={label}>
              <Input value={String(current ?? "")} placeholder={field.default === undefined ? "" : String(field.default)} onChange={(e) => set(e.target.value)} />
              <PlaceholderHints values={values} onPick={(path) => set(`${current ?? ""}{{${path}}}`)} />
            </Field>
          );
        }
        return <JsonField key={name} label={label} value={current} onChange={set} />;
      })}
    </div>
  );
}

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (next: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <Field label={label} help={invalid ? "This is not valid JSON yet." : "JSON"}>
      <Textarea rows={3} className="font-mono" value={text} onChange={(e) => {
        setText(e.target.value);
        if (!e.target.value.trim()) { setInvalid(false); return onChange(undefined); }
        try {
          onChange(JSON.parse(e.target.value));
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }} />
    </Field>
  );
}

function Inspector({ node, nodes, edges, onChange, onDelete, readOnly }: { node: CanvasNode; nodes: CanvasNode[]; edges: CanvasEdge[]; onChange: (patch: Partial<CanvasNode["data"]>) => void; onDelete: () => void; readOnly: boolean }) {
  const { path, link, can } = useWorkspace();
  const { stepType, label, config } = node.data;
  const agents = useQuery({ queryKey: ["agents", path], queryFn: () => api(`${path}/agents`), enabled: stepType === "agent" });
  const connections = useQuery({ queryKey: ["connections", path], queryFn: () => api(`${path}/connections`), enabled: stepType === "connector" && can("connections:list") });
  const connectors = useConnectors();
  const values = useMemo(() => availableValues(toDefinition(nodes, edges), node.id), [nodes, edges, node.id]);
  const set = (patch: Record<string, unknown>) => onChange({ config: { ...config, ...patch } });
  const c = config as any;

  const connection = connections.data?.connections.find((item: any) => item.id === c.connectionId);
  const connector = connectors.data?.connectors.find((item: any) => item.name === connection?.connector);
  const action = connector?.actions.find((item: any) => item.id === c.action);

  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-[12px] font-medium tracking-wide text-muted uppercase">
          {connection ? <ConnectorIcon name={connection.connector} size={24} /> : <StepTile type={stepType} size={24} />} {stepTitle(stepType)}
        </span>
        {stepType !== "start" && !readOnly && <button aria-label="Delete step" onClick={onDelete} className="icon-btn"><Trash2 size={14} /></button>}
      </div>
      <Field label="Step name"><Input value={label} maxLength={120} onChange={(e) => onChange({ label: e.target.value })} /></Field>

      {stepType === "start" && <p className="text-[13px] text-muted">Runs when you start the workflow by hand, or from a schedule, webhook or mailbox. Their data is available as the run input. Mail gives input.from, input.subject, input.text and input.attachments.</p>}

      {stepType === "agent" && (
        <>
          <Field label="Agent" help={c.agent ? <Link className="inline-flex items-center gap-1 text-accent hover:underline" to={link(`/agents/${encodeURIComponent(c.agent)}`)}>Open this agent, to see or change what it does <ArrowRight size={11} /></Link> : undefined}>
            <Select value={c.agent} onChange={(e) => set({ agent: e.target.value })}>
              <option value="">Choose an agent</option>
              {agents.data?.agents.map((agent: any) => <option key={agent.name} value={agent.name}>{agent.title ?? agent.name}</option>)}
            </Select>
          </Field>
          <Field label="Task" help="Values from outside are marked as data, so an agent will not obey instructions inside them.">
            <Textarea rows={6} value={c.prompt} onChange={(e) => set({ prompt: e.target.value })} />
            <PlaceholderHints values={values} onPick={(value) => set({ prompt: `${c.prompt}{{${value}}}` })} />
          </Field>
          <p className="text-[12px] text-faint">Agents here cannot use actions that need approval. Put an approval step first.</p>
        </>
      )}

      {stepType === "condition" && (
        <>
          <Field label="Value to check" help="For example input.amount or steps.agent_1.output">
            <Input className="font-mono" value={c.path} onChange={(e) => set({ path: e.target.value })} />
            <PlaceholderHints values={values} onPick={(value) => set({ path: value })} />
          </Field>
          <Field label="Test">
            <Select value={c.operator} onChange={(e) => set({ operator: e.target.value })}>
              <option value="equals">is equal to</option>
              <option value="not_equals">is not equal to</option>
              <option value="contains">contains</option>
              <option value="greater_than">is greater than</option>
              <option value="less_than">is less than</option>
              <option value="exists">has a value</option>
            </Select>
          </Field>
          {c.operator !== "exists" && <Field label="Compare with"><Input value={String(c.value ?? "")} onChange={(e) => set({ value: e.target.value })} /></Field>}
          <p className="text-[12px] text-faint">The green dot continues when true, the red dot when false.</p>
        </>
      )}

      {stepType === "approval" && (
        <>
          <Field label="Question for the approver">
            <Textarea rows={3} value={c.message} onChange={(e) => set({ message: e.target.value })} />
            <PlaceholderHints values={values} onPick={(value) => set({ message: `${c.message}{{${value}}}` })} />
          </Field>
          <p className="text-[12px] text-faint">The green dot continues when approved. The red dot runs when declined; leave it empty to stop the run.</p>
        </>
      )}

      {stepType === "connector" && (
        <>
          {!can("connections:list") ? <Notice tone="info">Your role cannot see connections. Ask an admin to set this step.</Notice> : (
            <Field label="Connection" help={connections.data?.connections.length === 0 ? <>None yet. <Link className="underline" to={link("/connections?add=1")}>Add one in Connections</Link>.</> : undefined}>
              <span className="flex items-center gap-2">
                <ConnectorIcon name={connection?.connector} size={36} />
                <Select value={c.connectionId} onChange={(e) => set({ connectionId: e.target.value, action: "", params: {} })}>
                  <option value="">Choose a connection</option>
                  {connections.data?.connections.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </Select>
              </span>
            </Field>
          )}
          {connector && (
            <Field label="Action">
              <Select value={c.action} onChange={(e) => set({ action: e.target.value, params: {} })}>
                <option value="">Choose an action</option>
                {connector.actions.map((item: any) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </Select>
            </Field>
          )}
          {connection?.connector === "database" && c.action === "query" && (
            <Notice tone="info">Not comfortable with SQL? Use an <b>Agent</b> step instead, with an agent that can read this connection, and write in plain words what data you need. The agent writes the query each time.</Notice>
          )}
          {action && <ParamForm key={`${c.connectionId}-${c.action}`} schema={action.params} value={c.params ?? {}} onChange={(params) => set({ params })} values={values} />}
          {action?.changesData === true && <p className="text-[12px] text-faint">This action changes something outside. It runs at most once, and an approval step before it is a good idea.</p>}
        </>
      )}
    </fieldset>
  );
}

const TriggerIcon = ({ kind }: { kind: string }) => {
  const Icon = kind === "schedule" ? Clock : kind === "email" ? Mail : Webhook;
  return <Icon size={14} className="shrink-0 text-muted" />;
};

const SCHEDULES: [string, string][] = [
  ["0 9 * * 1-5", "Every weekday at 9:00"], ["0 9 * * *", "Every day at 9:00"], ["0 9 * * 1", "Every Monday at 9:00"], ["0 9 1 * *", "The 1st of each month at 9:00"], ["0 * * * *", "Every hour"], ["*/15 * * * *", "Every 15 minutes"],
];

function triggerSummary(trigger: any) {
  if (trigger.kind === "schedule") return <>{SCHEDULES.find(([cron]) => cron === trigger.cron)?.[1] ?? <code className="font-mono text-[12px]">{trigger.cron}</code>} · {trigger.timezone}</>;
  if (trigger.kind === "webhook") return `Webhook · added ${ago(trigger.created_at)}`;
  if (!trigger.folder) return "Email trigger · needs the paid package to run";
  const filters = [trigger.from_filter && `from ${trigger.from_filter}`, trigger.subject_filter && `subject has "${trigger.subject_filter}"`].filter(Boolean).join(", ");
  return `${trigger.folder} · every ${trigger.interval_minutes} min${filters ? ` · ${filters}` : ""}${trigger.last_checked_at ? ` · checked ${ago(trigger.last_checked_at)}` : ""}`;
}

function TriggersModal({ workflowId, onClose, canEdit, suggested }: { workflowId: string; onClose: () => void; canEdit: boolean; suggested?: string }) {
  const { can } = useWorkspace();
  const canMailbox = can("connections:write");
  const { path } = useWorkspace();
  const client = useQueryClient();
  const key = ["triggers", workflowId];
  const mailLocked = useLocked("emailTriggers");
  const triggers = useQuery({ queryKey: key, queryFn: () => api(`${path}/workflows/${workflowId}/triggers`) });
  const [cron, setCron] = useState(suggested ?? "0 9 * * 1-5");
  const [custom, setCustom] = useState(!!suggested && !SCHEDULES.some(([value]) => value === suggested));
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [created, setCreated] = useState<any>();
  const [copied, setCopied] = useState(false);
  const add = useMutation({
    mutationFn: (body: unknown) => api(`${path}/workflows/${workflowId}/triggers`, { body }),
    onSuccess: (result) => {
      if (result.signingSecret) setCreated(result);
      client.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`${path}/triggers/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  const [changing, setChanging] = useState<string>();
  const change = useMutation({
    mutationFn: () => api(`${path}/triggers/${changing}`, { method: "PUT", body: { cron, timezone } }),
    onSuccess: () => { setChanging(undefined); client.invalidateQueries({ queryKey: key }); },
  });
  const startChange = (trigger: any) => {
    setChanging(trigger.id);
    setCron(trigger.cron);
    setCustom(!SCHEDULES.some(([value]) => value === trigger.cron));
    setTimezone(trigger.timezone);
  };
  return (
    <Modal title="Triggers" onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-[13px] text-muted">Triggers start this workflow while it is live.</p>
        {(add.error ?? change.error) && <Notice>{(add.error ?? change.error)!.message}</Notice>}
        {created && (
          <Notice tone="warn">
            <p className="font-medium">Copy this now. The signing secret is only shown once.</p>
            <p className="mt-1 font-mono text-[12px] break-all">URL: {created.url}</p>
            <p className="mt-0.5 font-mono text-[12px] break-all">Secret: {created.signingSecret}</p>
            <button className="mt-1 inline-flex items-center gap-1 text-[12px] underline" onClick={async () => { await navigator.clipboard.writeText(created.signingSecret); setCopied(true); }}>
              {copied ? <Check size={12} /> : <Copy size={12} />} Copy secret
            </button>
          </Notice>
        )}
        {triggers.isLoading ? <SkeletonRows rows={2} /> : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {triggers.data.triggers.length === 0 && <li className="flex items-center gap-1.5 p-3 text-[13px] text-muted"><Zap size={14} /> No triggers yet.</li>}
            {triggers.data.triggers.map((trigger: any) => (
              <li key={trigger.id} className="p-3 text-[13px]">
                <div className="flex items-center gap-2">
                  <TriggerIcon kind={trigger.kind} />
                  <span className="min-w-0 flex-1 truncate">{triggerSummary(trigger)}</span>
                  {canEdit && trigger.kind === "schedule" && <button aria-label="Change schedule" className="icon-btn" onClick={() => startChange(trigger)}><Pencil size={14} /></button>}
                  {canEdit && (trigger.kind !== "email" || canMailbox) && <button aria-label="Delete trigger" className="icon-btn" onClick={() => remove.mutate(trigger.id)}><Trash2 size={14} /></button>}
                </div>
                {trigger.kind === "webhook" && <TriggerFilter trigger={trigger} canEdit={canEdit} queryKey={key} />}
                {trigger.last_error && <div className="mt-2"><Notice>{trigger.last_error}</Notice></div>}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <>
            <div className="grid gap-3 rounded-lg bg-raised p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Schedule" help={custom ? "Five fields: minute, hour, day, month, weekday." : undefined}>
                <Select aria-label="Schedule" value={custom ? "custom" : cron} onChange={(e) => { setCustom(e.target.value === "custom"); if (e.target.value !== "custom") setCron(e.target.value); }}>
                  {SCHEDULES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  <option value="custom">Custom (cron)</option>
                </Select>
                {custom && <Input aria-label="Cron schedule" className="mt-2 font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />}
              </Field>
              <Field label="Time zone"><Input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></Field>
              {changing ? (
                <span className="flex gap-2">
                  <Button variant="primary" onClick={() => change.mutate()} busy={change.isPending}><Save size={14} /> Save schedule</Button>
                  <Button onClick={() => setChanging(undefined)}>Cancel</Button>
                </span>
              ) : <Button onClick={() => add.mutate({ kind: "schedule", cron, timezone })} busy={add.isPending}><Clock size={14} /> Add schedule</Button>}
              <div className="sm:col-span-3"><Button onClick={() => add.mutate({ kind: "webhook" })}><Webhook size={14} /> Add webhook</Button></div>
            </div>
            {mailLocked || !web.EmailTriggerForm ? <Locked>Email triggers are locked. Any you already have keep working.</Locked> : canMailbox ? <web.EmailTriggerForm onAdd={(body) => add.mutate(body)} busy={add.isPending} /> : <p className="text-[12px] text-faint">Mailbox triggers are added by an admin, because their runs show whole messages.</p>}
          </>
        )}
        <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
      </div>
    </Modal>
  );
}

function Canvas({ workflow, onRestored }: { workflow: any; onRestored: () => void }) {
  const { path, link, can } = useWorkspace();
  const client = useQueryClient();
  const canEdit = can("workflows:write");
  const start = useMemo(() => toCanvas(workflow.definition), [workflow.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(start.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(start.edges as Edge[]);
  const [selectedId, setSelectedId] = useState<string>();
  const [name, setName] = useState<string>(workflow.name);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  // A template passes its schedule along after installing, so setting it is one click.
  const [params] = useSearchParams();
  const suggested = params.get("schedule") ?? undefined;
  const [modal, setModal] = useState<"run" | "triggers" | undefined>(suggested ? "triggers" : undefined);
  const [showHistory, setShowHistory] = useState(false);
  const [note, setNote] = useState("");
  const flow = useReactFlow();

  const save = useMutation({
    mutationFn: () => api(`${path}/workflows/${workflow.id}`, { method: "PUT", body: { name, description: workflow.description, note, definition: toDefinition(nodes as CanvasNode[], edges as CanvasEdge[]) } }),
    onSuccess: () => {
      setDirty(false);
      setNote("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2_000);
      client.invalidateQueries({ queryKey: ["workflows", path] });
      client.invalidateQueries({ queryKey: ["workflow", workflow.id] });
      client.invalidateQueries({ queryKey: ["versions", workflow.id] });
    },
  });
  const [enabled, setEnabled] = useState<boolean>(workflow.enabled);
  const toggle = useMutation({
    mutationFn: (next: boolean) => api(`${path}/workflows/${workflow.id}/enabled`, { body: { enabled: next } }),
    onSuccess: (result) => { setEnabled(result.enabled); client.invalidateQueries({ queryKey: ["workflows", path] }); },
  });

  useUnsavedWarning(dirty);
  const triggers = useQuery({ queryKey: ["triggers", workflow.id], queryFn: () => api(`${path}/workflows/${workflow.id}/triggers`) });

  const addStep = useCallback((type: string, position: { x: number; y: number }, after?: Node) => {
    if (!canEdit) return;
    const id = nextStepId(type, nodes.map((n) => n.id));
    setNodes((current) => [...current, { id, type: "step", position, deletable: true, data: { stepType: type, label: stepTitle(type), config: structuredClone(defaults[type]!) } }]);
    if (after) {
      // A step with two ways out continues from its "yes" side, which a person can move.
      const handle = STEP_BRANCHES[(after.data as CanvasNode["data"]).stepType]?.[0];
      setEdges((current) => addEdge({ source: after.id, target: id, sourceHandle: handle, targetHandle: null, id: `${after.id}-${handle ?? ""}-${id}`, label: handle }, current));
      setTimeout(() => flow.fitView({ maxZoom: 1, padding: 0.25, duration: 150 }), 50);
    }
    setSelectedId(id);
    setDirty(true);
  }, [canEdit, nodes, setNodes, setEdges, flow]);

  /** A click adds the step after the chosen one, or after the last step in the chain, and joins them. Dragging stays free. */
  const addNext = (type: string) => {
    const open = nodes.filter((node) => !edges.some((edge) => edge.source === node.id));
    const after = nodes.find((node) => node.id === selectedId) ?? open.at(-1) ?? nodes.at(-1);
    addStep(type, after ? { x: after.position.x + 280, y: after.position.y } : { x: 120, y: 80 }, after);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/agent-step");
    if (type) addStep(type, flow.screenToFlowPosition({ x: event.clientX - 110, y: event.clientY - 25 }));
  };

  const validConnection = useCallback((connection: Connection | Edge) => {
    if (!connection.source || !connection.target) return false;
    const duplicate = edges.some((e) => e.source === connection.source && e.target === connection.target && (e.sourceHandle ?? null) === (connection.sourceHandle ?? null));
    return !duplicate && !makesLoop(edges, connection.source, connection.target);
  }, [edges]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: `${connection.source}-${connection.sourceHandle ?? ""}-${connection.target}`, label: connection.sourceHandle ?? undefined }, current));
    setDirty(true);
  }, [setEdges]);

  const selected = nodes.find((n) => n.id === selectedId) as CanvasNode | undefined;
  const updateSelected = (patch: Partial<CanvasNode["data"]>) => {
    setNodes((current) => current.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)));
    setDirty(true);
  };
  const deleteSelected = () => {
    setNodes((current) => current.filter((n) => n.id !== selectedId));
    setEdges((current) => current.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(undefined);
    setDirty(true);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Link to={link("/workflows")} aria-label="Back to workflows" className="rounded-lg p-1.5 text-muted hover:bg-sunken hover:text-ink"><ArrowLeft size={16} /></Link>
        <input aria-label="Workflow name" value={name} disabled={!canEdit} onChange={(e) => { setName(e.target.value); setDirty(true); }} className="min-w-40 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[14px] font-semibold hover:bg-sunken focus:bg-sunken focus:outline-none sm:max-w-sm" />
        <Badge status={enabled ? "live" : "draft"} icon={enabled ? undefined : CircleDashed}>{enabled ? "Live" : "Draft"}</Badge>
        <span className="text-[12px] text-faint tabular-nums">v{workflow.version}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && <span className="enter-fade flex items-center gap-1.5 text-[12px] text-warn"><StatusDot /> Unsaved</span>}
          {saved && <span className="enter-fade flex items-center gap-1 text-[12px] text-ok"><Check size={13} /> Saved</span>}
          {canEdit && dirty && <input aria-label="Note for this version" placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className="field h-8 w-40 rounded-lg px-2 text-[13px] focus:outline-none" />}
          <Button onClick={() => setShowHistory(!showHistory)} aria-pressed={showHistory}><History size={14} /> History</Button>
          <Button onClick={() => setModal("triggers")}><Zap size={14} /> Triggers</Button>
          {canEdit && <Button onClick={() => toggle.mutate(!enabled)} busy={toggle.isPending}><Power size={14} /> {enabled ? "Turn off" : "Go live"}</Button>}
          {can("runs:start") && <Button onClick={() => setModal("run")}><Play size={14} /> Run</Button>}
          {canEdit && <Button variant="primary" onClick={() => save.mutate()} busy={save.isPending} disabled={!dirty}><Save size={14} /> Save</Button>}
        </div>
      </header>
      {save.isError && <div className="border-b border-line p-2"><Notice>{save.error.message}</Notice></div>}
      {toggle.isError && <div className="border-b border-line p-2"><Notice>{toggle.error.message}</Notice></div>}
      {enabled && triggers.data?.triggers.length === 0 && (
        <div className="border-b border-line p-2">
          <Notice tone="info">Nothing starts this workflow by itself yet. <button type="button" className="underline" onClick={() => setModal("triggers")}>Add a schedule or webhook</button>, or use Run to start it by hand.</Notice>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {canEdit && (
          <aside aria-label="Steps" className="flex shrink-0 gap-2 overflow-x-auto border-b border-line bg-surface p-2 md:w-48 md:flex-col md:border-r md:border-b-0 md:p-3">
            <p className="hidden text-[12px] font-medium text-muted md:block">Add a step</p>
            {PALETTE.map(({ type, hint }) => (
                <button key={type} draggable onDragStart={(e) => { e.dataTransfer.setData("application/agent-step", type); e.dataTransfer.effectAllowed = "move"; }}
                  onClick={() => addNext(type)}
                  className="lift card-hover flex shrink-0 cursor-grab items-center gap-2 rounded-lg border border-line p-2 text-left hover:bg-raised active:cursor-grabbing">
                  <StepTile type={type} size={28} />
                  <span><span className="block text-[13px] font-medium">{stepTitle(type)}</span><span className="hidden text-[11px] leading-tight text-muted md:block">{hint}</span></span>
                </button>
            ))}
            <p className="mt-auto hidden text-[11px] leading-snug text-faint md:block">Click to add a step after the last one, or drag it onto the canvas. Connect dots to join steps. Press Backspace to delete.</p>
          </aside>
        )}
        <div className="min-h-64 min-w-0 flex-1" onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((c) => c.type === "remove" || (c.type === "position" && c.dragging))) setDirty(true);
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type === "remove")) setDirty(true);
            }}
            onConnect={onConnect} isValidConnection={validConnection}
            onNodeClick={(_, node) => setSelectedId(node.id)} onPaneClick={() => setSelectedId(undefined)}
            nodesDraggable={canEdit} nodesConnectable={canEdit} elementsSelectable deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
            fitView fitViewOptions={{ maxZoom: 1, padding: 0.25 }} minZoom={0.3} maxZoom={1.5} snapToGrid snapGrid={[10, 10]}>
            <Background gap={20} color="var(--line-strong)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="hidden! lg:block!" nodeColor="var(--line-strong)" maskColor="color-mix(in srgb, var(--canvas) 70%, transparent)" style={{ background: "var(--surface)", border: "1px solid var(--line)" }} />
          </ReactFlow>
        </div>
        {showHistory && <HistoryPanel workflowId={workflow.id} dirty={dirty} onClose={() => setShowHistory(false)} onRestored={onRestored} />}
        {selected && !showHistory && (
          <aside aria-label="Step settings" className="enter-side max-h-[45%] shrink-0 overflow-y-auto border-t border-line bg-surface p-4 md:max-h-none md:w-80 md:border-t-0 md:border-l">
            <Inspector key={selected.id} node={selected} nodes={nodes as CanvasNode[]} edges={edges as CanvasEdge[]} onChange={updateSelected} onDelete={deleteSelected} readOnly={!canEdit} />
          </aside>
        )}
      </div>
      {modal === "run" && <RunModal workflowId={workflow.id} definition={toDefinition(nodes as CanvasNode[], edges as CanvasEdge[])} beforeRun={dirty && canEdit ? () => save.mutateAsync() : undefined} onClose={() => setModal(undefined)} />}
      {modal === "triggers" && <TriggersModal workflowId={workflow.id} canEdit={canEdit} suggested={suggested} onClose={() => setModal(undefined)} />}
    </div>
  );
}

export function Builder() {
  const { workflowId } = useParams();
  const { path } = useWorkspace();
  const client = useQueryClient();
  // The canvas keeps its own working copy, so a restore starts a fresh one.
  const [revision, setRevision] = useState(0);
  const workflow = useQuery({ queryKey: ["workflow", workflowId], queryFn: () => api(`${path}/workflows/${workflowId}`), staleTime: 0, refetchOnMount: "always" });
  if (workflow.isLoading) return <Spinner />;
  if (workflow.isError) return <div className="p-6"><Notice>That workflow could not be opened.</Notice></div>;
  const onRestored = async () => {
    await workflow.refetch();
    client.invalidateQueries({ queryKey: ["workflows", path] });
    setRevision(revision + 1);
  };
  return <ReactFlowProvider key={`${workflowId}:${revision}`}><Canvas workflow={workflow.data.workflow} onRestored={onRestored} /></ReactFlowProvider>;
}

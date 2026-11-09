import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Bot, Workflow, Brain, Cable, FileSearch, FlaskConical, FolderOpen, LayoutTemplate, MessageSquare, Plus, PowerOff, Save, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ConnectorIcon } from "../components/ConnectorIcon.tsx";
import { Badge, Button, Card, cardHover, Empty, Field, IconTile, Input, Modal, Notice, PageHeader, Select, SkeletonCards, SkeletonRows, Textarea, Heading } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { useConnectors } from "./Connections.tsx";

export interface AgentForm {
  name: string;
  description: string;
  title?: string;
  guide?: string;
  starters?: string[];
  model: string;
  instructions: string;
  server?: string;
  tools?: string[];
  connections?: { connectionId: string; action: string }[];
  mcp?: { connectionId: string; tool: string }[];
  skills?: string[];
  memory?: boolean;
  knowledge?: boolean;
}

const blank: AgentForm = { name: "", description: "", model: "main", instructions: "", tools: [], connections: [], mcp: [] };

function CapabilityPicker({ value, onChange }: { value: AgentForm; onChange: (next: AgentForm) => void }) {
  const { path, can } = useWorkspace();
  const available = useQuery({ queryKey: ["capabilities", path], queryFn: () => api(`${path}/capabilities`), enabled: can("connections:list") });
  const skills = useQuery({ queryKey: ["skills", path], queryFn: () => api(`${path}/skills`) });
  const connectors = useConnectors();
  if (available.isLoading) return <SkeletonRows rows={3} />;
  const data = available.data;
  const serviceName = (label: string) => connectors.data?.connectors.find((item: any) => item.label === label)?.name;
  const fileTools: string[] = data?.files ?? [];
  const tools = value.tools ?? [];
  const links = value.connections ?? [];
  const mcp = value.mcp ?? [];
  const toggleFile = (tool: string, on: boolean) => {
    const next = on ? [...tools, tool] : tools.filter((t) => t !== tool);
    onChange({ ...value, tools: next, server: next.length ? "files" : undefined });
  };
  const hasLink = (connectionId: string, action: string) => links.some((l) => l.connectionId === connectionId && l.action === action);
  const hasMcp = (connectionId: string, tool: string) => mcp.some((l) => l.connectionId === connectionId && l.tool === tool);
  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted"><FolderOpen size={13} /> Workspace files</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {fileTools.map((tool) => (
            <label key={tool} className="flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" checked={tools.includes(tool)} onChange={(e) => toggleFile(tool, e.target.checked)} />
              {{ list_files: "See file names", read_file: "Read files", save_file: "Save new files (asks first)" }[tool] ?? tool}
            </label>
          ))}
        </div>
      </fieldset>
      {data?.connections.map((connection: any) => (
        <fieldset key={connection.connectionId}>
          <legend className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted"><ConnectorIcon name={serviceName(connection.service)} size={20} /> {connection.name} · {connection.service}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {connection.actions.map(({ action, label, changesData }: any) => (
              <label key={action} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={hasLink(connection.connectionId, action)} onChange={(e) => onChange({
                  ...value,
                  connections: e.target.checked ? [...links, { connectionId: connection.connectionId, action }] : links.filter((l) => !(l.connectionId === connection.connectionId && l.action === action)),
                })} />
                {label}{changesData ? " (asks first)" : ""}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {data?.mcp.length > 0 && (
        <fieldset>
          <legend className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted"><ConnectorIcon name="mcp" size={20} /> Reviewed MCP tools (each use asks first)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {data.mcp.map(({ connectionId, tool }: any) => (
              <label key={`${connectionId}-${tool}`} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={hasMcp(connectionId, tool)} onChange={(e) => onChange({
                  ...value,
                  mcp: e.target.checked ? [...mcp, { connectionId, tool }] : mcp.filter((l) => !(l.connectionId === connectionId && l.tool === tool)),
                })} />
                <span className="font-mono text-[12px]">{tool}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {data && data.connections.length === 0 && data.mcp.length === 0 && <p className="text-[12px] text-faint">Add a connection to let agents use outside apps and services.</p>}
      {(skills.data?.skills.length ?? 0) > 0 && (
        <fieldset>
          <legend className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-muted"><BookOpen size={13} /> Skills</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {skills.data.skills.map((skill: any) => (
              <label key={skill.name} title={skill.description} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" checked={(value.skills ?? []).includes(skill.name)} onChange={(e) => onChange({ ...value, skills: e.target.checked ? [...(value.skills ?? []), skill.name] : (value.skills ?? []).filter((s) => s !== skill.name) })} />
                {skill.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={!!value.knowledge} onChange={(e) => onChange({ ...value, knowledge: e.target.checked })} />
        <FileSearch size={13} className="text-muted" /> Search this workspace's documents
      </label>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={!!value.memory} onChange={(e) => onChange({ ...value, memory: e.target.checked })} />
        <Brain size={13} className="text-muted" /> Keep notes between chats (asks first)
      </label>
    </div>
  );
}

export function AgentEditor({ initial, editing, onClose }: { initial: AgentForm; editing?: boolean; onClose: () => void }) {
  const { path, link } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<AgentForm>(initial);
  const save = useMutation({
    mutationFn: () => api(editing ? `${path}/agents/${form.name}` : `${path}/agents`, {
      method: editing ? "PUT" : "POST",
      body: { ...form, title: form.title?.trim() || undefined, guide: form.guide?.trim() || undefined, starters: (form.starters ?? []).map((line) => line.trim()).filter(Boolean) },
    }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["agents", path] });
      client.invalidateQueries({ queryKey: ["agent", form.name] });
      onClose();
      if (!editing) navigate(link(`/agents/${form.name}`));
    },
  });
  const set = (key: keyof AgentForm) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Modal title={editing ? `Edit ${form.name}` : "Review your agent"} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        {save.isError && <Notice>{save.error.message}</Notice>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" help="The name people see, such as Audit preparation."><Input value={form.title ?? ""} onChange={set("title")} maxLength={80} placeholder="Audit preparation" /></Field>
          <Field label="Name" help="Its id: lowercase words joined by hyphens."><Input value={form.name} onChange={set("name")} disabled={editing} pattern="[a-z][a-z0-9\-]{2,39}" required autoFocus={!editing} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Model">
            <Select value={form.model} onChange={set("model")}>
              <option value="main">Main: reasoning and tools</option>
              <option value="fast">Fast: simple, high-volume work</option>
              <option value="coding">Coding: writing code</option>
            </Select>
          </Field>
          <Field label="What it does"><Input value={form.description} onChange={set("description")} maxLength={300} required /></Field>
        </div>
        <Field label="How to use it" help="Shown when someone starts a chat, for example what to upload first."><Input value={form.guide ?? ""} onChange={set("guide")} maxLength={500} /></Field>
        <Field label="Example questions" help="Up to four, one per line. They appear as buttons that start a chat.">
          <Textarea rows={3} value={(form.starters ?? []).join("\n")} onChange={(e) => setForm({ ...form, starters: e.target.value.split("\n").map((line) => line.slice(0, 200)).filter((line, index, all) => line.trim() || index === all.length - 1).slice(0, 4) })} />
        </Field>
        <Field label="Instructions" help="This is the agent's job description. Say what it does, how, and what to do when it is unsure."><Textarea rows={8} value={form.instructions} onChange={set("instructions")} maxLength={8000} required /></Field>
        <div>
          <h3 className="mb-2 text-[13px] font-medium">What it can use</h3>
          <CapabilityPicker value={form} onChange={setForm} />
        </div>
        <p className="text-[12px] text-faint">The platform sets the limits and safety rules. Agents never see credentials, and cannot create or manage other agents.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={save.isPending}>{editing ? <Save size={14} /> : <Plus size={14} />} {editing ? "Save changes" : "Create agent"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function Describe({ onDraft, onClose }: { onDraft: (draft: AgentForm) => void; onClose: () => void }) {
  const { path } = useWorkspace();
  const [description, setDescription] = useState("");
  const draft = useMutation({
    mutationFn: () => api(`${path}/agents/draft`, { body: { description } }),
    onSuccess: (result) => onDraft({ ...blank, ...result.draft }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    draft.mutate();
  };
  return (
    <Modal title="What should this agent do?" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {draft.isError && <Notice>{draft.error.message}</Notice>}
        <Field label="Describe it in your own words" help="Say what it works on, what it produces, and which services it should use. You review everything before it is created.">
          <Textarea rows={6} autoFocus value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Reads incoming supplier emails, pulls out the order number and delivery date, and drafts a reply for me to check." minLength={10} required />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="text-[13px] text-muted hover:text-ink" onClick={() => onDraft(blank)}>Start blank</button>
          <Button type="submit" variant="primary" busy={draft.isPending}><Wand2 size={14} /> Draft agent</Button>
        </div>
      </form>
    </Modal>
  );
}

function Skills() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const [editing, setEditing] = useState<{ name: string; description: string; instructions: string; existing?: boolean }>();
  const list = useQuery({ queryKey: ["skills", path], queryFn: () => api(`${path}/skills`) });
  const refresh = () => client.invalidateQueries({ queryKey: ["skills", path] });
  const save = useMutation({
    mutationFn: () => api(`${path}/skills/${editing!.name}`, { method: "PUT", body: { description: editing!.description, instructions: editing!.instructions } }),
    onSuccess: () => { refresh(); setEditing(undefined); },
  });
  const remove = useMutation({ mutationFn: (name: string) => api(`${path}/skills/${name}`, { method: "DELETE" }), onSuccess: refresh });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <Heading icon={BookOpen}>Skills</Heading>
          <p className="text-[13px] text-muted">Reusable know-how that any agent in this workspace can follow.</p>
        </div>
        {can("agents:write") && <Button onClick={() => setEditing({ name: "", description: "", instructions: "" })}><Plus size={14} /> New skill</Button>}
      </div>
      {list.isLoading && <SkeletonCards count={2} />}
      {list.data?.skills.length === 0 && (
        <Card><Empty icon={BookOpen} title="No skills yet" action={can("agents:write") && <Button onClick={() => setEditing({ name: "", description: "", instructions: "" })}><Plus size={14} /> New skill</Button>}>Write down know-how once, and any agent here can follow it.</Empty></Card>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {list.data?.skills.map((skill: any) => (
          <Card key={skill.name} className="p-3">
            <div className="flex items-start justify-between gap-2">
              <button className="min-w-0 truncate text-left text-[13px] font-medium hover:underline" disabled={!can("agents:write")} onClick={() => setEditing({ ...skill, existing: true })}>{skill.name}</button>
              {can("agents:write") && <button aria-label={`Delete ${skill.name}`} className="icon-btn" onClick={() => confirm(`Delete ${skill.name}?`) && remove.mutate(skill.name)}><Trash2 size={14} /></button>}
            </div>
            <p className="mt-0.5 text-[12px] text-muted">{skill.description}</p>
          </Card>
        ))}
      </div>
      {editing && (
        <Modal title={editing.existing ? `Edit ${editing.name}` : "New skill"} onClose={() => setEditing(undefined)} wide>
          <form onSubmit={submit} className="space-y-3">
            {save.isError && <Notice>{save.error.message}</Notice>}
            <Field label="Name"><Input value={editing.name} disabled={editing.existing} pattern="[a-z][a-z0-9\-]{2,39}" onChange={(e) => setEditing({ ...editing, name: e.target.value })} required autoFocus /></Field>
            <Field label="What it is for"><Input value={editing.description} maxLength={300} onChange={(e) => setEditing({ ...editing, description: e.target.value })} required /></Field>
            <Field label="Instructions"><Textarea rows={8} maxLength={8000} value={editing.instructions} onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} required /></Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setEditing(undefined)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={save.isPending}><Save size={14} /> Save skill</Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

/** What an agent can reach, in a few words, so people know what it needs before they open it. */
function uses(agent: any) {
  return [
    agent.workflows?.length > 0 && { icon: Workflow, label: agent.workflows.length === 1 ? "In 1 workflow" : `In ${agent.workflows.length} workflows` },
    agent.connected && { icon: Cable, label: "Connected apps" },
    agent.knowledge && { icon: FileSearch, label: "Your documents" },
    agent.files && { icon: FolderOpen, label: "Files" },
  ].filter(Boolean) as { icon: typeof Cable; label: string }[];
}

/** Whether live workflows wait for this agent's tests after its latest change. */
function GateBadge({ gate }: { gate?: { state: string; message: string } | null }) {
  if (!gate || gate.state === "clear") return null;
  const [status, label] = ({ untested: ["waiting", "Untested"], testing: ["running", "Testing"], failed: ["failed", "Tests failed"], overridden: ["changed", "Used untested"] } as Record<string, [string, string]>)[gate.state] ?? ["pending", gate.state];
  return <span title={gate.message}><Badge status={status} icon={status === "running" ? undefined : FlaskConical}>{label}</Badge></span>;
}

function AgentCard({ agent, onDelete }: { agent: any; onDelete?: () => void }) {
  const { link } = useWorkspace();
  return (
    <Link to={link(`/agents/${agent.name}`)} className="group block">
      <Card className={`flex h-full flex-col p-4 ${cardHover}`}>
        <div className="flex items-start gap-2.5">
          <IconTile icon={agent.builtIn ? Bot : Sparkles} size={30} />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[14px] leading-snug font-medium">{agent.title}{agent.off && <Badge status="failed" icon={PowerOff}>Off</Badge>}<GateBadge gate={agent.gate} /></h2>
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted">{agent.description}</p>
          </div>
          {onDelete && <button type="button" aria-label={`Delete ${agent.title}`} title="Delete" className="icon-btn -mt-1 -mr-1 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={(event) => { event.preventDefault(); onDelete(); }}><Trash2 size={14} /></button>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          {uses(agent).map(({ icon: Icon, label }) => <span key={label} className="inline-flex items-center gap-1"><Icon size={12} /> {label}</span>)}
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-accent">Open chat <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" /></span>
        </div>
      </Card>
    </Link>
  );
}

export function Agents() {
  const { path, can, link } = useWorkspace();
  const client = useQueryClient();
  const [describing, setDescribing] = useState(false);
  const [draft, setDraft] = useState<AgentForm>();
  const list = useQuery({ queryKey: ["agents", path], queryFn: () => api(`${path}/agents`) });
  const [query, setQuery] = useState("");
  const all: any[] = list.data?.agents ?? [];
  const own = all.filter((agent) => !agent.builtIn).sort((a, b) => a.title.localeCompare(b.title));
  const forWorkflows = (agent: any) => !!agent.workflow && agent.workflows?.length > 0;
  const chatting = own.filter((agent) => !forWorkflows(agent));
  const steps = own.filter(forWorkflows);
  const builtIn = all.filter((agent) => agent.builtIn);
  const shown = (agents: any[]) => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return agents.filter((agent) => words.every((word) => `${agent.title} ${agent.description} ${agent.name}`.toLowerCase().includes(word)));
  };
  const remove = useMutation({
    mutationFn: (name: string) => api(`${path}/agents/${name}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["agents", path] }),
  });
  return (
    <>
      <PageHeader icon={Sparkles} title="Agents" description="Create an agent for any job, then chat with it or use it in a workflow."
        actions={<><Link to={link("/templates")}><Button><LayoutTemplate size={14} /> Browse templates</Button></Link>{can("agents:write") && <Button variant="primary" onClick={() => setDescribing(true)}><Plus size={14} /> New agent</Button>}</>} />
      {list.data?.agents.every((agent: any) => agent.builtIn) && (
        <Card className="mb-3">
          <Empty icon={Sparkles} title="No agents of your own yet" action={<Link to={link("/templates")}><Button variant="primary"><LayoutTemplate size={14} /> Browse templates</Button></Link>}>
            Start from a ready-made agent for sales, support, finance and more, or describe your own.
          </Empty>
        </Card>
      )}
      {list.isLoading ? <SkeletonCards count={6} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" /> : (
        <>
          {own.length > 6 && (
            <div className="relative mb-3 max-w-md">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
              <Input aria-label="Search agents" placeholder="Search agents" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          {own.length > 0 && shown(own).length === 0 && <p className="mb-3 text-[13px] text-muted">No agent matches that. Try fewer words.</p>}
          {chatting.length > 0 && steps.length > 0 && <Heading icon={MessageSquare} className="mb-1">Chat with these</Heading>}
          {chatting.length > 0 && steps.length > 0 && <p className="mb-3 text-[13px] text-muted">Open one and ask in your own words.</p>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shown(chatting).map((agent: any) => <AgentCard key={agent.name} agent={agent} onDelete={can("agents:write") ? () => confirm(`Delete ${agent.title}?`) && remove.mutate(agent.name) : undefined} />)}
          </div>
          {steps.length > 0 && shown(steps).length > 0 && (
            <section className="mt-8">
              <Heading icon={Workflow} className="mb-1">Used in workflows</Heading>
              <p className="mb-3 text-[13px] text-muted">Each does one step of a workflow, and runs when that workflow runs. You can still chat with one to try it.</p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {shown(steps).map((agent: any) => <AgentCard key={agent.name} agent={agent} onDelete={can("agents:write") ? () => confirm(`Delete ${agent.title}?`) && remove.mutate(agent.name) : undefined} />)}
              </div>
            </section>
          )}
          {builtIn.length > 0 && (
            <section className="mt-8">
              <Heading icon={Bot} className="mb-1">Built-in agents</Heading>
              <p className="mb-3 text-[13px] text-muted">General helpers that come with the platform.</p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {shown(builtIn).map((agent: any) => <AgentCard key={agent.name} agent={agent} />)}
              </div>
            </section>
          )}
        </>
      )}
      <Skills />
      {describing && <Describe onClose={() => setDescribing(false)} onDraft={(next) => { setDescribing(false); setDraft(next); }} />}
      {draft && <AgentEditor initial={draft} onClose={() => setDraft(undefined)} />}
    </>
  );
}

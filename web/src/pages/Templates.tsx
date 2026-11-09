import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpCircle, Bot, Cable, Copy, Download, FileText, LayoutTemplate, ListOrdered, Pencil, Play, Save, Search, SearchX, ShieldCheck, Trash2, Workflow, type LucideIcon } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ConnectorIcon } from "../components/ConnectorIcon.tsx";
import { StepTile } from "../components/StepNode.tsx";
import { Badge, Button, Card, cardHover, Code, Empty, Field, Input, Modal, Notice, PageHeader, Select, SkeletonCards, SkeletonRows, Textarea, Heading } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { Locked } from "../lib/edition.tsx";
import { useWorkspace } from "../lib/workspace.ts";

const useConnections = () => {
  const { path, can } = useWorkspace();
  return useQuery({ queryKey: ["connections", path], queryFn: () => api(`${path}/connections`), enabled: can("connections:list") });
};

const DIFFICULTY: Record<string, string> = { starter: "Starter", intermediate: "Intermediate", advanced: "Advanced" };
const STARTS: Record<string, string> = {
  chat: "Runs when someone opens a chat", channel: "Runs on a linked channel", manual: "Runs when you start it", webhook: "Runs from a webhook", schedule: "Runs on a schedule", email: "Runs when mail arrives",
};

function TemplateCard({ template, connected }: { template: any; connected?: Set<string> }) {
  const { link } = useWorkspace();
  const missing = connected ? template.connectors.filter((item: any) => !connected.has(item.name)) : [];
  const Kind = template.builds === "agent" ? Bot : Workflow;
  return (
    <Link to={link(`/templates/${template.id}`)} className="block">
      <Card className={`flex h-full flex-col p-4 ${cardHover}`}>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <Kind size={13} className="shrink-0 text-accent" />
          <span className="truncate">{template.categoryLabel}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{template.role}</span>
        </div>
        <h2 className="mt-1 text-[14px] font-medium">{template.name}</h2>
        <p className="mt-1 flex-1 text-[13px] leading-snug text-muted">{template.outcome}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {template.custom && <Badge status="live">Yours</Badge>}
          <Badge status="draft">{DIFFICULTY[template.difficulty]}</Badge>
          {template.needsUpgrade?.length > 0 && <Badge status="waiting" icon={ArrowUpCircle}>Needs an upgrade</Badge>}
          {template.approvalCount > 0 && <Badge status="waiting" icon={ShieldCheck}>{template.approvalCount === 1 ? "1 approval" : `${template.approvalCount} approvals`}</Badge>}
          {template.connectors.map((item: any) => <span key={item.name} className={`inline-flex items-center gap-1 text-[11px] ${connected && !connected.has(item.name) ? "text-warn" : "text-muted"}`}><ConnectorIcon name={item.name} size={20} /> {item.label}</span>)}
        </div>
        {missing.length > 0 && <p className="mt-2 text-[12px] text-warn">Needs {missing.map((item: any) => item.label).join(", ")}</p>}
      </Card>
    </Link>
  );
}

export function Templates() {
  const { path } = useWorkspace();
  const catalogue = useQuery({ queryKey: ["templates", path], queryFn: () => api(`${path}/templates`), staleTime: 300_000 });
  const connections = useConnections();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [role, setRole] = useState("");
  const connected = connections.data && new Set<string>(connections.data.connections.map((item: any) => item.connector));
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (catalogue.data?.templates ?? []).filter((template: any) => {
      const text = [template.name, template.outcome, template.role, template.categoryLabel, ...template.connectors.map((item: any) => item.label)].join(" ").toLowerCase();
      return (!category || template.category === category) && (!role || template.role === role) && words.every((word) => text.includes(word));
    });
  }, [catalogue.data, query, category, role]);
  const clear = () => { setQuery(""); setCategory(""); setRole(""); };

  return (
    <>
      <PageHeader icon={LayoutTemplate} title="Templates" description="Ready-made agents and workflows. Each one installs as a draft, and nothing runs until a person turns it on." />
      {catalogue.isError && <Notice>{catalogue.error.message}</Notice>}
      {catalogue.isLoading ? <SkeletonCards count={9} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" /> : catalogue.data && (
        <>
          <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_12rem_12rem]">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
              <Input aria-label="Search templates" placeholder="Search templates" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {catalogue.data.categories.map((item: any) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </Select>
            <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {catalogue.data.roles.map((item: string) => <option key={item} value={item}>{item}</option>)}
            </Select>
          </div>
          <p role="status" className="mb-3 text-[12px] text-muted">{shown.length} of {catalogue.data.templates.length} templates</p>
          {shown.length === 0 ? (
            <Card><Empty icon={SearchX} title="No templates match" action={<Button onClick={clear}>Clear filters</Button>}>Try fewer words, or another category or role.</Empty></Card>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((template: any) => <TemplateCard key={template.id} template={template} connected={connected} />)}
            </div>
          )}
        </>
      )}
    </>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <section>
      <Heading icon={Icon} className="mb-2">{title}</Heading>
      {children}
    </section>
  );
}

/** The API names a step's connector by its label, so this finds its icon through the template's own connections. */
const connectorNamed = (template: any, label?: string) => (label === "Workspace files" ? "files" : template.connections.find((slot: any) => slot.label === label)?.connector);

function Steps({ steps, template }: { steps: any[]; template: any }) {
  return (
    <ol className="divide-y divide-line rounded-lg border border-line">
      {steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px]">
            <span className="w-4 shrink-0 text-right text-[11px] text-faint tabular-nums">{index + 1}</span>
            {step.connector ? <ConnectorIcon name={connectorNamed(template, step.connector)} size={24} /> : <StepTile type={step.type} size={24} />}
            <span className="min-w-0 flex-1">{step.label}{step.connector && <span className="text-faint"> · {step.connector}</span>}</span>
            {step.type === "approval" && <Badge status="waiting" icon={ShieldCheck}>A person decides</Badge>}
            {step.changes && <Badge status="changed">Changes something</Badge>}
          </li>
      ))}
    </ol>
  );
}

function Install({ template }: { template: any }) {
  const { path, link, can } = useWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const connections = useConnections();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const owned: any[] = connections.data?.connections ?? [];
  const options = (connector: string) => owned.filter((item) => item.connector === connector);
  const choice = (slot: any) => picked[slot.key] ?? options(slot.connector)[0]?.id ?? "";
  const missing = connections.data ? template.connections.filter((slot: any) => !options(slot.connector).length) : [];
  const allowed = (template.agent ? can("agents:write") : true) && (template.steps ? can("workflows:write") : true);

  const install = useMutation({
    mutationFn: () => api(`${path}/templates/${template.id}/install`, {
      body: {
        answers: Object.fromEntries(template.questions.flatMap((question: any) => {
          const value = answers[question.key];
          return value === undefined || value === "" ? [] : [[question.key, value]];
        })),
        connections: Object.fromEntries(template.connections.map((slot: any) => [slot.key, choice(slot)])),
      },
    }),
    onSuccess: ({ agent, workflowId }) => {
      client.invalidateQueries({ queryKey: ["agents", path] });
      client.invalidateQueries({ queryKey: ["workflows", path] });
      const schedule = template.run.cron ? `?schedule=${encodeURIComponent(template.run.cron)}` : "";
      navigate(link(workflowId ? `/workflows/${workflowId}${schedule}` : `/agents/${agent}`));
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    install.mutate();
  };

  if (!allowed) return <Notice tone="info">Your role can read templates. A builder or admin can install them.</Notice>;
  return (
    <form onSubmit={submit} className="space-y-3">
      {install.isError && <Notice>{install.error.message}</Notice>}
      {missing.length > 0 && (
        <Notice tone="warn">
          <p className="font-medium">Connect {[...new Set(missing.map((slot: any) => slot.label))].join(", ")} first.</p>
          {can("connections:write")
            ? <Link to={link(`/connections?add=${missing[0].connector}&back=${encodeURIComponent(link(`/templates/${template.id}`))}`)} className="mt-1 inline-flex items-center gap-1 underline"><Cable size={13} /> Connect {missing[0].label}</Link>
            : <p className="mt-1 inline-flex items-center gap-1"><Cable size={13} /> Ask an admin to add it in Connections.</p>}
        </Notice>
      )}
      {template.connections.map((slot: any) => options(slot.connector).length > 0 && (
        <Field key={slot.key} label={slot.label} help={slot.purpose}>
          <span className="flex items-center gap-2">
            <ConnectorIcon name={slot.connector} size={36} />
            <Select value={choice(slot)} onChange={(e) => setPicked({ ...picked, [slot.key]: e.target.value })}>
              {options(slot.connector).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </span>
        </Field>
      ))}
      {template.questions.map((question: any) => {
        const value = answers[question.key] ?? String(question.default ?? "");
        const set = (next: string) => setAnswers({ ...answers, [question.key]: next });
        return (
          <Field key={question.key} label={question.label} help={question.help}>
            {question.kind === "choice" ? (
              <Select value={value} onChange={(e) => set(e.target.value)}>{question.options.map((option: string) => <option key={option}>{option}</option>)}</Select>
            ) : (
              <Input
                type={question.kind === "number" ? "number" : question.kind === "email" ? "email" : "text"}
                min={question.min} max={question.max} maxLength={question.kind === "number" ? undefined : 200}
                required={!question.optional && question.default === undefined} value={value} onChange={(e) => set(e.target.value)}
              />
            )}
          </Field>
        );
      })}
      <Button type="submit" variant="primary" className="w-full" busy={install.isPending} disabled={missing.length > 0}><Download size={14} /> Install as a draft</Button>
      <p className="text-[12px] leading-snug text-faint">{template.steps ? template.run.cron ? "It installs switched off. You confirm the schedule next, and it runs once you turn it on." : "The workflow stays off, with no trigger or schedule, until someone turns it on." : "The agent only acts when someone chats with it, and it asks before changing anything."}</p>
    </form>
  );
}

const SCHEDULE_CHOICES: [string, string][] = [
  ["0 7 * * 1-5", "Weekdays at 07:00"], ["30 7 * * 1-5", "Weekdays at 07:30"], ["0 8 * * 1-5", "Weekdays at 08:00"], ["0 9 * * 1-5", "Weekdays at 09:00"],
  ["0 7 * * *", "Every day at 07:00"], ["0 7 * * 1", "Mondays at 07:00"], ["0 15 * * 5", "Fridays at 15:00"], ["0 8 1 * *", "The 1st of each month at 08:00"],
];

/** Changes the words of a private copy. Steps, connections and approvals stay the original's, so a copy is as safe as the template it came from. */
function CustomiseDialog({ template, onClose }: { template: any; onClose: () => void }) {
  const { path, link } = useWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const editing = !!template.custom;
  const [name, setName] = useState(editing ? template.name : `${template.name} (custom)`);
  const [outcome, setOutcome] = useState(template.outcome);
  const [description, setDescription] = useState(template.description);
  const [instructions, setInstructions] = useState<string>(template.agent?.instructions ?? "");
  const [prompts, setPrompts] = useState<Record<string, string>>(Object.fromEntries(template.editable.prompts.map((step: any) => [step.id, step.prompt])));
  const [cron, setCron] = useState<string>(template.run.cron ?? "");
  const [manual, setManual] = useState(!SCHEDULE_CHOICES.some(([value]) => value === template.run.cron));
  const save = useMutation({
    mutationFn: (asNew: boolean) => {
      const changed = Object.fromEntries(template.editable.prompts.flatMap((step: any) => (prompts[step.id] !== step.prompt || editing ? [[step.id, prompts[step.id]]] : [])));
      const body = {
        name, outcome, description, prompts: changed,
        ...(template.agent && (editing || instructions !== template.agent.instructions) ? { instructions } : {}),
        ...(template.run.cron && (editing || cron !== template.run.cron) ? { cron } : {}),
      };
      return asNew ? api(`${path}/templates/${template.id}/customise`, { body }) : api(`${path}/templates/${template.id}`, { method: "PUT", body });
    },
    onSuccess: (result) => {
      client.invalidateQueries({ queryKey: ["templates", path] });
      client.invalidateQueries({ queryKey: ["template", path] });
      if (result.id) navigate(link(`/templates/${result.id}`));
      onClose();
    },
  });
  return (
    <Modal title={editing ? "Edit your template" : "Customise this template"} wide onClose={onClose}>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate(!editing); }}>
        <p className="text-[13px] text-muted">Your copy is saved in this workspace. Its steps, connections and approvals stay the same, so what needs a person's approval does not change.</p>
        {save.isError && <Notice>{save.error.message}</Notice>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
        <Field label="What a person gets" help="One line."><Input value={outcome} onChange={(e) => setOutcome(e.target.value)} maxLength={160} required /></Field>
        <Field label="What it does"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} required /></Field>
        {template.run.cron && (
          <Field label="Schedule" help="Used when you add the trigger after installing. Times follow the time zone you choose there.">
            <Select value={manual ? "custom" : cron} onChange={(e) => { setManual(e.target.value === "custom"); if (e.target.value !== "custom") setCron(e.target.value); }}>
              {SCHEDULE_CHOICES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              <option value="custom">Custom (cron)</option>
            </Select>
            {manual && <Input aria-label="Cron schedule" className="mt-2 font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="30 7 * * 1-5" spellCheck={false} />}
          </Field>
        )}
        {template.agent && <Field label="Agent instructions" help="Rules on using only real facts and treating outside content as data are still added at install."><Textarea rows={10} className="font-mono text-[12px]" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={6000} /></Field>}
        {template.editable.prompts.map((step: any) => (
          <Field key={step.id} label={`Step prompt: ${step.label}`} help="Keep the {{...}} values. They hold the data from earlier steps.">
            <Textarea rows={3} className="font-mono text-[12px]" value={prompts[step.id]} onChange={(e) => setPrompts({ ...prompts, [step.id]: e.target.value })} maxLength={4000} />
          </Field>
        ))}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {editing && <Button busy={save.isPending} onClick={() => save.mutate(true)}><Copy size={14} /> Save as new</Button>}
          <Button type="submit" variant="primary" busy={save.isPending}><Save size={14} /> {editing ? "Save changes" : "Save as new template"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TemplateDetail() {
  const { templateId } = useParams();
  const { path, link, can } = useWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [customising, setCustomising] = useState(false);
  const remove = useMutation({
    mutationFn: () => api(`${path}/templates/${templateId}`, { method: "DELETE" }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ["templates", path] }); navigate(link("/templates")); },
  });
  const detail = useQuery({ queryKey: ["template", path, templateId], queryFn: () => api(`${path}/templates/${templateId}`) });
  const connections = useConnections();
  const connected = connections.data && new Set<string>(connections.data.connections.map((item: any) => item.connector));
  const back = <Link to={link("/templates")} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft size={14} /> Templates</Link>;
  if (detail.isLoading) return <>{back}<Card><SkeletonRows /></Card></>;
  if (detail.isError) return <>{back}<Notice>{detail.error.message}</Notice></>;
  const { template } = detail.data;
  const Icon = template.steps ? Workflow : Bot;
  const mayEdit = (template.agent ? can("agents:write") : true) && (template.steps ? can("workflows:write") : true);
  return (
    <>
      {back}
      <PageHeader icon={Icon} title={template.name} description={template.outcome} />
      {mayEdit && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button onClick={() => setCustomising(true)}><Pencil size={14} /> {template.custom ? "Edit" : "Customise"}</Button>
          {template.custom && <Button busy={remove.isPending} onClick={() => confirm("Delete this template? Anything already installed from it stays.") && remove.mutate()}><Trash2 size={14} /> Delete</Button>}
        </div>
      )}
      {remove.isError && <Notice>{remove.error.message}</Notice>}
      {customising && <CustomiseDialog template={template} onClose={() => setCustomising(false)} />}
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <div className="flex flex-wrap items-center gap-1.5">
            {template.custom && <Badge status="live">Your copy of {template.custom.baseName}</Badge>}
            <Badge status="draft">{template.categoryLabel}</Badge>
            <Badge status="draft">{template.role}</Badge>
            <Badge status="draft">{DIFFICULTY[template.difficulty]}</Badge>
            <span className="inline-flex items-center gap-1 text-[12px] text-muted"><Icon size={13} /> Installs {template.builds === "agent" ? "an agent" : template.builds === "workflow" ? "a workflow" : "an agent and a workflow"}</span>
          </div>
          <Section icon={FileText} title="What it does">
            <p className="text-[13px] leading-relaxed text-muted">{template.description}</p>
            {template.agent?.usesDocuments && <p className="mt-1.5 text-[13px] leading-relaxed text-muted">It reads this workspace's documents, so upload the ones it needs and it will answer from those.</p>}
          </Section>
          <Section icon={Cable} title="What it connects to">
            {template.connections.length === 0 ? <p className="text-[13px] text-muted">No outside services. It works from this workspace's documents and files.</p> : (
              <ul className="space-y-1.5">
                {template.connections.map((slot: any) => (
                  <li key={slot.key} className="flex items-start gap-2.5 text-[13px]">
                    <ConnectorIcon name={slot.connector} size={28} />
                    <span className="min-w-0">
                      <span className="font-medium">{slot.label}</span> <span className="text-muted">{slot.purpose}</span>
                      {connected && !connected.has(slot.connector) && <Link to={link("/connections")} className="ml-1.5 text-[12px] text-warn underline">Not connected</Link>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section icon={ShieldCheck} title="What needs approval">
            {template.changes.length === 0 ? (
              <p className="flex items-center gap-1.5 text-[13px] text-muted"><ShieldCheck size={14} className="shrink-0 text-ok" /> It only reads. Nothing outside this workspace can change.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {template.changes.map((change: any, index: number) => (
                  <li key={index} className="flex items-start gap-2.5 px-3 py-2 text-[13px]">
                    <ConnectorIcon name={connectorNamed(template, change.connector)} size={24} />
                    <span className="min-w-0">
                      <span className="font-medium">{change.label}</span> <span className="text-faint">· {change.connector}</span>
                      <span className="block text-[12px] text-muted">{change.guard}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {template.steps && <Section icon={ListOrdered} title="Steps"><Steps steps={template.steps} template={template} /></Section>}
          <Section icon={Play} title="How it starts">
            <p className="text-[13px] text-muted"><span className="font-medium text-ink">{STARTS[template.run.kind]}.</span> {template.run.note}</p>
            {template.run.cron && <p className="mt-1 font-mono text-[12px] text-faint">{template.run.cron}</p>}
            {template.run.input && (
              <dl className="mt-2 grid gap-x-3 gap-y-0.5 text-[12px] sm:grid-cols-[auto_1fr]">
                {Object.entries(template.run.input).map(([name, about]) => (
                  <div key={name} className="contents"><dt className="font-mono text-muted">{name}</dt><dd className="text-faint">{about as string}</dd></div>
                ))}
              </dl>
            )}
          </Section>
          {template.agent && (
            <details className="text-[13px]">
              <summary className="cursor-pointer font-medium">Agent instructions</summary>
              <div className="mt-2 space-y-2">
                <p className="text-muted">{template.agent.description} Rules on using only real facts and treating outside content as data are added at install.</p>
                <Code value={template.agent.instructions} />
              </div>
            </details>
          )}
        </div>
        <Card className="p-5 lg:sticky lg:top-4">
          <h2 className="mb-3 text-[13px] font-medium">Set up</h2>
          {template.mailTriggerLocked && <div className="mb-3"><Locked>This template installs, but its email trigger is locked, so start it another way.</Locked></div>}
          {template.needsUpgrade?.length > 0 ? <Locked>This template needs an upgrade for {template.needsUpgrade.join(", ")}.</Locked> : <Install template={template} />}
        </Card>
      </div>
    </>
  );
}

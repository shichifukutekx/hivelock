import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, Cable, CalendarClock, ClipboardCheck, ExternalLink, Keyboard, Sparkles, Wand2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { Button, Field, Input, Notice, Textarea } from "./ui.tsx";

const IDEAS = [
  "Every weekday at 8:00, list the sales orders that are late or due this week, by customer, and email it to me after I check it.",
  "When I start it with a purchase order number, show what is still open on that order and who the supplier is.",
  "On the 1st of each month, summarise last month's new orders by plant and email the summary to the managers after approval.",
];

const STEP_ICONS = { agent: Bot, approval: ClipboardCheck, connector: Cable } as const;

/** Builds a workflow from plain words: the person describes it, reviews the draft, and only then is anything created. */
export function DescribeWorkflow({ onBlank, onClose }: { onBlank: () => void; onClose: () => void }) {
  const { path, link, can } = useWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<any>();
  const [name, setName] = useState("");
  const [recipient, setRecipient] = useState("");
  const [scheduled, setScheduled] = useState(true);
  const connections = useQuery({ queryKey: ["connections", path], queryFn: () => api(`${path}/connections`), enabled: can("connections:list") });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const make = useMutation({
    mutationFn: () => api(`${path}/workflows/draft`, { body: { description: text } }),
    onSuccess: ({ draft: next }) => { setDraft(next); setName(next.name); setScheduled(!!next.schedule); },
  });
  const create = useMutation({
    mutationFn: () => api(`${path}/workflows/from-draft`, {
      body: {
        name: name.trim(), description: draft.description, definition: draft.definition,
        agent: "created" in draft.agent ? draft.agent.created : undefined,
        recipient: draft.blanks.length ? recipient.trim() : undefined,
        schedule: draft.schedule && scheduled ? { cron: draft.schedule.cron, timezone } : undefined,
      },
    }),
    onSuccess: ({ id }) => { client.invalidateQueries(); navigate(link(`/workflows/${id}`)); },
  });

  if (!draft) {
    return (
      <form onSubmit={(event: FormEvent) => { event.preventDefault(); make.mutate(); }} className="space-y-4">
        {make.isError && <Notice>{make.error.message}</Notice>}
        <Field label="What should it do?" help="Say what it works on, when it runs, and what should happen with the result. No SQL or technical words needed: an agent finds the data for you.">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={IDEAS[0]} autoFocus required minLength={10} maxLength={4000} />
        </Field>
        <div>
          <p className="mb-1.5 text-[12px] font-medium text-muted">Or start from an idea</p>
          <div className="space-y-1.5">
            {IDEAS.map((idea) => (
              <button key={idea} type="button" onClick={() => setText(idea)} className="block w-full rounded-lg border border-line bg-raised px-3 py-2 text-left text-[12px] leading-snug text-muted hover:border-line-strong hover:text-ink">{idea}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink" onClick={onBlank}><Keyboard size={14} /> Build it step by step instead</button>
          <Button type="submit" variant="primary" busy={make.isPending}><Wand2 size={14} /> {make.isPending ? "Drafting…" : "Draft workflow"}</Button>
        </div>
      </form>
    );
  }

  const steps: any[] = draft.definition.nodes.filter((node: any) => node.type !== "start");
  const connectionName = (id: string) => connections.data?.connections.find((item: any) => item.id === id)?.name ?? "a connection";
  const agent = draft.agent;
  return (
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }} className="space-y-4">
      {create.isError && <Notice>{create.error.message}</Notice>}
      <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
      {draft.description && <p className="-mt-2 text-[13px] text-muted">{draft.description}</p>}

      <div className="rounded-xl border border-line p-3">
        {"existing" in agent ? (
          <p className="flex flex-wrap items-center gap-1.5 text-[13px]"><Bot size={14} className="text-accent" /> Uses your agent
            <Link to={link(`/agents/${encodeURIComponent(agent.existing.name)}`)} target="_blank" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">{agent.existing.title} <ExternalLink size={11} /></Link>
          </p>
        ) : (
          <>
            <p className="flex items-center gap-1.5 text-[13px]"><Sparkles size={14} className="text-accent" /> Creates a new agent: <b>{agent.created.title ?? agent.created.name}</b></p>
            <p className="mt-0.5 text-[12px] text-muted">{agent.created.description} {agent.created.connections?.length ? `It can read ${agent.created.connections.map((link_: any) => connectionName(link_.connectionId)).join(", ")}.` : ""}</p>
            <details className="mt-1 text-[12px] text-muted"><summary className="cursor-pointer">Its instructions</summary><p className="mt-1 whitespace-pre-wrap">{agent.created.instructions}</p></details>
          </>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[12px] font-medium text-muted">Steps</p>
        <ol className="divide-y divide-line rounded-xl border border-line">
          {steps.map((step, index) => {
            const Icon = STEP_ICONS[step.type as keyof typeof STEP_ICONS] ?? Bot;
            const detail = step.type === "agent" ? step.config.prompt : step.type === "approval" ? step.config.message : `${connectionName(step.config.connectionId)}`;
            return (
              <li key={step.id} className="flex gap-2.5 px-3 py-2">
                <span className="w-4 shrink-0 pt-0.5 text-right text-[11px] text-faint tabular-nums">{index + 1}</span>
                <Icon size={15} className="mt-0.5 shrink-0 text-accent" />
                <span className="min-w-0 text-[13px]"><span className="font-medium">{step.label}</span><span className="line-clamp-2 block text-[12px] text-muted">{String(detail).replace(/\{\{steps\.\w+\.output\}\}/g, "(the result before)").replaceAll("[[recipient]]", recipient.trim() || "the address below")}</span></span>
              </li>
            );
          })}
        </ol>
        {draft.inputs.length > 0 && <p className="mt-1.5 text-[12px] text-muted">When started, it asks for: {draft.inputs.map((input: any) => input.label).join(", ")}.</p>}
      </div>

      {draft.blanks.length > 0 && (
        <Field label="Who receives it" help="One email address, or a team mailbox."><Input type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} required placeholder="team@example.com" /></Field>
      )}
      {draft.schedule && (
        <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} />
          <span className="flex items-center gap-1.5"><CalendarClock size={14} className="text-accent" /> Run it on a schedule: {draft.schedule.note} <span className="text-faint">({timezone})</span></span></label>
      )}
      <p className="text-[12px] text-faint">It is created as a draft. Run it once to check the result, then turn it on. You can change any step in the editor.</p>
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink" onClick={() => setDraft(undefined)}><ArrowLeft size={14} /> Change the description</button>
        <span className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={create.isPending}><Wand2 size={14} /> Create workflow</Button>
        </span>
      </div>
    </form>
  );
}

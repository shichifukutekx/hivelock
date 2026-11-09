import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, Brain, Lightbulb, Workflow as WorkflowIcon, Check, FlaskConical, Loader2, MessageSquare, Paperclip, Pencil, Play, Plus, Power, PowerOff, Send, ShieldAlert, Sparkles, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, Code, Empty, Field, IconTile, Input, Modal, Notice, SkeletonRows, Textarea } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { uploadFile } from "../lib/files.ts";
import { Locked } from "../lib/edition.tsx";
import { web } from "../lib/extensions.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { AgentEditor } from "./Agents.tsx";
import { ExportMenu } from "../components/ExportMenu.tsx";
import { Markdown } from "../components/Markdown.tsx";

const SESSION_PAGE = 50;
const MEMORY_PAGE = 100;



function Memories({ name, onClose }: { name: string; onClose: () => void }) {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const key = ["memories", name];
  const list = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api(`${path}/agents/${name}/memories?limit=${MEMORY_PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => { const loaded = pages.length * MEMORY_PAGE; return loaded < last.total ? loaded : undefined; },
  });
  const memories: any[] = list.data?.pages.flatMap((page) => page.memories) ?? [];
  const remove = useMutation({ mutationFn: (id: string) => api(`${path}/agents/${name}/memories/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  return (
    <Modal title={`What ${name} remembers`} onClose={onClose}>
      {list.isLoading ? <SkeletonRows rows={3} /> : memories.length === 0 ? <Empty icon={Brain} title="Nothing yet">Notes appear here after you approve them in a chat.</Empty> : (
        <ul className="divide-y divide-line">
          {memories.map((memory: any) => (
            <li key={memory.id} className="flex items-start justify-between gap-3 py-2 text-[13px]">
              <span className="min-w-0 break-words">{memory.content}</span>
              {can("agents:write") && <button aria-label="Forget this" className="icon-btn shrink-0" onClick={() => remove.mutate(memory.id)}><Trash2 size={14} /></button>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-between gap-2">
        {list.hasNextPage ? <Button busy={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Show more</Button> : <span />}
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

/** The start of a chat: what the agent is for, what to do first, and examples to send with one click. */
function Welcome({ agent, busy, onPick }: { agent: any; busy: boolean; onPick?: (message: string) => void }) {
  const { link } = useWorkspace();
  const starters: string[] = agent.starters ?? [];
  return (
    <div className="enter-fade mx-auto max-w-xl py-8 text-center">
      <IconTile icon={Sparkles} size={44} className="mx-auto" />
      <h2 className="mt-3 font-display text-[20px] font-semibold tracking-tight">{agent.title}</h2>
      <p className="mt-1 text-[14px] text-muted">{agent.description}</p>
      {agent.guide && (
        <p className="mx-auto mt-4 flex max-w-md items-start gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[13px] leading-snug">
          <Lightbulb size={15} className="mt-0.5 shrink-0 text-accent" /> <span>{agent.guide}</span>
        </p>
      )}
      {agent.workflows?.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-muted">
          <WorkflowIcon size={14} className="text-accent" /> Used in
          {agent.workflows.map((workflow: any, index: number) => (
            <span key={workflow.id}><Link className="font-medium text-accent hover:underline" to={link(`/workflows/${workflow.id}`)}>{workflow.name}</Link>{index < agent.workflows.length - 1 ? "," : ""}</span>
          ))}
        </p>
      )}
      {(agent.server === "files" || agent.knowledge) && (
        <p className="mt-2 text-[12px] text-faint">It reads what is under <Link className="underline hover:text-ink" to={link("/files")}>Files</Link>. You can also attach a file below.</p>
      )}
      {starters.length > 0 && onPick && (
        <div className="mt-6 grid gap-2 text-left sm:grid-cols-2">
          {starters.map((starter) => (
            <button key={starter} type="button" disabled={busy} onClick={() => onPick(starter)}
              className="lift card-hover rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] leading-snug disabled:opacity-50">
              {starter}
            </button>
          ))}
        </div>
      )}
      {!starters.length && <p className="mt-6 text-[13px] text-faint">Type a message below to start.</p>}
    </div>
  );
}

/** Stops one agent at once, without pausing the whole workspace. */
function AgentSwitch({ name, title, off }: { name: string; title: string; off: boolean }) {
  const { path } = useWorkspace();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const flip = useMutation({
    mutationFn: (on: boolean) => api(`${path}/agents/${name}/switch`, { method: "PUT", body: { on, reason: reason.trim() || undefined } }),
    onSuccess: () => { setAsking(false); setReason(""); client.invalidateQueries({ queryKey: ["agent", name] }); client.invalidateQueries({ queryKey: ["agents", path] }); },
  });
  if (off) return <Button busy={flip.isPending} onClick={() => flip.mutate(true)}><Power size={14} /> Turn on</Button>;
  return (
    <>
      <Button onClick={() => setAsking(true)}><PowerOff size={14} /> Turn off</Button>
      {asking && (
        <Modal title={`Turn off ${title}?`} onClose={() => setAsking(false)}>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); flip.mutate(false); }}>
            <p className="text-[13px] text-muted">It stops at once: no new chat replies, workflow steps or hand-offs from other agents. Anything already running finishes its current step. Workflows that use it fail with a plain message until it is on again.</p>
            <Field label="Why (optional)"><Input autoFocus maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Gave wrong prices to a customer" /></Field>
            {flip.isError && <Notice>{flip.error.message}</Notice>}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setAsking(false)}>Cancel</Button>
              <Button type="submit" variant="danger" busy={flip.isPending}><PowerOff size={14} /> Turn off</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

type Gate = { state: "clear" | "untested" | "testing" | "failed" | "overridden"; message: string; failedTests?: string[]; overriddenBy?: string | null; overriddenAt?: string | null };

/** Whether live workflows wait for this agent's tests after its latest change. Chats are never held back. */
function ReleaseGate({ name, gate, onTests }: { name: string; gate: Gate; onTests: () => void }) {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const override = useMutation({
    mutationFn: () => api(`${path}/agents/${name}/release/override`, { method: "POST", body: { reason: reason.trim() || undefined } }),
    onSuccess: () => { setAsking(false); setReason(""); client.invalidateQueries({ queryKey: ["agent", name] }); client.invalidateQueries({ queryKey: ["agents", path] }); },
  });
  if (gate.state === "clear") return null;
  const held = gate.state !== "overridden";
  const tone = gate.state === "failed" ? "border-danger/30 bg-danger-soft text-danger" : gate.state === "overridden" ? "border-line bg-sunken text-muted" : "border-warn/30 bg-warn-soft text-warn";
  const title = { untested: "Workflows wait for this agent's tests.", testing: "Testing the latest change.", failed: "The latest change failed its tests.", overridden: "Used in workflows without passing its tests." }[gate.state];
  return (
    <div role="status" className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-[13px] ${tone}`}>
      {gate.state === "testing" ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />}
      <span className="font-medium">{title}</span>
      <span className="opacity-80">
        {held ? "Live workflows will not use it until its tests pass. Chats still work here." : `${gate.overriddenBy ?? "Someone"} chose this${gate.overriddenAt ? ` ${ago(gate.overriddenAt)}` : ""}. The next change is tested again.`}
        {gate.state === "failed" && gate.failedTests?.length ? ` Failed: ${gate.failedTests.join(", ")}.` : ""}
      </span>
      <span className="ml-auto flex gap-2">
        <Button onClick={onTests}><FlaskConical size={14} /> Tests</Button>
        {held && can("members:manage") && <Button onClick={() => setAsking(true)}>Use it anyway</Button>}
      </span>
      {asking && (
        <Modal title="Use it in workflows anyway?" onClose={() => setAsking(false)}>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); override.mutate(); }}>
            <p className="text-[13px] text-muted">Live workflows start using this change now, without passing its tests. This is recorded in the audit log. The next change to the agent is tested again.</p>
            <Field label="Why (optional)"><Input autoFocus maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="The failing test is out of date" /></Field>
            {override.isError && <Notice>{override.error.message}</Notice>}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setAsking(false)}>Cancel</Button>
              <Button type="submit" variant="danger" busy={override.isPending}>Use it anyway</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function AgentChat() {
  const { agentName } = useParams();
  const { path, link, can } = useWorkspace();
  const client = useQueryClient();
  const [searchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState<string | undefined>(searchParams.get("session") ?? undefined);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<"memory" | "tests">();
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const agent = useQuery({
    queryKey: ["agent", agentName], queryFn: () => api(`${path}/agents/${agentName}`),
    // While its tests run, the notice below follows them.
    refetchInterval: (state) => (state.state.data?.agent?.gate?.state === "testing" ? 3_000 : false),
  });
  const sessions = useInfiniteQuery({
    queryKey: ["sessions", agentName],
    queryFn: ({ pageParam }) => api(`${path}/sessions?agent=${encodeURIComponent(agentName!)}&limit=${SESSION_PAGE}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => { const loaded = pages.length * SESSION_PAGE; return loaded < last.total ? loaded : undefined; },
  });
  const pastChats: any[] = sessions.data?.pages.flatMap((page) => page.sessions) ?? [];
  const chat = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api(`${path}/sessions/${sessionId}`),
    enabled: !!sessionId,
    staleTime: 0,
    refetchInterval: (state) => (state.state.data && state.state.data.session.status === "idle" ? false : 1_000),
  });
  const decide = useMutation({
    mutationFn: ({ id, approved }: { id: string; approved: boolean }) => api(`${path}/sessions/${sessionId}/approvals/${id}`, { body: { approved } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session", sessionId] }),
  });

  const count = chat.data?.messages.length;
  const status = chat.data?.session.status;
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [count, status, live]);
  useEffect(() => { setLive(""); }, [sessionId, count]);

  // Live text arrives here. Checking in each second still shows the final answer if this connection drops.
  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(`${path}/sessions/${sessionId}/stream`);
    source.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === "token") setLive((current) => current + message.text);
      if (message.type === "done") client.invalidateQueries({ queryKey: ["session", sessionId] });
    };
    return () => source.close();
  }, [path, sessionId, client]);

  const send = async (event?: FormEvent, preset?: string) => {
    event?.preventDefault();
    const message = (preset ?? text).trim();
    if ((!message && !file) || busy) return;
    setBusy(true);
    setProblem("");
    try {
      let body = message || "Please look at the attached file.";
      if (file) body += `\n\nAttached file: ${await uploadFile(path, file)}`;
      let id = sessionId;
      if (!id) {
        ({ id } = await api(`${path}/sessions`, { body: { agent: agentName, title: body.slice(0, 80) } }));
        setSessionId(id);
        client.invalidateQueries({ queryKey: ["sessions", agentName] });
      }
      await api(`${path}/sessions/${id}/messages`, { body: { text: body } });
      setText("");
      setFile(undefined);
      client.invalidateQueries({ queryKey: ["session", id] });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const working = status === "running" || status === "waiting";
  const definition = agent.data?.agent;
  const off = definition?.off as { reason?: string | null; turned_off_at: string } | null | undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <Link to={link("/agents")} aria-label="Back to agents" className="rounded-lg p-1.5 text-muted hover:bg-sunken hover:text-ink"><ArrowLeft size={16} /></Link>
        <IconTile icon={Sparkles} size={28} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold">{definition?.title ?? agentName}</h1>
          <p className="truncate text-[12px] text-muted">{definition?.description}</p>
        </div>
        {pastChats.length > 0 && (
          <select aria-label="Past chats" className="field field-select h-9 max-w-36 rounded-[10px] pr-7 pl-2 text-[13px] text-ink md:hidden" value={sessionId ?? ""} onChange={(event) => setSessionId(event.target.value || undefined)}>
            <option value="">Past chats</option>
            {pastChats.map((session: any) => <option key={session.id} value={session.id}>{session.title}</option>)}
          </select>
        )}
        {sessionId && <Link to={link(`/traces/${sessionId}`)}><Button><Activity size={14} /> Timeline</Button></Link>}
        {definition?.memory && <Button onClick={() => setPanel("memory")}><Brain size={14} /> Memory</Button>}
        <Button onClick={() => setPanel("tests")}><FlaskConical size={14} /> Tests</Button>
        {can("agents:write") && definition && !definition.builtIn && <Button onClick={() => setEditing(true)}><Pencil size={14} /> Edit</Button>}
        {can("runs:start") && <Button onClick={() => setSessionId(undefined)}><Plus size={14} /> New chat</Button>}
        {definition && (off ? can("agents:write") : can("runs:approve")) && <AgentSwitch name={definition.name} title={definition.title ?? definition.name} off={!!off} />}
      </header>
      {off && (
        <div role="status" className="flex flex-wrap items-center gap-2 border-b border-danger/30 bg-danger-soft px-4 py-2 text-[13px] text-danger">
          <PowerOff size={14} /> <span className="font-medium">This agent is turned off.</span>
          <span className="text-danger/80">{off.reason ? `${off.reason}. ` : ""}It starts no chats, workflow steps or hand-offs until someone who manages agents turns it on again.</span>
        </div>
      )}
      {definition?.gate && <ReleaseGate name={definition.name} gate={definition.gate} onTests={() => setPanel("tests")} />}
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Past chats" className="hidden w-56 shrink-0 overflow-y-auto border-r border-line bg-surface p-2 md:block">
          <p className="px-2 py-1 text-[12px] font-medium text-muted">Chats</p>
          {pastChats.map((session: any) => (
            <button key={session.id} onClick={() => setSessionId(session.id)} className={`block w-full rounded-lg px-2 py-1.5 text-left hover:bg-sunken ${session.id === sessionId ? "bg-sunken" : ""}`}>
              <span className="block truncate text-[13px]">{session.title}</span>
              <span className="block text-[11px] text-faint">{ago(session.updated_at)}</span>
            </button>
          ))}
          {sessions.hasNextPage && <button type="button" className="mt-1 w-full rounded px-2 py-1 text-left text-[12px] text-muted hover:bg-sunken hover:text-ink" onClick={() => sessions.fetchNextPage()} disabled={sessions.isFetchingNextPage}>Show older chats</button>}
          {sessions.data && pastChats.length === 0 && <p className="flex items-center gap-1.5 px-2 text-[12px] text-faint"><MessageSquare size={12} /> None yet.</p>}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-3xl space-y-3" aria-live="polite">
              {!sessionId && definition && <Welcome agent={definition} busy={busy} onPick={can("runs:start") && !off ? (message) => send(undefined, message) : undefined} />}
              {sessionId && chat.isLoading && <SkeletonRows rows={3} />}
              {chat.data?.messages.map((message: any, index: number) => (
                <div key={message.id} className={`${message.role === "user" ? "flex justify-end" : ""} ${index === chat.data.messages.length - 1 ? "enter-fade" : ""}`}>
                  <div className={`rounded-xl px-3 py-2 text-[14px] leading-relaxed break-words ${message.role === "assistant" ? "w-full max-w-[92%]" : "max-w-[85%] whitespace-pre-wrap"} ${message.role === "user" ? "bg-accent text-accent-ink" : message.role === "error" ? "bg-danger-soft text-danger" : "border border-line bg-surface"}`}>
                    {message.role === "assistant" ? <Markdown text={message.content} /> : message.content}
                    {message.role === "assistant" && /\n\s*\|.*\|\s*\n\s*\|?\s*:?-+:?\s*\|/.test(message.content) && (
                      <div className="mt-2 flex justify-end border-t border-line pt-1.5"><ExportMenu compact text={message.content} name={`${definition?.title ?? agentName} ${new Date(message.created_at ?? Date.now()).toISOString().slice(0, 10)}`} /></div>
                    )}
                  </div>
                </div>
              ))}
              {live && working && <div className="max-w-[85%] rounded-xl border border-line bg-surface px-3 py-2 text-[14px] leading-relaxed break-words"><Markdown text={live} /></div>}
                            {chat.data?.approvals.map((approval: any) => (
                <div key={approval.id} className="rounded-xl border border-warn/50 bg-warn-soft p-3">
                  <p className="flex items-center gap-1.5 text-[13px] font-medium text-warn"><ShieldAlert size={14} className="shrink-0" /> The agent wants to run {approval.tool}</p>
                  <div className="mt-2"><Code value={approval.args} /></div>
                  {can("runs:approve") ? (
                    <div className="mt-2 flex justify-end gap-2">
                      <Button variant="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: approval.id, approved: false })}><X size={14} /> Decline</Button>
                      <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: approval.id, approved: true })}><Check size={14} /> Approve</Button>
                    </div>
                  ) : <p className="mt-2 text-[12px] text-muted">Someone with approval rights needs to decide this.</p>}
                </div>
              ))}
              {status === "running" && !live && <p className="flex items-center gap-1.5 text-[13px] text-muted"><Loader2 size={13} className="animate-spin" /> Looking into it…</p>}
              <div ref={end} />
            </div>
          </div>
          {can("runs:start") && (
            <form onSubmit={send} className="border-t border-line bg-surface p-3">
              <div className="mx-auto max-w-3xl">
                {problem && <div className="mb-2"><Notice>{problem}</Notice></div>}
                {file && <p className="mb-2 flex items-center gap-2 text-[12px] text-muted"><Paperclip size={12} className="shrink-0" /> {file.name} <button type="button" className="underline" onClick={() => setFile(undefined)}>Remove</button></p>}
                <div className="flex items-end gap-2">
                  <input ref={picker} type="file" hidden accept=".pdf,.xlsx,.csv,.txt" onChange={(e) => setFile(e.target.files?.[0])} />
                  <Button aria-label="Attach a file" onClick={() => picker.current?.click()}><Paperclip size={14} /></Button>
                  <Textarea aria-label="Message" rows={1} className="max-h-40 min-h-9 resize-none" value={text} disabled={!!off} placeholder={off ? "This agent is turned off." : `Message ${definition?.title ?? agentName}`} onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                  <Button type="submit" variant="primary" aria-label="Send" busy={busy} disabled={working || !!off}><Send size={14} /></Button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
      {panel === "memory" && <Memories name={agentName!} onClose={() => setPanel(undefined)} />}
      {panel === "tests" && (web.AgentTests
        ? <web.AgentTests name={agentName!} onClose={() => setPanel(undefined)} />
        : <Modal title={`Tests for ${agentName}`} onClose={() => setPanel(undefined)}><Locked>Agent tests check that an agent still does its job after you change it.</Locked></Modal>)}
      {editing && definition && <AgentEditor editing initial={definition} onClose={() => setEditing(false)} />}
    </div>
  );
}

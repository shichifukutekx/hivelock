import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Cable, Lock, Pencil, PlugZap, Plus, Power, RefreshCw, Save, Search, SearchX, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ConnectorIcon } from "../components/ConnectorIcon.tsx";
import { DataTable } from "../components/DataTable.tsx";
import { Badge, Button, Card, cardHover, Empty, Field, Input, Modal, Notice, PageHeader, Select, SkeletonCards, SkeletonRows, StatusDot } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { Locked } from "../lib/edition.tsx";
import type { Column } from "../lib/table.ts";
import { useWorkspace } from "../lib/workspace.ts";

export const useConnectors = () => useQuery({ queryKey: ["connectors"], queryFn: () => api("/api/v1/connectors"), staleTime: 300_000 });

const CATEGORIES: [string, string][] = [
  ["productivity", "Productivity"], ["files", "Files"], ["email", "Email"], ["chat", "Chat and messaging"], ["customers", "Customers and support"],
  ["developer", "Developer tools"], ["commerce", "Commerce and payments"], ["database", "Databases"], ["web", "Web"], ["mcp", "MCP"],
];
const matches = (query: string, ...values: (string | undefined)[]) => {
  const wanted = query.trim().toLowerCase();
  return !wanted || values.some((value) => value?.toLowerCase().includes(wanted));
};
/** Puts items under their category's heading. A category not listed above still shows, so nothing can go missing. */
function byCategory<T>(items: T[], categoryOf: (item: T) => string | undefined) {
  const known = new Set(CATEGORIES.map(([name]) => name));
  const groups = CATEGORIES.map(([name, title]) => ({ name, title, items: items.filter((item) => categoryOf(item) === name) }));
  return [...groups, { name: "other", title: "Other", items: items.filter((item) => !known.has(categoryOf(item) ?? "")) }].filter((group) => group.items.length > 0);
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (next: string) => void; label: string }) {
  return (
    <div className="relative">
      <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
      <Input type="search" aria-label={label} placeholder={label} className="pl-8" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** `preset` opens straight on one service, when a template or step already said which it needs. */
function NewConnection({ preset, onClose, onSaved }: { preset?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const { path } = useWorkspace();
  const client = useQueryClient();
  const connectors = useConnectors();
  const [chosen, setChoice] = useState<any>();
  const choice = chosen ?? connectors.data?.connectors.find((item: any) => item.name === preset && !item.locked);
  const [name, setName] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  // An untouched box shows, and saves, the value the server would use, so what a person sees is what happens.
  const withDefaults = (connector: any) => ({ ...Object.fromEntries(connector.fields.filter((field: any) => field.default !== undefined).map((field: any) => [field.name, field.default])), ...values });
  const choose = (connector: any) => {
    setChoice(connector);
    setValues({});
  };
  const [query, setQuery] = useState("");
  const create = useMutation({
    mutationFn: () => api(`${path}/connections`, { body: { connector: choice.name, name, credentials: Object.fromEntries(Object.entries(withDefaults(choice)).filter(([, v]) => v !== "")) } }),
    onSuccess: ({ id }) => {
      client.invalidateQueries({ queryKey: ["connections", path] });
      onSaved(id);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  if (!choice) {
    const shown = connectors.data?.connectors.filter((c: any) => matches(query, c.label, c.description, c.category)) ?? [];
    return (
      <Modal title="Add a connection" onClose={onClose} wide>
        {connectors.isLoading ? <SkeletonCards count={4} className="grid gap-2 sm:grid-cols-2" /> : (
          <div className="space-y-4">
            <SearchBox label="Search services" value={query} onChange={setQuery} />
            {connectors.data.connectors.some((c: any) => c.locked) && <Locked>Locked connectors need a licence key.</Locked>}
            {connectors.data.notInstalled?.length > 0 && <Locked>More connectors are in the paid package: {connectors.data.notInstalled.join(", ")}.</Locked>}
            {shown.length === 0 && <p className="flex items-center gap-1.5 text-[13px] text-muted"><SearchX size={14} /> Nothing matches that search.</p>}
            {byCategory(shown, (c: any) => c.category).map((group) => (
              <section key={group.name}>
                <h3 className="mb-1.5 text-[12px] font-medium text-muted">{group.title}</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.items.map((connector: any) => (
                    <button key={connector.name} disabled={connector.locked} onClick={() => choose(connector)} className={`flex items-start gap-3 rounded-lg border border-line p-3 text-left ${cardHover} enabled:hover:bg-raised disabled:opacity-60`}>
                      <ConnectorIcon name={connector.name} size={36} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 text-[13px] font-medium">{connector.label} {connector.locked && <Badge status="draft" icon={Lock}>Locked</Badge>}</span>
                        <span className="mt-0.5 block text-[12px] leading-snug text-muted">{connector.description}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </Modal>
    );
  }
  return (
    <Modal title={`Connect ${choice.label}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" autoComplete="off">
        <div className="flex items-start gap-3">
          <ConnectorIcon name={choice.name} size={36} />
          <p className="min-w-0 text-[13px] leading-snug text-muted">{choice.description}</p>
        </div>
        {create.isError && <Notice>{create.error.message}</Notice>}
        <Field label="Connection name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus required /></Field>
        {choice.fields.map((field: any) => field.type === "boolean" ? (
          <label key={field.name} className="block text-[13px]">
            <span className="flex items-center gap-2"><input type="checkbox" checked={!!withDefaults(choice)[field.name]} onChange={(e) => setValues({ ...values, [field.name]: e.target.checked })} /> {field.label}</span>
            {field.help && <span className="mt-0.5 block pl-5 text-[12px] text-faint">{field.help}</span>}
          </label>
        ) : (
          <Field key={field.name} label={field.label} help={field.help}>
            <Input type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"} autoComplete={field.type === "password" ? "new-password" : "off"}
              required={field.required} value={String(values[field.name] ?? "")} onChange={(e) => setValues({ ...values, [field.name]: e.target.value })} />
          </Field>
        ))}
        <p className="text-[12px] text-faint">Credentials are encrypted when saved and cannot be read back.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setChoice(undefined)}><ArrowLeft size={14} /> Back</Button>
          <Button type="submit" variant="primary" busy={create.isPending}><Save size={14} /> Save connection</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Changes a saved connection. Passwords and keys are never sent back, so an empty one keeps what is saved. */
function EditConnection({ connection, connector, onClose }: { connection: any; connector: any; onClose: () => void }) {
  const { path } = useWorkspace();
  const client = useQueryClient();
  const saved = useQuery({ queryKey: ["connection", path, connection.id], queryFn: () => api(`${path}/connections/${connection.id}`), staleTime: 0 });
  const [name, setName] = useState(connection.name);
  const [values, setValues] = useState<Record<string, unknown>>();
  const shown = values ?? { ...Object.fromEntries(connector.fields.filter((field: any) => field.default !== undefined).map((field: any) => [field.name, field.default])), ...saved.data?.values };
  const set = (field: string, value: unknown) => setValues({ ...shown, [field]: value });
  const save = useMutation({
    mutationFn: () => api(`${path}/connections/${connection.id}`, { method: "PUT", body: { name, credentials: shown } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["connections", path] });
      client.invalidateQueries({ queryKey: ["connection", path, connection.id] });
      onClose();
    },
  });
  const hasSecret = (field: string) => !!saved.data?.savedSecrets.includes(field);
  return (
    <Modal title={`Edit ${connection.name}`} onClose={onClose}>
      {saved.isLoading ? <SkeletonRows rows={4} /> : saved.isError ? <Notice>{saved.error.message}</Notice> : (
        <form onSubmit={(event) => { event.preventDefault(); save.mutate(); }} className="space-y-3" autoComplete="off">
          <div className="flex items-start gap-3">
            <ConnectorIcon name={connector.name} size={36} />
            <p className="min-w-0 text-[13px] leading-snug text-muted">{connector.description}</p>
          </div>
          <Field label="Connection name"><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          {connector.fields.map((field: any) => field.type === "boolean" ? (
            <label key={field.name} className="block text-[13px]">
              <span className="flex items-center gap-2"><input type="checkbox" checked={!!shown[field.name]} onChange={(e) => set(field.name, e.target.checked)} /> {field.label}</span>
              {field.help && <span className="mt-0.5 block pl-5 text-[12px] text-faint">{field.help}</span>}
            </label>
          ) : (
            <Field key={field.name} label={field.label} help={field.type === "password" && hasSecret(field.name) ? "Saved. Leave empty to keep it." : field.help}>
              <Input type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"} autoComplete={field.type === "password" ? "new-password" : "off"}
                placeholder={field.type === "password" && hasSecret(field.name) ? "••••••••" : undefined}
                required={field.required && !(field.type === "password" && hasSecret(field.name))}
                value={String(shown[field.name] ?? "")} onChange={(e) => set(field.name, e.target.value)} />
            </Field>
          ))}
          <p className="text-[12px] text-faint">Changing the address, account or security settings needs the password or key again.</p>
          {save.isError && <Notice>{save.error.message}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={save.isPending}><Save size={14} /> Save changes</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function McpTools({ connection, onClose }: { connection: any; onClose: () => void }) {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const base = `${path}/connections/${connection.id}/tools`;
  const tools = useQuery({ queryKey: ["mcp", connection.id], queryFn: () => api(base) });
  const refresh = useMutation({ mutationFn: () => api(`${base}/refresh`, { method: "POST" }), onSuccess: () => tools.refetch() });
  const toggle = useMutation({
    mutationFn: ({ name, enabled, fingerprint }: { name: string; enabled: boolean; fingerprint?: string }) => api(`${base}/${encodeURIComponent(name)}`, { method: "PUT", body: { enabled, fingerprint } }),
    onSettled: () => client.invalidateQueries({ queryKey: ["mcp", connection.id] }),
  });
  return (
    <Modal title={`Tools on ${connection.name}`} onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">Read each tool before turning it on. Tools stay off until you do, and any change turns them off again.</p>
        {can("connections:write") && <Button onClick={() => refresh.mutate()} busy={refresh.isPending}><RefreshCw size={14} /> Check server</Button>}
      </div>
      {refresh.isError && <div className="mb-3"><Notice>{refresh.error.message}</Notice></div>}
      {toggle.isError && <div className="mb-3"><Notice>{toggle.error.message}</Notice></div>}
      {tools.isLoading ? <SkeletonRows rows={3} /> : tools.data.tools.length === 0 ? <Empty icon={Wrench} title="No tools found yet">Press Check server to ask it what it offers.</Empty> : (
        <ul className="space-y-2">
          {tools.data.tools.map((tool: any) => (
            <li key={tool.name} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-[13px] font-medium">{tool.name}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {tool.changed && <Badge status="changed">Changed</Badge>}
                  <Badge status={tool.status} />
                  {can("connections:write") && <Button onClick={() => toggle.mutate({ name: tool.name, enabled: tool.status !== "enabled", fingerprint: tool.fingerprint })}><Power size={14} /> {tool.status === "enabled" ? "Turn off" : "Turn on"}</Button>}
                </div>
              </div>
              {tool.changed && <p className="mt-2 flex items-center gap-1.5 text-[12px] text-warn"><AlertTriangle size={13} /> This tool changed since it was reviewed. Read it again.</p>}
              <p className="mt-1 text-[13px] text-muted">{tool.description || "No description."}</p>
              <details className="mt-1 text-[12px] text-muted"><summary className="cursor-pointer">Inputs</summary><pre className="mt-1 overflow-auto rounded bg-sunken p-2 font-mono">{JSON.stringify(tool.input_schema, null, 2)}</pre></details>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

const RULES: [string, string][] = [["default", "Usual rule"], ["ask", "Ask every time"], ["block", "Off"]];
const usual = (changes: string) => (changes === "never" ? "Runs without asking" : changes === "sometimes" ? "Asks when it would change something" : "Asks a person first");

/** Stricter rules per action. Nothing here can let a change happen without a person. */
function ActionRules({ connection, onClose }: { connection: any; onClose: () => void }) {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const base = `${path}/connections/${connection.id}/actions`;
  const actions = useQuery({ queryKey: ["action-rules", connection.id], queryFn: () => api(base) });
  const save = useMutation({
    mutationFn: ({ action, rule }: { action: string; rule: string }) => api(`${base}/${encodeURIComponent(action)}`, { method: "PUT", body: { rule } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["action-rules", connection.id] }),
  });
  return (
    <Modal title={`Rules for ${connection.name}`} onClose={onClose} wide>
      <p className="mb-3 text-[13px] text-muted">By default, agents read freely and ask a person before changing anything. Here you can make an action stricter: ask every time, even to read, or turn it off for agents and workflows alike.</p>
      {save.isError && <div className="mb-3"><Notice>{save.error.message}</Notice></div>}
      {actions.isLoading ? <SkeletonRows rows={3} /> : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {actions.data.actions.map((action: any) => (
            <li key={action.name} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{action.label}</p>
                <p className="text-[12px] text-muted">{action.rule === "block" ? "Off: agents are told an admin turned it off, and workflow steps using it fail." : action.rule === "ask" ? "Agents ask a person every time." : `Usual rule: ${usual(action.changes).toLowerCase()}.`}</p>
              </div>
              {can("connections:write") ? (
                <Select aria-label={`Rule for ${action.label}`} className="w-44" value={action.rule} disabled={save.isPending && save.variables?.action === action.name}
                  onChange={(event) => save.mutate({ action: action.name, rule: event.target.value })}>
                  {RULES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </Select>
              ) : <Badge status={action.rule === "block" ? "failed" : action.rule === "ask" ? "waiting" : "succeeded"}>{RULES.find(([value]) => value === action.rule)?.[1]}</Badge>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Modal>
  );
}

export function Connections() {
  const { path, can, link } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const connectors = useConnectors();
  const [searchParams, setSearchParams] = useSearchParams();
  const wanted = searchParams.get("add");
  // Only a page inside this workspace, because the address can be anything.
  const back = searchParams.get("back");
  const returnTo = back?.startsWith(link("/")) ? back : undefined;
  const [adding, setAddingState] = useState(!!wanted && can("connections:write"));
  const setAdding = (on: boolean) => {
    setAddingState(on);
    if (!on && searchParams.size) setSearchParams({}, { replace: true });
  };
  const [viewing, setViewing] = useState<any>();
  const [ruling, setRuling] = useState<any>();
  const [editing, setEditing] = useState<any>();
  const [results, setResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [query, setQuery] = useState("");
  const list = useQuery({ queryKey: ["connections", path], queryFn: () => api(`${path}/connections`) });
  const test = useMutation({
    mutationFn: (id: string) => api(`${path}/connections/${id}/test`, { method: "POST" }),
    onSuccess: (result, id) => setResults((current) => ({ ...current, [id]: result })),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${path}/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["connections", path] }),
  });
  const label = (name: string) => connectors.data?.connectors.find((c: any) => c.name === name)?.label ?? name;
  const info = (name: string) => connectors.data?.connectors.find((c: any) => c.name === name);
  const groups = useMemo(() => byCategory(
    (list.data?.connections ?? []).filter((connection: any) => matches(query, connection.name, label(connection.connector), info(connection.connector)?.category)),
    (connection: any) => info(connection.connector)?.category,
  ), [list.data, connectors.data, query]);
  const columns = useMemo<Column[]>(() => [
    { key: "name", header: "Name", value: (connection) => connection.name },
    { key: "type", header: "Type", value: (connection) => label(connection.connector) },
    { key: "added", header: "Added", kind: "date", value: (connection) => connection.created_at },
    { key: "actions", header: "" },
  ], [connectors.data]);
  const button = can("connections:write") && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={14} /> Add connection</Button>;
  return (
    <>
      <PageHeader icon={Cable} title="Connections" description="The accounts and services workflows can use, including custom MCP servers." actions={button} />
      <Card>
        {list.isLoading ? <SkeletonRows /> : list.data.connections.length === 0 ? <Empty icon={Cable} title="No connections yet" action={button}>Connect an API, mailbox, database, chat, file store or MCP server.</Empty> : (
          <div className="space-y-4 p-4">
            <SearchBox label="Search connections" value={query} onChange={setQuery} />
            {groups.length === 0 && <p className="flex items-center gap-1.5 text-[13px] text-muted"><SearchX size={14} /> Nothing matches that search.</p>}
            {groups.map((group) => (
              <section key={group.name}>
                <h2 className="mb-1.5 text-[12px] font-medium text-muted">{group.title} <span className="text-faint">{group.items.length}</span></h2>
                <div className="overflow-hidden rounded-lg border border-line">
                  <DataTable id={group.name} columns={columns} rows={group.items} searchable={false}>
                    {(connection: any) => (
                      <tr key={connection.id} className="hover:bg-raised">
                        <td className="px-4 py-3 font-medium">
                          <span className="flex items-center gap-2.5"><ConnectorIcon name={connection.connector} size={28} /> {connection.name} {connection.locked && <Badge status="draft" icon={Lock}>Locked</Badge>}</span>
                          {connection.locked && <p className="mt-1 max-w-md text-[12px] font-normal text-muted">{connection.lockedReason}</p>}
                        </td>
                        <td className="px-4 py-3 text-muted">{label(connection.connector)}</td>
                        <td className="px-4 py-3 text-muted">{ago(connection.created_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            {results[connection.id] && <span className={`enter-fade flex max-w-56 items-center gap-1.5 text-[12px] ${results[connection.id]!.ok ? "text-ok" : "text-danger"}`} title={results[connection.id]!.error}><StatusDot /><span className="truncate">{results[connection.id]!.ok ? "Working" : results[connection.id]!.error}</span></span>}
                            {connection.connector === "mcp" ? <Button onClick={() => setViewing(connection)}><Wrench size={14} /> Tools</Button>
                              : !connection.locked && info(connection.connector) && <Button onClick={() => setRuling(connection)}><ShieldCheck size={14} /> Rules</Button>}
                            {can("connections:write") && !connection.locked && <Button onClick={() => test.mutate(connection.id)} busy={test.isPending && test.variables === connection.id}><PlugZap size={14} /> Test</Button>}
                            {can("connections:write") && !connection.locked && info(connection.connector) && <button aria-label={`Edit ${connection.name}`} className="icon-btn" onClick={() => setEditing(connection)}><Pencil size={14} /></button>}
                            {can("connections:write") && <button aria-label={`Delete ${connection.name}`} className="icon-btn" onClick={() => confirm(`Delete ${connection.name}? Workflows using it will stop working.`) && remove.mutate(connection.id)}><Trash2 size={14} /></button>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </DataTable>
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
      {editing && <EditConnection connection={editing} connector={info(editing.connector)} onClose={() => { setEditing(undefined); setResults((current) => { const next = { ...current }; delete next[editing.id]; return next; }); }} />}
      {adding && <NewConnection preset={wanted ?? undefined} onClose={() => setAdding(false)} onSaved={(id) => {
        if (returnTo) return navigate(returnTo);
        setAdding(false);
        // Says straight away whether the details work, rather than at the first run.
        test.mutate(id);
      }} />}
      {viewing && <McpTools connection={viewing} onClose={() => setViewing(undefined)} />}
      {ruling && <ActionRules connection={ruling} onClose={() => setRuling(undefined)} />}
    </>
  );
}

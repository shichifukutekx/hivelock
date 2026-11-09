import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, AlertTriangle, ArrowDown, ArrowUp, BadgeCheck, Check, CheckCircle2, Clock, Copy, CreditCard, Cpu, Download, EyeOff, Gauge, Import, KeyRound, Lock, LockKeyhole, Mail, Pencil, PlugZap, Plus, RefreshCw, Save, Search, Send, ScrollText, Settings as SettingsIcon, ShieldAlert, ShieldCheck, Trash2, UserPlus, Users, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DataTable, useTable, useTableParams } from "../components/DataTable.tsx";
import { Badge, Button, Card, Cells, Heading, Empty, Field, Input, Modal, Notice, PageHeader, Select, SkeletonRows, Textarea } from "../components/ui.tsx";
import { ago, api, when } from "../lib/api.ts";
import { useEdition } from "../lib/edition.tsx";
import { web, type SettingsSection } from "../lib/extensions.ts";
import { capitalize, hasFilters, type Column } from "../lib/table.ts";
import { actionName } from "./Audit.tsx";
import { useMe, useWorkspace } from "../lib/workspace.ts";

const sections = (place: SettingsSection["place"]) => (web.settingsSections ?? []).filter((section) => section.place === place);

/** A section heading with its icon. Sections keep one size and color, so the page scans evenly. */
export { Heading };

const personColumns: Column[] = [
  { key: "person", header: "Person", value: (row) => row.user?.name ?? row.email, search: (row) => row.user?.email },
  { key: "role", header: "Role", value: (row) => capitalize(row.role) },
  { key: "actions", header: "" },
];
const secretColumns: Column[] = [
  { key: "name", header: "Name", value: (secret) => secret.name },
  { key: "updated", header: "Updated", kind: "date", value: (secret) => secret.updated_at },
  { key: "actions", header: "" },
];

const ROLES = [
  ["viewer", "Viewer: read only"],
  ["operator", "Operator: run and approve"],
  ["builder", "Builder: create workflows and agents"],
  ["admin", "Admin: manage people and connections"],
] as const;

const blankProvider = { name: "", preset: "custom", baseUrl: "", apiKey: "", main: "", fast: "", coding: "", embedding: "", extraBody: {} as Record<string, unknown>, enabled: true, confidentialAllowed: false, inputPrice: "", outputPrice: "" };
type ProviderForm = typeof blankProvider & { id?: string; hasKey?: boolean };

/** A model name you can type, or pick from every model the server listed. The list shows all of them until you type to narrow it. */
function ModelPicker({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = filter ? options.filter((option) => option.toLowerCase().includes(filter.toLowerCase())) : options;
  return (
    <div className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <div className="flex gap-1.5">
        <Input value={value} onChange={(e) => { onChange(e.target.value); setFilter(e.target.value); setOpen(options.length > 0); }} spellCheck={false} autoComplete="off" />
        {options.length > 0 && <Button aria-label="Show all models" aria-expanded={open} onClick={() => { setFilter(""); setOpen(!open); }}><ChevronDown size={14} /></Button>}
      </div>
      {open && shown.length > 0 && (
        <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 shadow-lg">
          {shown.map((option) => (
            <li key={option}>
              <button type="button" role="option" aria-selected={option === value} onClick={() => { onChange(option); setOpen(false); }}
                className={`block w-full truncate px-3 py-1.5 text-left font-mono text-[12.5px] hover:bg-sunken ${option === value ? "text-accent" : ""}`}>{option}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderEditor({ initial, examples, onClose }: { initial: ProviderForm; examples: any[]; onClose: () => void }) {
  const { path } = useWorkspace();
  const client = useQueryClient();
  const base = `${path}/model-providers`;
  const [form, setForm] = useState(initial);
  const [found, setFound] = useState<string[]>([]);
  const [extra, setExtra] = useState(Object.keys(initial.extraBody).length ? JSON.stringify(initial.extraBody, null, 2) : "");
  const [extraError, setExtraError] = useState("");
  const settings = useQuery({ queryKey: ["settings", path], queryFn: () => api(`${path}/settings`) });
  const fillFrom = (id: string) => {
    const example = examples.find((item) => item.id === id);
    if (!example) return;
    // An example brings the provider's suggested models. "Find models" lists the rest.
    const models = example.models ?? {};
    setForm({
      ...form, name: form.name || example.name, preset: example.id, baseUrl: example.baseUrl, confidentialAllowed: form.confidentialAllowed || example.local,
      main: models.main ?? "", fast: models.fast ?? "", coding: models.coding ?? "", embedding: models.embedding ?? "",
    });
    setFound([]);
    setExtra(Object.keys(example.extraBody).length ? JSON.stringify(example.extraBody, null, 2) : "");
  };
  const set = (key: keyof ProviderForm) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const discover = useMutation({
    mutationFn: () => api(`${base}/discover`, { body: { baseUrl: form.baseUrl, apiKey: form.apiKey || undefined, providerId: form.id } }),
    onSuccess: ({ models }) => {
      setFound(models);
      if (models[0] && !form.main) setForm((current) => ({ ...current, main: models[0] }));
    },
  });
  const save = useMutation({
    mutationFn: (extraBody: Record<string, unknown>) => api(form.id ? `${base}/${form.id}` : base, {
      method: form.id ? "PUT" : "POST",
      body: {
        name: form.name || undefined, preset: form.preset, baseUrl: form.baseUrl, apiKey: form.apiKey || undefined,
        models: { ...(form.main ? { main: form.main } : {}), ...(form.fast ? { fast: form.fast } : {}), ...(form.coding ? { coding: form.coding } : {}), ...(form.embedding ? { embedding: form.embedding } : {}) },
        extraBody, enabled: form.enabled, confidentialAllowed: form.confidentialAllowed,
        inputPrice: form.inputPrice === "" ? null : Number(form.inputPrice), outputPrice: form.outputPrice === "" ? null : Number(form.outputPrice),
      },
    }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ["providers", path] }); onClose(); },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const parsed = extra.trim() ? JSON.parse(extra) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      setExtraError("");
      save.mutate(parsed);
    } catch {
      setExtraError("Extra request settings must be a JSON object.");
    }
  };
  const modelField = (label: string, key: "main" | "fast" | "coding" | "embedding", help: string) => (
    <Field label={label} help={help}>
      <ModelPicker value={form[key]} options={found} onChange={(value) => setForm((current) => ({ ...current, [key]: value }))} />
    </Field>
  );
  return (
    <Modal title={form.id ? `Edit ${form.name}` : "Add an AI provider"} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3" autoComplete="off">
        {extraError && <Notice>{extraError}</Notice>}
        {(save.error ?? discover.error) && <Notice>{(save.error ?? discover.error)!.message}</Notice>}
        {!form.id && examples.length > 0 && (
          <Field label="Fill in from an example" help="Optional. You can change everything afterwards.">
            <Select defaultValue="" onChange={(event) => fillFrom(event.target.value)}>
              <option value="">Enter my own server</option>
              {examples.filter((item) => item.id !== "custom").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Server address" help="OpenAI, Anthropic, Google Gemini, Mistral and any other server that speaks the OpenAI chat API, on the internet or your own network."><Input value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://api.example.com/v1" required autoFocus /></Field>
        <Field label="Name" help="Optional. Uses the server's name if empty."><Input value={form.name} onChange={set("name")} maxLength={80} /></Field>
        <Field label="API key" help={form.hasKey ? "Saved and encrypted. Leave empty to keep it." : "Optional. Encrypted when saved, and it cannot be read back."}>
          <Input type="password" autoComplete="new-password" value={form.apiKey} onChange={set("apiKey")} />
        </Field>
        <div className="flex items-center gap-2">
          <Button onClick={() => discover.mutate()} busy={discover.isPending} disabled={!form.baseUrl}><Search size={14} /> Find models</Button>
          {found.length > 0 && <span className="text-[12px] text-ok">{found.length} models found. Open a list below to pick one.</span>}
        </div>
        {modelField("Main model", "main", "Optional. Empty uses the first model the server lists. Suggested models are the provider's most capable, so check its prices.")}
        <details className="rounded-lg border border-line px-3 py-2 text-[13px]">
          <summary className="cursor-pointer font-medium">More options</summary>
          <div className="mt-2 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {modelField("Fast model", "fast", "Optional. Uses main if empty.")}
              {modelField("Coding model", "coding", "Optional. Uses main if empty.")}
              {modelField("Embedding model", "embedding", "Optional. Lets document search find meaning, not just words.")}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Input price, per million tokens" help="Optional, in US dollars. Used for cost figures."><Input type="number" min={0} step="any" value={form.inputPrice} onChange={set("inputPrice")} /></Field>
              <Field label="Output price, per million tokens"><Input type="number" min={0} step="any" value={form.outputPrice} onChange={set("outputPrice")} /></Field>
            </div>
            <Field label="Extra request settings" help="Optional JSON added to every model request, for settings your server needs.">
              <textarea className="field h-24 w-full rounded-[10px] p-2 font-mono text-[12px]" value={extra} onChange={(event) => setExtra(event.target.value)} placeholder='{"temperature": 0.2}' />
            </Field>
          </div>
        </details>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-1" checked={form.confidentialAllowed} onChange={(e) => setForm({ ...form, confidentialAllowed: e.target.checked })} />
          <span>Cleared for confidential work<span className="block text-[12px] text-faint">Tick only if you have checked this provider's data terms, or it runs on your own hardware.</span></span>
        </label>
        {settings.data?.confidentialMode && !form.confidentialAllowed && <Notice tone="warn">Confidential mode is on for this workspace, so runs will not use this provider until it is cleared. You can turn the mode off under Data rules.</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={save.isPending}><Save size={14} /> Save provider</Button>
        </div>
      </form>
    </Modal>
  );
}

function ModelProviders() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const base = `${path}/model-providers`;
  const [editing, setEditing] = useState<ProviderForm>();
  const [results, setResults] = useState<Record<string, any[]>>({});
  const manage = can("connections:write");
  const data = useQuery({ queryKey: ["providers", path], queryFn: () => api(base), enabled: can("connections:list") });
  const refresh = () => client.invalidateQueries({ queryKey: ["providers", path] });
  const test = useMutation({ mutationFn: (id: string) => api(`${base}/${id}/test`, { method: "POST" }), onSuccess: ({ results: found }, id) => setResults((current) => ({ ...current, [id]: found })) });
  const remove = useMutation({ mutationFn: (id: string) => api(`${base}/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const order = useMutation({ mutationFn: (ids: string[]) => api(`${base}/order`, { body: { ids } }), onSuccess: refresh });
  const importEnv = useMutation({ mutationFn: () => api(`${base}/import-env`, { method: "POST" }), onSuccess: refresh });
  if (!can("connections:list")) return null;
  const providers: any[] = data.data?.providers ?? [];
  const move = (index: number, by: number) => {
    const ids = providers.map((p) => p.id);
    [ids[index], ids[index + by]] = [ids[index + by]!, ids[index]!];
    order.mutate(ids);
  };
  const editForm = (p: any): ProviderForm => ({
    ...blankProvider, id: p.id, hasKey: p.hasKey, name: p.name, preset: p.preset, baseUrl: p.baseUrl, main: p.models.main ?? "", fast: p.models.fast ?? "", coding: p.models.coding ?? "", embedding: p.models.embedding ?? "",
    extraBody: p.extraBody, enabled: p.enabled, confidentialAllowed: p.confidentialAllowed, inputPrice: p.inputPrice === null ? "" : String(p.inputPrice), outputPrice: p.outputPrice === null ? "" : String(p.outputPrice),
  });
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 px-5 py-3">
        <div>
          <Heading icon={Cpu}>AI models</Heading>
          <p className="text-[13px] text-muted">Providers are tried from top to bottom, so the next one takes over if one fails.</p>
        </div>
        {manage && <Button onClick={() => setEditing({ ...blankProvider })}><Plus size={14} /> Add provider</Button>}
      </div>
      {data.data?.usingServerDefaults && (
        <div className="px-5 pb-3">
          <Notice tone="info">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>This workspace is using the default models.</span>
              {can("workspace:delete") && <Button busy={importEnv.isPending} onClick={() => importEnv.mutate()}><Import size={14} /> Import default models</Button>}
            </span>
          </Notice>
        </div>
      )}
      {importEnv.isError && <div className="px-5 pb-3"><Notice>{importEnv.error.message}</Notice></div>}
      {data.data && providers.length === 0 && !data.data.usingServerDefaults && (
        <div className="px-5 pb-3"><Notice tone="warn">No AI model is set up, so agents cannot run yet. {manage ? "Add a provider to start." : "Ask an admin to add one."}</Notice></div>
      )}
      {providers.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {providers.map((p, index) => (
            <li key={p.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {manage && (
                  <span className="flex flex-col">
                    <button aria-label={`Move ${p.name} up`} disabled={index === 0} className="press text-faint hover:text-ink disabled:opacity-30" onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
                    <button aria-label={`Move ${p.name} down`} disabled={index === providers.length - 1} className="press text-faint hover:text-ink disabled:opacity-30" onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {p.name}
                    {!p.enabled && <Badge status="disabled">Off</Badge>}
                    {p.confidentialAllowed && <Badge status="done" icon={Lock}>Confidential</Badge>}
                  </p>
                  <p className="truncate font-mono text-[12px] text-muted">{p.models.main}{p.models.fast ? ` · ${p.models.fast}` : ""}{p.models.coding ? ` · ${p.models.coding}` : ""}</p>
                  <p className="truncate text-[12px] text-faint">{p.baseUrl}</p>
                </div>
                {manage && <Button busy={test.isPending && test.variables === p.id} onClick={() => test.mutate(p.id)}><PlugZap size={14} /> Test</Button>}
                {manage && <Button onClick={() => setEditing(editForm(p))}><Pencil size={14} /> Edit</Button>}
                {manage && <button aria-label={`Delete ${p.name}`} className="icon-btn" onClick={() => confirm(`Delete ${p.name}? Its key is removed too.`) && remove.mutate(p.id)}><Trash2 size={14} /></button>}
              </div>
              {results[p.id]?.map((result) => (
                <p key={result.role} className={`mt-1 text-[12px] ${["tools work", "embeddings work"].includes(result.status) ? "text-ok" : "text-danger"}`}>
                  {result.role}: {result.model}: {result.status === "embeddings work" ? `working, ${result.seconds} s` : result.status === "tools work" ? `working, tools supported, ${result.seconds} s` : result.status === "no tool call" ? "answers, but did not use a tool, so agents may not work well" : result.detail ?? "failed"}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {editing && <ProviderEditor key={editing.id ?? "new"} initial={editing} examples={data.data?.presets ?? []} onClose={() => setEditing(undefined)} />}
    </Card>
  );
}

const MAIL_PRESETS = [
  { id: "gmail", name: "Gmail", host: "smtp.gmail.com", port: 587, security: "starttls", username: "", help: "Use an app password from your Google account, not your normal password." },
  { id: "microsoft365", name: "Microsoft 365", host: "smtp.office365.com", port: 587, security: "starttls", username: "", help: "The mailbox needs SMTP sign-in turned on in the Microsoft 365 admin center." },
  { id: "zoho", name: "Zoho", host: "smtp.zoho.com", port: 587, security: "starttls", username: "", help: "Use smtp.zoho.eu or your region's server if your account is not in the US." },
  { id: "sendgrid", name: "SendGrid", host: "smtp.sendgrid.net", port: 587, security: "starttls", username: "apikey", help: "The username is the word apikey. The password is your SendGrid API key." },
  { id: "ses", name: "Amazon SES", host: "email-smtp.us-east-1.amazonaws.com", port: 587, security: "starttls", username: "", help: "Change the region to yours. Use SES SMTP credentials, not AWS access keys." },
  { id: "custom", name: "Custom", host: "", port: 587, security: "starttls", username: "", help: "Any SMTP server." },
];

const presetFor = (host: string) => MAIL_PRESETS.find((preset) => preset.host === host || (preset.id === "ses" && host.endsWith(".amazonaws.com")))?.id ?? "custom";

function MailForm({ saved, onSaved }: { saved: any; onSaved: () => void }) {
  const [form, setForm] = useState({
    preset: saved ? presetFor(saved.host) : "gmail", host: saved?.host ?? "smtp.gmail.com", port: String(saved?.port ?? 587), security: saved?.security ?? "starttls",
    username: saved?.username ?? "", password: "", fromAddress: saved?.fromAddress ?? "", fromName: saved?.fromName ?? "Hivelock",
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const preset = MAIL_PRESETS.find((p) => p.id === form.preset)!;
  const choose = (id: string) => {
    const { host, port, security, username } = MAIL_PRESETS.find((p) => p.id === id)!;
    setForm({ ...form, preset: id, host, port: String(port), security, username: username || form.username });
  };
  const save = useMutation({
    mutationFn: () => api("/api/v1/platform/mail", { method: "PUT", body: { ...form, port: Number(form.port), password: form.password || undefined } }),
    onSuccess: () => { setForm((current) => ({ ...current, password: "" })); onSaved(); },
  });
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  return (
    <form onSubmit={submit} className="space-y-3 border-t border-line px-5 py-3" autoComplete="off">
      {save.isError && <Notice>{save.error.message}</Notice>}
      {save.isSuccess && <Notice tone="ok">Mail settings saved. New mail uses them straight away.</Notice>}
      <Field label="Provider" help={preset.help}>
        <Select value={form.preset} onChange={(e) => choose(e.target.value)}>{MAIL_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
        <Field label="SMTP server"><Input value={form.host} onChange={set("host")} required /></Field>
        <Field label="Port"><Input type="number" min={1} max={65535} value={form.port} onChange={set("port")} required /></Field>
        <Field label="Security">
          <Select value={form.security} onChange={set("security")}><option value="starttls">STARTTLS</option><option value="tls">TLS</option></Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Username"><Input value={form.username} onChange={set("username")} autoComplete="off" /></Field>
        <Field label="Password" help={saved?.hasPassword ? "Saved and encrypted. Leave empty to keep it, unless the server or port changes." : "Encrypted when saved. It cannot be read back."}>
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />
        </Field>
        <Field label="From address"><Input type="email" value={form.fromAddress} onChange={set("fromAddress")} required /></Field>
        <Field label="From name"><Input value={form.fromName} onChange={set("fromName")} maxLength={120} /></Field>
      </div>
      <div className="flex justify-end"><Button type="submit" variant="primary" busy={save.isPending}><Save size={14} /> Save mail settings</Button></div>
    </form>
  );
}

const MAIL_SOURCES: Record<string, string> = {
  settings: "Sending with the settings below.",
  environment: "Mail is already set up for this installation. Settings saved here replace it.",
  none: "Mail is not set up, so no invitation, verification or password reset mail can be sent.",
};

function PlatformMail() {
  const me = useMe();
  const client = useQueryClient();
  const admin = !!me.data?.isPlatformAdmin;
  const data = useQuery({ queryKey: ["platform-mail"], queryFn: () => api("/api/v1/platform/mail"), enabled: admin });
  const test = useMutation({ mutationFn: () => api("/api/v1/platform/mail/test", { method: "POST" }) });
  if (!admin || !data.data) return null;
  const { source, settings, restartNeeded } = data.data;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 px-5 py-3">
        <div>
          <Heading icon={Mail}>Mail</Heading>
          <p className="text-[13px] text-muted">For the whole server. Only the platform administrator sees this.</p>
          <p className="mt-1 text-[13px]">{MAIL_SOURCES[source]}</p>
        </div>
        <Button busy={test.isPending} disabled={source === "none"} onClick={() => test.mutate()}><Send size={14} /> Send test email</Button>
      </div>
      {test.isError && <div className="px-5 pb-3"><Notice>{test.error.message}</Notice></div>}
      {test.isSuccess && <div className="px-5 pb-3"><Notice tone="ok">Test email sent to {test.data.to}. Check that it arrived.</Notice></div>}
      {restartNeeded && (
        <div className="px-5 pb-3">
          <Notice tone="warn">
            Restart the server to turn on email verification. Send a test email first: after the restart, every account that has not confirmed its address, yours included, gets a confirmation link at sign-in and needs it to get in.
          </Notice>
        </div>
      )}
      <MailForm key={settings?.updatedAt ?? "new"} saved={settings} onSaved={() => client.invalidateQueries({ queryKey: ["platform-mail"] })} />
    </Card>
  );
}

const SERVER_AREAS = [{ value: "auth", label: "Sign-in" }, { value: "platform", label: "System settings" }, { value: "privacy", label: "Personal data" }];
const serverColumns: Column[] = [
  { key: "when", header: "When", kind: "date", value: (event) => event.at, server: { sort: true, range: true } },
  { key: "action", header: "Action", value: (event) => event.action, server: { options: SERVER_AREAS } },
  { key: "by", header: "By" },
  { key: "from", header: "From" },
];

/** Sign-ins and server settings belong to no workspace, so no workspace's audit log can show them. */
function ServerActivity() {
  const me = useMe();
  const admin = !!me.data?.isPlatformAdmin;
  const table = useTable("server-activity");
  const params = useTableParams(table, serverColumns);
  const log = useQuery({ queryKey: ["server-activity", params], queryFn: () => api(`/api/v1/platform/audit?${params}&verify=false`), enabled: admin, placeholderData: keepPreviousData });
  // Rehashes the whole log, so it runs once on opening rather than on every page.
  const chain = useQuery({ queryKey: ["server-activity-chain"], queryFn: () => api("/api/v1/platform/audit?limit=1"), enabled: admin, staleTime: 60_000 });
  if (!admin) return null;
  return (
    <Card>
      <div className="px-5 py-3">
        <Heading icon={ScrollText}>Server activity</Heading>
        <p className="mt-0.5 text-[13px] text-muted">Sign-ins and changes to this server. These are recorded outside any workspace, and only you can see them.</p>
      </div>
      {chain.data?.chainIntact === false && <div className="px-5 pb-3"><Notice icon={ShieldAlert}>Warning: this log has been changed outside the platform.</Notice></div>}
      {log.isError && <div className="px-5 pb-3"><Notice>{log.error.message}</Notice></div>}
      {log.isLoading || !log.data ? <SkeletonRows rows={4} /> : log.data.total === 0 && !hasFilters(table.state) ? <Empty icon={ScrollText} title="Nothing recorded yet" /> : (
        <DataTable id="server-activity" table={table} total={log.data.total} columns={serverColumns} rows={log.data.events}>
          {(event: any) => (
            <tr key={event.id}>
              <td className="px-5 py-2.5 whitespace-nowrap text-muted">{when(event.at)}</td>
              <td className="px-5 py-2.5" title={event.action}>{actionName(event.action)}</td>
              <td className="px-5 py-2.5 text-muted">{event.actor_name ?? "System"}</td>
              <td className="px-5 py-2.5 text-muted">{event.ip ?? "—"}</td>
            </tr>
          )}
        </DataTable>
      )}
    </Card>
  );
}

function Confidential() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", path], queryFn: () => api(`${path}/settings`) });
  const save = useMutation({
    mutationFn: (confidentialMode: boolean) => api(`${path}/settings`, { method: "PUT", body: { confidentialMode } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["settings", path] }),
  });
  const on = settings.data?.confidentialMode ?? true;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Heading icon={ShieldCheck}>Confidential mode</Heading>
          <p className="mt-0.5 max-w-xl text-[13px] text-muted">
            While on, agents only use AI providers you have cleared for confidential work below. If none is available, the step stops rather than sending data elsewhere.
          </p>
          <p className="mt-2 text-[12px] text-faint">Clear a provider only after checking its data terms. A local model keeps data on your own hardware.</p>
        </div>
        {can("members:manage") ? (
          <label className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" disabled={settings.isLoading || save.isPending} checked={on} onChange={(e) => save.mutate(e.target.checked)} /> {on ? "On" : "Off"}
          </label>
        ) : <span className="text-[13px] font-medium">{on ? "On" : "Off"}</span>}
      </div>
    </Card>
  );
}

function PersonalData() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", path], queryFn: () => api(`${path}/settings`) });
  const save = useMutation({
    mutationFn: (redactPersonalData: boolean) => api(`${path}/settings`, { method: "PUT", body: { redactPersonalData } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["settings", path] }),
  });
  const on = settings.data?.redactPersonalData ?? false;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Heading icon={EyeOff}>Remove personal data from answers</Heading>
          <p className="mt-0.5 max-w-xl text-[13px] text-muted">Hides email addresses and card numbers in what agents reply. Credentials are always removed, whatever this says.</p>
        </div>
        {can("members:manage") ? (
          <label className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" disabled={settings.isLoading || save.isPending} checked={on} onChange={(e) => save.mutate(e.target.checked)} /> {on ? "On" : "Off"}
          </label>
        ) : <span className="text-[13px] font-medium">{on ? "On" : "Off"}</span>}
      </div>
    </Card>
  );
}

function Limits() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", path], queryFn: () => api(`${path}/settings`) });
  const [limit, setLimit] = useState("");
  const [days, setDays] = useState("");
  const save = useMutation({
    mutationFn: () => api(`${path}/settings`, { method: "PUT", body: {
      ...(limit ? { monthlyTokenLimit: Number(limit) } : {}),
      ...(days ? { runRetentionDays: Number(days) } : {}),
    } }),
    onSuccess: () => { setLimit(""); setDays(""); client.invalidateQueries({ queryKey: ["settings", path] }); },
  });
  if (!settings.data) return null;
  const { tokensUsedThisMonth: used, monthlyTokenLimit: allowance, runRetentionDays: kept } = settings.data;
  const share = allowance ? Math.min(100, Math.round((used / allowance) * 100)) : 100;
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  return (
    <Card className="p-5">
      <Heading icon={Gauge}>Usage and limits</Heading>
      <p className="mt-0.5 text-[13px] text-muted">{used.toLocaleString()} of {allowance.toLocaleString()} tokens used this month. New agent steps stop at the limit.</p>
      <div className="mt-2.5"><Cells share={share} label={`${share}% of the monthly allowance used`} /></div>
      {can("members:manage") && (
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          {save.isError && <div className="sm:col-span-3"><Notice>{save.error.message}</Notice></div>}
          <Field label="Monthly token limit"><Input type="number" min={0} value={limit} placeholder={String(allowance)} onChange={(e) => setLimit(e.target.value)} /></Field>
          <Field label="Keep finished runs for (days)"><Input type="number" min={1} max={3650} value={days} placeholder={String(kept)} onChange={(e) => setDays(e.target.value)} /></Field>
          <Button type="submit" busy={save.isPending} disabled={!limit && !days}><Save size={14} /> Save</Button>
        </form>
      )}
      {!can("members:manage") && <p className="mt-2 text-[12px] text-faint">Finished runs are kept for {kept} days.</p>}
    </Card>
  );
}

function Members() {
  const { id, can } = useWorkspace();
  const me = useMe();
  const client = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const manage = can("members:manage");
  const members = useQuery({ queryKey: ["members", id], queryFn: () => api(`/api/auth/organization/list-members?organizationId=${id}&limit=1000`) });
  const invitations = useQuery({ queryKey: ["invitations", id], queryFn: () => api(`/api/auth/organization/list-invitations?organizationId=${id}`), enabled: manage });
  const invite = useMutation({
    mutationFn: () => api("/api/auth/organization/invite-member", { body: { email, role, organizationId: id } }),
    onSuccess: ({ id: invitationId }) => {
      setLink(`${location.origin}/invite/${invitationId}`);
      client.invalidateQueries({ queryKey: ["invitations", id] });
    },
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["members", id] });
  const changeRole = useMutation({ mutationFn: (values: { memberId: string; role: string }) => api("/api/auth/organization/update-member-role", { body: { ...values, organizationId: id } }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (memberIdOrEmail: string) => api("/api/auth/organization/remove-member", { body: { memberIdOrEmail, organizationId: id } }), onSuccess: refresh });
  const [copiedId, setCopiedId] = useState("");
  const cancelInvite = useMutation({ mutationFn: (invitationId: string) => api("/api/auth/organization/cancel-invitation", { body: { invitationId } }), onSuccess: () => client.invalidateQueries({ queryKey: ["invitations", id] }) });
  const close = () => { setInviting(false); setLink(""); setEmail(""); invite.reset(); };
  const submit = (event: FormEvent) => { event.preventDefault(); invite.mutate(); };
  const pending = (invitations.data ?? []).filter((i: any) => i.status === "pending");
  const people = useMemo(() => [...(members.data?.members ?? []), ...pending], [members.data, invitations.data]);
  const problem = changeRole.error ?? remove.error ?? cancelInvite.error;
  return (
    <Card>
      <div className="flex items-center justify-between px-5 py-3">
        <Heading icon={Users}>People</Heading>
        {manage && <Button onClick={() => setInviting(true)}><UserPlus size={14} /> Invite</Button>}
      </div>
      {problem && <div className="px-5 pb-3"><Notice>{problem.message}</Notice></div>}
      {members.isLoading ? <SkeletonRows rows={3} /> : (
        <DataTable id="people" columns={personColumns} rows={people}>
          {(member: any) => member.user ? (
            <tr key={member.id}>
              <td className="px-5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">{member.user.name?.[0]?.toUpperCase()}</span>
                  <div className="min-w-0"><div className="font-medium">{member.user.name}</div><div className="text-[12px] text-muted">{member.user.email}</div></div>
                </div>
              </td>
              <td className="px-5 py-2.5">
                {manage && member.role !== "owner" && member.userId !== me.data?.user.id ? (
                  <Select aria-label={`Role for ${member.user.email}`} className="w-40" value={member.role} onChange={(e) => changeRole.mutate({ memberId: member.id, role: e.target.value })}>
                    {ROLES.map(([value]) => <option key={value} value={value}>{value}</option>)}
                  </Select>
                ) : <span className="text-muted capitalize">{member.role}</span>}
              </td>
              <td className="px-5 py-2.5 text-right">
                {manage && member.role !== "owner" && member.userId !== me.data?.user.id && (
                  <button aria-label={`Remove ${member.user.email}`} className="icon-btn" onClick={() => confirm(`Remove ${member.user.email}?`) && remove.mutate(member.id)}><Trash2 size={14} /></button>
                )}
              </td>
            </tr>
          ) : (
            <tr key={member.id}>
              <td className="px-5 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sunken text-faint"><Clock size={14} /></span>
                  <div className="min-w-0"><div className="text-muted">{member.email}</div><div className="text-[12px] text-faint">Invited, not joined yet</div></div>
                </div>
              </td>
              <td className="px-5 py-2.5 text-muted capitalize">{member.role}</td>
              <td className="px-5 py-2.5">
                {manage && (
                  <div className="flex items-center justify-end gap-1">
                    <Button className="h-8" onClick={async () => { await navigator.clipboard.writeText(`${location.origin}/invite/${member.id}`); setCopiedId(member.id); }}>{copiedId === member.id ? <Check size={13} /> : <Copy size={13} />} Copy link</Button>
                    <button aria-label={`Cancel the invitation for ${member.email}`} className="icon-btn" onClick={() => confirm(`Cancel the invitation for ${member.email}?`) && cancelInvite.mutate(member.id)}><Trash2 size={14} /></button>
                  </div>
                )}
              </td>
            </tr>
          )}
        </DataTable>
      )}
      {inviting && (
        <Modal title="Invite someone" onClose={close}>
          {link ? (
            <div className="space-y-3">
              <Notice tone="ok">Invitation created. If mail is set up they were emailed too. Otherwise send them this link.</Notice>
              <div className="flex gap-2">
                <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
                <Button aria-label="Copy invitation link" onClick={async () => { await navigator.clipboard.writeText(link); setCopied(true); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</Button>
              </div>
              <div className="flex justify-end"><Button onClick={close}>Done</Button></div>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              {invite.isError && <Notice>{invite.error.message}</Notice>}
              <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
              <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
              <div className="flex justify-end gap-2">
                <Button onClick={close}>Cancel</Button>
                <Button type="submit" variant="primary" busy={invite.isPending}><UserPlus size={14} /> Create invitation</Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </Card>
  );
}

function Secrets() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const list = useQuery({ queryKey: ["secrets", path], queryFn: () => api(`${path}/secrets`), enabled: can("secrets:list") });
  const refresh = () => client.invalidateQueries({ queryKey: ["secrets", path] });
  const save = useMutation({
    mutationFn: () => api(`${path}/secrets/${name}`, { method: "PUT", body: { value } }),
    onSuccess: () => { refresh(); setAdding(false); setName(""); setValue(""); },
  });
  const remove = useMutation({ mutationFn: (secret: string) => api(`${path}/secrets/${secret}`, { method: "DELETE" }), onSuccess: refresh });
  if (!can("secrets:list")) return null;
  const submit = (event: FormEvent) => { event.preventDefault(); save.mutate(); };
  return (
    <Card>
      <div className="flex items-center justify-between px-5 py-3">
        <Heading icon={LockKeyhole}>Secrets</Heading>
        {can("secrets:write") && <Button onClick={() => setAdding(true)}><KeyRound size={14} /> Add secret</Button>}
      </div>
      {list.isLoading ? <SkeletonRows rows={3} /> : list.data.secrets.length === 0 ? <Empty icon={LockKeyhole} title="No secrets stored" action={can("secrets:write") && <Button onClick={() => setAdding(true)}><KeyRound size={14} /> Add secret</Button>} /> : (
        <DataTable id="secrets" columns={secretColumns} rows={list.data.secrets}>
          {(secret: any) => (
            <tr key={secret.name}>
              <td className="px-5 py-2.5 font-mono text-[12px]">{secret.name}</td>
              <td className="px-5 py-2.5 text-muted">{ago(secret.updated_at)}</td>
              <td className="px-5 py-2.5 text-right">{can("secrets:write") && <button aria-label={`Delete ${secret.name}`} className="icon-btn" onClick={() => confirm(`Delete ${secret.name}?`) && remove.mutate(secret.name)}><Trash2 size={14} /></button>}</td>
            </tr>
          )}
        </DataTable>
      )}
      {adding && (
        <Modal title="Add a secret" onClose={() => setAdding(false)}>
          <form onSubmit={submit} className="space-y-3" autoComplete="off">
            {save.isError && <Notice>{save.error.message}</Notice>}
            <Field label="Name" help="Capitals, numbers and underscores."><Input value={name} onChange={(e) => setName(e.target.value.toUpperCase())} pattern="[A-Z][A-Z0-9_]{1,63}" autoFocus required /></Field>
            <Field label="Value" help="Encrypted when saved. It cannot be read back."><Input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} required /></Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={save.isPending}><Save size={14} /> Save</Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}

export const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(bytes / 1024 ** 2)} MB`);

export function Meter({ label, used, limit, show = (value: number) => value.toLocaleString() }: { label: string; used: number; limit: number | null; show?: (value: number) => string }) {
  const share = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="meter rounded-xl border border-line bg-raised px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2 text-[12px] text-muted"><span>{label}</span>{limit !== null && <span className="tabular-nums">{share}%</span>}</div>
      <p className="mt-0.5 font-display text-[20px] leading-tight font-semibold tracking-tight tabular-nums">
        {show(used)} <span className="text-[12px] font-normal tracking-normal text-muted">{limit === null ? "no limit" : `of ${show(limit)}`}</span>
      </p>
      <div className="mt-2"><Cells share={limit === null ? undefined : share} label={limit === null ? `${label}: no limit` : `${label}: ${share}% used`} /></div>
    </div>
  );
}

const CONNECTOR_NAMES: Record<string, string> = { http: "Web services", mcp: "MCP tools", email: "Email", database: "Databases", slack: "Slack", teams: "Microsoft Teams" };

const EDITION_INTRO: Record<string, string> = {
  community: "Free and open source. Security and AI model choice are the same in every edition.",
  licensed: "A commercial licence key is active on this server.",
};

/** Everyone sees the edition and this workspace's usage. Who holds the licence, and the server's totals, reach only those who manage people. */
function EditionAndLicence() {
  const data = useEdition();
  if (!data.data) return null;
  const { id, name, notice, license, limits, usage, lockedFeatures, connectors, readableVersions, contact } = data.data;
  return (
    <Card className="p-5">
      <Heading icon={BadgeCheck}>Edition and licence <Badge status="done">{name}</Badge></Heading>
      <p className="mt-0.5 text-[13px] text-muted">{EDITION_INTRO[id]}</p>
      {license && <p className="mt-1 text-[13px]">Licensed{license.customer ? ` to ${license.customer},` : ""} until {new Date(license.expiresAt).toLocaleDateString()}{license.seats ? `, for ${license.seats} people` : ""}.</p>}
      {notice && <div className="mt-3"><Notice tone="warn">{notice}</Notice></div>}
      <div className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {usage.workspaces !== undefined && <Meter label="Workspaces" used={usage.workspaces} limit={limits.workspaces} />}
        {usage.people !== undefined && <Meter label="People" used={usage.people} limit={limits.people} />}
        <Meter label="Agents" used={usage.agents} limit={limits.agents} />
        <Meter label="Workflows" used={usage.workflows} limit={limits.workflows} />
        <Meter label="Document storage" used={usage.storageBytes} limit={limits.storageBytes} show={size} />
      </div>
      {id === "community" && (
        <div className="mt-3 space-y-1 text-[13px] text-muted">
          <p>There is no monthly run limit, because you pay for the server. At a limit, what you have keeps working and only adding more stops.</p>
          <p>Included connections: {connectors.map((item: string) => CONNECTOR_NAMES[item] ?? item).join(", ")}. Other saved connections stay listed, and run again once you upgrade.</p>
          <p>Available when you upgrade: {lockedFeatures.map((item: any) => item.name).join(", ")}. Your last {readableVersions} workflow versions stay readable.</p>
          <p>To upgrade, contact <a className="underline" href={`mailto:${contact}`}>{contact}</a>.</p>
        </div>
      )}
      {sections("edition").map(({ id: section, Component }) => <Component key={section} />)}
    </Card>
  );
}

/** The signed-in person's own sign-in. Two-step sign-in is on by default, and each person may turn it off for themselves. */
function YourAccount() {
  const client = useQueryClient();
  const { link } = useWorkspace();
  const state = useQuery({ queryKey: ["two-factor-state"], queryFn: () => api("/api/v1/me/two-factor") });
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const off = useMutation({
    mutationFn: () => api("/api/v1/me/two-factor/off", { body: { password } }),
    onSuccess: () => { setAsking(false); setPassword(""); client.invalidateQueries({ queryKey: ["two-factor-state"] }); client.invalidateQueries({ queryKey: ["session"] }); client.invalidateQueries({ queryKey: ["two-factor"] }); },
  });
  const on = state.data?.enabled;
  return (
    <Card className="p-5">
      <Heading icon={LockKeyhole}>Your account</Heading>
      {state.isLoading ? <SkeletonRows rows={1} /> : state.data?.singleSignOn ? (
        <p className="mt-2 text-[13px] text-muted">You sign in through your company's single sign-on, which handles the second step.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[13px] font-medium">Two-step sign-in <Badge status={on ? "live" : "draft"}>{on ? "On" : "Off"}</Badge></p>
            <p className="mt-0.5 text-[12px] text-muted">{on
              ? "Each sign-in asks for a code from your authenticator app as well as your password. This keeps your account safe if your password leaks."
              : "You sign in with your password only. Anyone who learns your password can open your account and everything you can reach here."}</p>
          </div>
          {on
            ? <Button onClick={() => setAsking(true)}><ShieldAlert size={14} /> Turn off</Button>
            : <a href={`/setup-2fa?next=${encodeURIComponent(link("/settings#account"))}`}><Button variant="primary"><ShieldCheck size={14} /> Turn on</Button></a>}
        </div>
      )}
      {asking && (
        <Modal title="Turn off two-step sign-in?" onClose={() => setAsking(false)}>
          <form onSubmit={(event) => { event.preventDefault(); off.mutate(); }} className="space-y-3">
            <Notice tone="warn">Your password alone will open your account. Your other signed-in devices are signed out. You can turn it on again here at any time.</Notice>
            {off.isError && <Notice>{off.error.message}</Notice>}
            <Field label="Your password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAsking(false)}>Keep it on</Button>
              <Button type="submit" variant="danger" busy={off.isPending}>Turn off</Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}

const JUMPS: [string, string][] = [["account", "Your account"], ["models", "AI models"], ["people", "People"], ["data", "Data rules"], ["secrets", "Secrets"], ["edition", "Edition and mail"]];

export function Settings() {
  const me = useMe();
  const hosted = !!me.data?.hosted;
  const { hash } = useLocation();
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }); }, [hash]);
  return (
    <>
      <PageHeader icon={SettingsIcon} title="Settings" description="AI models, people and data rules for this workspace." />
      <nav aria-label="Settings sections" className="mb-3 flex flex-wrap gap-1.5">
        {JUMPS.map(([id, label]) => <a key={id} href={`#${id}`} className="press rounded-lg border border-line bg-surface px-2.5 py-1 text-[12px] text-muted hover:bg-raised hover:text-ink" onClick={(event) => { event.preventDefault(); document.getElementById(id)?.scrollIntoView({ block: "start" }); }}>{label}</a>)}
      </nav>
      <div className="space-y-3 [&>div]:scroll-mt-4">
        {sections("top").map(({ id, Component }) => <Component key={id} />)}
        <div id="account"><YourAccount /></div>
        <div id="models"><ModelProviders /></div>
        <div id="people" className="space-y-3">
          <Members />
          {sections("people").map(({ id, Component }) => <Component key={id} />)}
        </div>
        <div id="data" className="space-y-3">
          <Confidential />
          <PersonalData />
          <Limits />
        </div>
        <div id="secrets"><Secrets /></div>
        <div id="edition" className="space-y-3">
          {!hosted && <EditionAndLicence />}
          <PlatformMail />
          <ServerActivity />
        </div>
        {sections("bottom").map(({ id, Component }) => <Component key={id} />)}
      </div>
    </>
  );
}

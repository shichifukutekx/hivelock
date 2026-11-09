import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, Check, ChevronRight, Copy, Download, Eye, File as FileIcon, FileSpreadsheet, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Home,
  MoreHorizontal, Pencil, Search, SearchX, Sparkles, Trash2, Upload, X, type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Table } from "../components/Markdown.tsx";
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, PageHeader, SkeletonRows } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { parseCsv } from "../lib/csv.ts";
import { uploadFile } from "../lib/files.ts";
import { useWorkspace } from "../lib/workspace.ts";

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const ACCEPT = ".pdf,.xlsx,.csv,.txt";
const ALLOWED = /\.(pdf|xlsx|csv|txt)$/i;
const fileIcon = (name: string): LucideIcon => (/\.(xlsx|csv)$/i.test(name) ? FileSpreadsheet : /\.(pdf|txt)$/i.test(name) ? FileText : FileIcon);
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const downloadLink = (path: string, file: string) => `${path}/files/download?path=${encodeURIComponent(file)}`;

interface Entry { name: string; path: string; kind: "file" | "folder"; size: number; modified: string; items?: number; index?: { status: string; meaning: boolean; error?: string } }
interface Upload { id: number; name: string; state: "waiting" | "uploading" | "done" | "failed"; error?: string }

function SearchState({ entry, onIndex }: { entry: Entry; onIndex: () => void }) {
  if (entry.kind === "folder") return <span className="text-faint">{entry.items === 1 ? "1 item" : `${entry.items ?? 0} items`}</span>;
  if (!entry.index) return <button type="button" onClick={onIndex} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"><Sparkles size={12} /> Make searchable</button>;
  if (entry.index.status === "ready") return <Badge status="done">Ready{entry.index.meaning ? "" : ", words only"}</Badge>;
  if (entry.index.status === "failed") return <span title={entry.index.error}><Badge status="failed">Failed</Badge></span>;
  return <Badge status="running">Indexing</Badge>;
}

/** A spreadsheet's text comes as one block per sheet, cells split by " | ", so each sheet becomes a table again. */
function sheets(text: string) {
  return text.split(/^--- Sheet: (.+?) ---$/m).slice(1).reduce<{ name: string; rows: string[][] }[]>((all, part, index, parts) => {
    if (index % 2 === 0) all.push({ name: part, rows: (parts[index + 1] ?? "").split("\n").filter((line) => line.trim()).map((line) => line.split(" | ")) });
    return all;
  }, []);
}

function TableOf({ id, rows }: { id: string; rows: string[][] }) {
  if (!rows.length) return <p className="text-[13px] text-muted">This is empty.</p>;
  const width = Math.max(...rows.map((row) => row.length));
  const [head, ...body] = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  return <Table id={id} head={head!} rows={body} />;
}

/** Shows a file's contents here, so it can be checked without downloading it. */
function FilePreview({ file, onClose }: { file: string; onClose: () => void }) {
  const { path } = useWorkspace();
  const preview = useQuery({ queryKey: ["file-preview", path, file], queryFn: () => api(`${path}/files/preview?path=${encodeURIComponent(file)}`), staleTime: 60_000 });
  const data = preview.data;
  return (
    <Modal title={baseOf(file)} onClose={onClose} wide>
      {preview.isLoading ? <SkeletonRows rows={6} /> : preview.isError ? <Notice>{preview.error.message}</Notice> : (
        <div className="space-y-3">
          {data.kind === "csv" ? <TableOf id="csv" rows={parseCsv(data.text)} />
            : data.kind === "xlsx" ? sheets(data.text).map((sheet, index) => (
              <section key={index}>
                <h3 className="mb-1.5 text-[12px] font-medium text-muted">{sheet.name}</h3>
                <TableOf id={`sheet${index}`} rows={sheet.rows} />
              </section>
            ))
            : <pre className="max-h-[60vh] overflow-auto rounded-lg border border-line bg-raised p-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{data.text}</pre>}
          {data.cut && <p className="text-[12px] text-muted">This is the start of the file. Download it to see all of it.</p>}
          {data.kind === "pdf" && <p className="text-[12px] text-muted">This is the text in the PDF. Download it to see the pages as they look.</p>}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Close</Button>
        <a href={downloadLink(path, file)} download={baseOf(file)}><Button variant="primary"><Download size={14} /> Download</Button></a>
      </div>
    </Modal>
  );
}

/** Choose a folder to move or copy into. */
function FolderPicker({ title, verb, paths, onDone, onClose }: { title: string; verb: "move" | "copy"; paths: string[]; onDone: (message: string) => void; onClose: () => void }) {
  const { path } = useWorkspace();
  const folders = useQuery({ queryKey: ["folders", path], queryFn: () => api(`${path}/folders`) });
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // A folder cannot go inside itself, so those choices are left out.
  const blocked = (folder: string) => verb === "move" && paths.some((item) => folder === item || folder.startsWith(`${item}/`));
  const options = ["", ...(folders.data?.folders ?? [])].filter((folder) => !blocked(folder));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try {
      const result = await api(`${path}/files/${verb}`, { body: { paths, to: chosen } });
      if (result.failed.length && !result.done.length) throw new Error(result.failed[0].error);
      onDone(`${verb === "move" ? "Moved" : "Copied"} ${result.done.length} ${result.done.length === 1 ? "item" : "items"}${result.failed.length ? `. ${result.failed.length} could not be: ${result.failed[0].error}` : "."}`);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {problem && <Notice>{problem}</Notice>}
        <p className="text-[13px] text-muted">{paths.length === 1 ? baseOf(paths[0]!) : `${paths.length} items`} to:</p>
        <ul role="listbox" aria-label="Folders" className="max-h-72 overflow-y-auto rounded-xl border border-line p-1">
          {folders.isLoading ? <SkeletonRows rows={3} /> : options.map((folder) => (
            <li key={folder || "top"}>
              <button type="button" role="option" aria-selected={chosen === folder} onClick={() => setChosen(folder)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] ${chosen === folder ? "bg-accent-soft font-medium text-ink" : "hover:bg-sunken"}`}
                style={{ paddingLeft: `${8 + (folder ? folder.split("/").length : 0) * 16}px` }}>
                {folder ? <Folder size={14} className="shrink-0 text-accent" /> : <Home size={14} className="shrink-0 text-accent" />}
                <span className="truncate">{folder ? baseOf(folder) : "Files (top folder)"}</span>
                {chosen === folder && <Check size={13} className="ml-auto shrink-0 text-accent" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>{verb === "move" ? <FolderInput size={14} /> : <Copy size={14} />} {verb === "move" ? "Move here" : "Copy here"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function NameDialog({ title, label, initial, action, onSave, onClose }: { title: string; label: string; initial: string; action: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  // The name is selected without its ending, so typing replaces just the name.
  const selectName = (field: HTMLInputElement) => { const dot = initial.lastIndexOf("."); field.setSelectionRange(0, dot > 0 ? dot : initial.length); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem("");
    try { await onSave(name.trim()); } catch (error) { setProblem((error as Error).message); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {problem && <Notice>{problem}</Notice>}
        <Field label={label}><Input onFocus={(e) => selectName(e.target)} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus /></Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>{action}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** The actions on one row. */
function RowMenu({ entry, can, onOpen, onRename, onMove, onCopy, onDownload, onDelete }: { entry: Entry; can: boolean; onOpen: () => void; onRename: () => void; onMove: () => void; onCopy: () => void; onDownload: () => void; onDelete: () => void }) {
  // Placed against the window, so the table's scrolling edge cannot cut it off. Near the bottom it opens upwards.
  const [open, setOpen] = useState<{ top?: number; bottom?: number; right: number }>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(undefined); };
    const away = () => setOpen(undefined);
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [open]);
  const toggleMenu = (button: HTMLElement) => {
    if (open) return setOpen(undefined);
    const rect = button.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    setOpen(window.innerHeight - rect.bottom < 260 ? { bottom: window.innerHeight - rect.top + 4, right } : { top: rect.bottom + 4, right });
  };
  const item = (Icon: LucideIcon, label: string, act: () => void, danger = false) => (
    <button role="menuitem" type="button" onClick={() => { setOpen(undefined); act(); }} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-sunken ${danger ? "text-danger" : ""}`}><Icon size={14} /> {label}</button>
  );
  return (
    <div ref={box} className="relative inline-block">
      <button type="button" aria-label={`More for ${entry.name}`} aria-haspopup="menu" aria-expanded={!!open} className="icon-btn" onClick={(event) => toggleMenu(event.currentTarget)}><MoreHorizontal size={15} /></button>
      {open && (
        <div role="menu" style={open} className="enter-pop fixed z-40 w-44 rounded-xl border border-line bg-surface p-1 text-left shadow-xl">
          {item(entry.kind === "folder" ? FolderOpen : Eye, entry.kind === "folder" ? "Open" : "View", onOpen)}
          {item(Download, entry.kind === "folder" ? "Download as zip" : "Download", onDownload)}
          {can && item(Pencil, "Rename", onRename)}
          {can && item(FolderInput, "Move to…", onMove)}
          {can && item(Copy, "Copy to…", onCopy)}
          {can && <div className="my-1 border-t border-line" />}
          {can && item(Trash2, "Delete", onDelete, true)}
        </div>
      )}
    </div>
  );
}

type SortKey = "name" | "size" | "modified";

/** Reads every file inside a dropped folder, keeping where each one sits. */
async function droppedFiles(event: DragEvent): Promise<{ file: File; name: string }[]> {
  const found: { file: File; name: string }[] = [];
  const read = async (entry: any, prefix: string): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) {
      const file: File = await new Promise((resolve, reject) => entry.file(resolve, reject));
      found.push({ file, name: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // A folder's entries arrive in batches until an empty one.
      for (;;) {
        const batch: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await read(child, `${prefix}${entry.name}/`);
      }
    }
  };
  const items = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.());
  if (items.some(Boolean)) for (const entry of items) await read(entry, "");
  else for (const file of [...event.dataTransfer.files]) found.push({ file, name: file.name });
  return found;
}

let nextUploadId = 1;

export function Files() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const folder = params.get("folder") ?? "";
  const open = (next: string) => { setParams(next ? { folder: next } : {}); setSelected(new Set()); setFilter(""); };
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: "name", up: true });
  const [viewing, setViewing] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: "folder" } | { kind: "rename"; entry: Entry } | { kind: "move" | "copy"; paths: string[] }>();
  const [message, setMessage] = useState<{ tone: "ok" | "danger"; text: string }>();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<any[]>();
  const [searching, setSearching] = useState(false);
  const mayChange = can("runs:start");

  const list = useQuery({
    queryKey: ["files", path, folder], queryFn: () => api(`${path}/files?folder=${encodeURIComponent(folder)}`),
    refetchInterval: (state) => (state.state.data?.entries?.some((entry: Entry) => ["queued", "indexing"].includes(entry.index?.status ?? "")) ? 2_000 : false),
  });
  const refresh = () => { client.invalidateQueries({ queryKey: ["files", path] }); client.invalidateQueries({ queryKey: ["folders", path] }); };
  const entries: Entry[] = list.data?.entries ?? [];
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase();
    const kept = words ? entries.filter((entry) => entry.name.toLowerCase().includes(words)) : entries;
    const value = (entry: Entry) => (sort.key === "name" ? entry.name.toLowerCase() : sort.key === "size" ? entry.size : new Date(entry.modified).getTime());
    return [...kept].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      const [x, y] = [value(a), value(b)];
      const order = typeof x === "string" ? x.localeCompare(String(y), undefined, { numeric: true }) : Number(x) - Number(y);
      return sort.up ? order : -order;
    });
  }, [entries, filter, sort]);
  const allChosen = shown.length > 0 && shown.every((entry) => selected.has(entry.path));
  const toggle = (item: string) => setSelected((current) => { const next = new Set(current); if (next.has(item)) next.delete(item); else next.add(item); return next; });
  const say = (text: string, tone: "ok" | "danger" = "ok") => { setMessage({ tone, text }); window.setTimeout(() => setMessage((current) => (current?.text === text ? undefined : current)), 6_000); };

  // Several at a time, so a big folder goes up quickly without flooding the server.
  const upload = async (items: { file: File; name: string }[]) => {
    if (!items.length) return;
    const skipped = items.filter((item) => !ALLOWED.test(item.name));
    const wanted = items.filter((item) => ALLOWED.test(item.name));
    // Unique across batches, so a row always follows its own file even when two batches start close together.
    const rows: Upload[] = wanted.map((item) => ({ id: nextUploadId++, name: item.name, state: "waiting" }));
    setUploads((current) => [...current.filter((row) => row.state === "uploading" || row.state === "waiting"), ...rows]);
    const set = (id: number, change: Partial<Upload>) => setUploads((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
    let next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const index = next++;
        const row = rows[index]!;
        set(row.id, { state: "uploading" });
        try {
          await uploadFile(path, wanted[index]!.file, folder, wanted[index]!.name);
          set(row.id, { state: "done" });
        } catch (error) {
          set(row.id, { state: "failed", error: (error as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, wanted.length) }, worker));
    refresh();
    if (skipped.length) say(`${skipped.length} ${skipped.length === 1 ? "file was" : "files were"} left out, because only PDF, Excel, CSV and text files can be added: ${skipped.slice(0, 3).map((item) => baseOf(item.name)).join(", ")}${skipped.length > 3 ? "…" : ""}`, "danger");
  };

  const remove = async (paths: string[]) => {
    const what = paths.length === 1 ? `"${baseOf(paths[0]!)}"` : `${paths.length} items`;
    const folders = entries.filter((entry) => paths.includes(entry.path) && entry.kind === "folder").length;
    if (!confirm(`Delete ${what}?${folders ? " Everything inside the folders goes too." : ""} This cannot be undone.`)) return;
    try {
      const result = await api(`${path}/files/delete`, { body: { paths } });
      setSelected(new Set());
      refresh();
      say(result.failed.length ? `Deleted ${result.done.length}. ${result.failed.length} could not be: ${result.failed[0].error}` : `Deleted ${what}.`, result.failed.length ? "danger" : "ok");
    } catch (error) {
      say((error as Error).message, "danger");
    }
  };

  const download = async (paths: string[]) => {
    const single = entries.find((entry) => entry.path === paths[0]);
    if (paths.length === 1 && single?.kind === "file") { window.location.href = downloadLink(path, single.path); return; }
    try {
      const response = await fetch(`${path}/files/zip`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? "That could not be downloaded.");
      const url = URL.createObjectURL(await response.blob());
      Object.assign(document.createElement("a"), { href: url, download: paths.length === 1 ? `${baseOf(paths[0]!)}.zip` : "files.zip" }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      say((error as Error).message, "danger");
    }
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return setFound(undefined);
    setSearching(true);
    try { setFound((await api(`${path}/knowledge/search`, { body: { query } })).results); } catch (error) { say((error as Error).message, "danger"); } finally { setSearching(false); }
  };

  const drop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (!mayChange) return;
    upload(await droppedFiles(event));
  };
  const crumbs = folder ? folder.split("/") : [];
  const sortHeader = (key: SortKey, label: string, className = "") => (
    <th className={`px-3 py-2 font-medium ${className}`}>
      <button type="button" onClick={() => setSort({ key, up: sort.key === key ? !sort.up : true })} className="inline-flex items-center gap-1 hover:text-ink">
        {label} {sort.key === key && (sort.up ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );
  const active = uploads.filter((row) => row.state === "waiting" || row.state === "uploading").length;

  return (
    <div onDragOver={(event) => { if (mayChange && event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={drop} className="relative">
      <PageHeader icon={FolderOpen} title="Files" description="Documents your agents can read and search, in folders. Other workspaces cannot see them."
        actions={mayChange && (
          <>
            <input ref={filePicker} type="file" hidden multiple accept={ACCEPT} onChange={(e) => { upload([...(e.target.files ?? [])].map((file) => ({ file, name: file.name }))); e.target.value = ""; }} />
            {/* @ts-expect-error webkitdirectory is not in React's types, but every current browser supports it. */}
            <input ref={folderPicker} type="file" hidden multiple webkitdirectory="" onChange={(e) => { upload([...(e.target.files ?? [])].map((file) => ({ file, name: file.webkitRelativePath || file.name }))); e.target.value = ""; }} />
            <Button onClick={() => setDialog({ kind: "folder" })}><FolderPlus size={14} /> New folder</Button>
            <Button onClick={() => folderPicker.current?.click()}><FolderInput size={14} /> Upload folder</Button>
            <Button variant="primary" onClick={() => filePicker.current?.click()}><Upload size={14} /> Upload files</Button>
          </>
        )} />
      <Notice tone="warn">Files are sent to the AI provider when an agent reads them. Use made-up data until your provider's terms are confirmed.</Notice>

      <Card className="mt-3 p-3">
        <form onSubmit={search} className="flex gap-2">
          <Input aria-label="Search inside documents" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setFound(undefined); }} placeholder="Search inside all documents, for example: warranty terms" />
          <Button type="submit" busy={searching}><Search size={14} /> Search</Button>
        </form>
        {found?.length === 0 && <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted"><SearchX size={14} /> Nothing found.</p>}
        {found && found.length > 0 && (
          <ul className="mt-2 divide-y divide-line">
            {found.map((result: any) => (
              <li key={`${result.file}-${result.part}`} className="py-2">
                <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] font-medium">
                  <FileText size={12} className="shrink-0 text-muted" />
                  <button type="button" className="hover:underline" onClick={() => setViewing(result.file)}>{result.file}</button>
                  <span className="font-normal text-faint">· part {result.part} · matched {result.matched === "both" ? "words and meaning" : result.matched === "keywords" ? "words" : "meaning"}</span>
                  {parentOf(result.file) && <button type="button" className="font-normal text-accent hover:underline" onClick={() => open(parentOf(result.file))}>Open folder</button>}
                </p>
                <p className="mt-0.5 line-clamp-3 text-[13px] whitespace-pre-wrap text-muted">{result.text}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {message && <div className="mt-3"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <Card className="mt-3">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 text-[13px]">
            <button type="button" onClick={() => open("")} className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-sunken ${folder ? "text-muted" : "font-medium"}`}><Home size={14} /> Files</button>
            {crumbs.map((part, index) => (
              <span key={index} className="inline-flex items-center gap-0.5">
                <ChevronRight size={13} className="text-faint" />
                <button type="button" onClick={() => open(crumbs.slice(0, index + 1).join("/"))} className={`rounded-md px-1.5 py-1 hover:bg-sunken ${index === crumbs.length - 1 ? "font-medium" : "text-muted"}`}>{part}</button>
              </span>
            ))}
          </nav>
          <div className="relative w-full sm:w-56">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
            <Input aria-label="Filter this folder by name" placeholder="Filter by name" className="h-8 pl-7 text-[13px]" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/40 px-3 py-2 text-[13px]">
            <span className="font-medium">{selected.size} selected</span>
            <Button className="h-8" onClick={() => download([...selected])}><Download size={13} /> Download</Button>
            {mayChange && <Button className="h-8" onClick={() => setDialog({ kind: "move", paths: [...selected] })}><FolderInput size={13} /> Move to…</Button>}
            {mayChange && <Button className="h-8" onClick={() => setDialog({ kind: "copy", paths: [...selected] })}><Copy size={13} /> Copy to…</Button>}
            {mayChange && <Button className="h-8" variant="danger" onClick={() => remove([...selected])}><Trash2 size={13} /> Delete</Button>}
            <button type="button" className="ml-auto inline-flex items-center gap-1 text-muted hover:text-ink" onClick={() => setSelected(new Set())}><X size={13} /> Clear</button>
          </div>
        )}

        {list.isLoading ? <SkeletonRows /> : list.isError ? <div className="p-3"><Notice>{list.error.message}</Notice></div> : entries.length === 0 ? (
          <Empty icon={FolderOpen} title={folder ? "This folder is empty" : "No files yet"} action={mayChange && <Button variant="primary" onClick={() => filePicker.current?.click()}><Upload size={14} /> Upload files</Button>}>
            Drag files or whole folders here, or use the buttons above. PDF, Excel, CSV and text files up to 15 MB each.
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-muted">
                <tr className="border-b border-line">
                  <th className="w-10 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={allChosen} onChange={() => setSelected(allChosen ? new Set() : new Set(shown.map((entry) => entry.path)))} /></th>
                  {sortHeader("name", "Name")}
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Search</th>
                  {sortHeader("size", "Size", "hidden sm:table-cell")}
                  {sortHeader("modified", "Changed", "hidden sm:table-cell")}
                  <th className="w-24 px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {folder && (
                  <tr className="hover:bg-raised">
                    <td />
                    <td colSpan={5} className="px-3 py-2"><button type="button" onClick={() => open(parentOf(folder))} className="inline-flex items-center gap-2 text-muted hover:text-ink"><FolderOpen size={15} /> Up one folder</button></td>
                  </tr>
                )}
                {shown.map((entry) => {
                  const Icon = entry.kind === "folder" ? Folder : fileIcon(entry.name);
                  const openEntry = () => (entry.kind === "folder" ? open(entry.path) : setViewing(entry.path));
                  return (
                    <tr key={entry.path} className={`group ${selected.has(entry.path) ? "bg-accent-soft/30" : "hover:bg-raised"}`}>
                      <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.has(entry.path)} onChange={() => toggle(entry.path)} /></td>
                      <td className="max-w-0 px-3 py-2">
                        <button type="button" onClick={openEntry} title={entry.kind === "folder" ? "Open" : "View"} className="flex max-w-full items-center gap-2 text-left font-medium hover:underline">
                          <Icon size={16} className={`shrink-0 ${entry.kind === "folder" ? "fill-accent/15 text-accent" : "text-muted"}`} /> <span className="truncate">{entry.name}</span>
                        </button>
                      </td>
                      <td className="hidden px-3 py-2 md:table-cell"><SearchState entry={entry} onIndex={async () => { await api(`${path}/files/index`, { body: { path: entry.path } }).catch((error) => say(error.message, "danger")); refresh(); }} /></td>
                      <td className="hidden px-3 py-2 text-muted tabular-nums sm:table-cell">{entry.kind === "file" ? size(entry.size) : "—"}</td>
                      <td className="hidden px-3 py-2 whitespace-nowrap text-muted sm:table-cell">{ago(entry.modified)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {entry.kind === "file" && <a aria-label={`Download ${entry.name}`} title="Download" className="icon-btn inline-flex opacity-0 group-hover:opacity-100 focus:opacity-100" href={downloadLink(path, entry.path)} download={entry.name}><Download size={14} /></a>}
                        <RowMenu entry={entry} can={mayChange} onOpen={openEntry} onDownload={() => download([entry.path])}
                          onRename={() => setDialog({ kind: "rename", entry })} onMove={() => setDialog({ kind: "move", paths: [entry.path] })} onCopy={() => setDialog({ kind: "copy", paths: [entry.path] })} onDelete={() => remove([entry.path])} />
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-[13px] text-muted">Nothing here matches "{filter}".</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {entries.length > 0 && <p className="border-t border-line px-3 py-2 text-[12px] text-faint">{entries.filter((entry) => entry.kind === "folder").length} folders, {entries.filter((entry) => entry.kind === "file").length} files here. Drag files or folders onto this page to upload them into this folder.</p>}
      </Card>

      {uploads.length > 0 && (
        <div className="fixed right-4 bottom-4 z-40 w-80 rounded-xl border border-line bg-surface shadow-xl" role="status">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[13px] font-medium">
            {active ? `Uploading ${active} of ${uploads.length}…` : `Uploaded ${uploads.filter((row) => row.state === "done").length} of ${uploads.length}`}
            {!active && <button type="button" aria-label="Close" className="icon-btn" onClick={() => setUploads([])}><X size={14} /></button>}
          </div>
          <ul className="max-h-56 overflow-y-auto px-3 py-1.5 text-[12px]">
            {uploads.map((row) => (
              <li key={row.id} className="flex items-start gap-2 py-1">
                <span className="w-4 shrink-0 pt-0.5">{row.state === "done" ? <Check size={13} className="text-ok" /> : row.state === "failed" ? <X size={13} className="text-danger" /> : <span className={`block h-3 w-3 rounded-full border-2 ${row.state === "uploading" ? "animate-spin border-accent border-t-transparent" : "border-line"}`} />}</span>
                <span className="min-w-0"><span className="block truncate">{row.name}</span>{row.error && <span className="block text-danger">{row.error}</span>}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface px-8 py-6 text-center shadow-xl">
            <Upload size={22} className="mx-auto text-accent" />
            <p className="mt-2 text-[14px] font-medium">Drop to upload into {folder ? baseOf(folder) : "Files"}</p>
            <p className="text-[12px] text-muted">Files and whole folders</p>
          </div>
        </div>
      )}

      {viewing && <FilePreview file={viewing} onClose={() => setViewing(undefined)} />}
      {dialog?.kind === "folder" && (
        <NameDialog title="New folder" label="Folder name" initial="" action="Create folder" onClose={() => setDialog(undefined)}
          onSave={async (name) => { await api(`${path}/files/folder`, { body: { folder, name } }); setDialog(undefined); refresh(); say(`Created the folder "${name}".`); }} />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog title={`Rename ${dialog.entry.kind}`} label="New name" initial={dialog.entry.name} action="Rename" onClose={() => setDialog(undefined)}
          onSave={async (name) => { await api(`${path}/files/rename`, { body: { path: dialog.entry.path, name } }); setDialog(undefined); setSelected(new Set()); refresh(); }} />
      )}
      {(dialog?.kind === "move" || dialog?.kind === "copy") && (
        <FolderPicker title={dialog.kind === "move" ? "Move to a folder" : "Copy to a folder"} verb={dialog.kind} paths={dialog.paths} onClose={() => setDialog(undefined)}
          onDone={(text) => { setDialog(undefined); setSelected(new Set()); refresh(); say(text); }} />
      )}
    </div>
  );
}

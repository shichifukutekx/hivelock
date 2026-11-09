import { Check, ChevronDown, Download, FileSpreadsheet, FileText, FolderInput, Sheet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspace } from "../lib/workspace.ts";

const FORMATS = [
  { format: "xlsx", label: "Excel spreadsheet", icon: FileSpreadsheet },
  { format: "pdf", label: "PDF document", icon: FileText },
  { format: "csv", label: "CSV (first table)", icon: Sheet },
] as const;

/** Saves what an agent wrote as a file: downloaded now, or kept in Files for others. */
export function ExportMenu({ text, name, compact }: { text: string; name: string; compact?: boolean }) {
  const { path, link, can } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState("");
  const [problem, setProblem] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  const run = async (format: string, save: boolean) => {
    setBusy(`${format}${save}`);
    setProblem("");
    try {
      const response = await fetch(`${path}/exports${save ? "/save" : ""}`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, format, name, folder: save ? "Reports" : undefined }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})))?.error ?? "That could not be made.");
      if (save) {
        setSaved((await response.json()).name);
      } else {
        const url = URL.createObjectURL(await response.blob());
        const anchor = Object.assign(document.createElement("a"), { href: url, download: `${name}.${format}` });
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setOpen(false);
      }
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div ref={box} className="relative inline-block">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setSaved(""); }}
        className={compact ? "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted hover:bg-sunken hover:text-ink" : "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium press hover:bg-raised"}>
        <Download size={compact ? 12 : 13} /> Download <ChevronDown size={compact ? 11 : 12} />
      </button>
      {open && (
        <div role="menu" className="enter-pop absolute right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-1 text-left shadow-xl">
          {FORMATS.map(({ format, label, icon: Icon }) => (
            <button key={format} role="menuitem" type="button" disabled={!!busy} onClick={() => run(format, false)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-sunken disabled:opacity-50">
              <Icon size={14} className="text-accent" /> {busy === `${format}false` ? "Making it…" : label}
            </button>
          ))}
          {can("runs:start") && (
            <>
              <div className="my-1 border-t border-line" />
              {saved ? (
                <p className="flex items-start gap-2 px-2.5 py-2 text-[12px] text-muted"><Check size={14} className="mt-0.5 shrink-0 text-ok" /><span>Saved as <Link className="font-medium text-accent hover:underline" to={link(`/files?folder=${encodeURIComponent(saved.slice(0, saved.lastIndexOf("/")))}`)}>{saved}</Link></span></p>
              ) : (
                <>
                  <button role="menuitem" type="button" disabled={!!busy} onClick={() => run("xlsx", true)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-sunken disabled:opacity-50"><FolderInput size={14} className="text-accent" /> {busy === "xlsxtrue" ? "Saving…" : "Save to Files as Excel"}</button>
                  <button role="menuitem" type="button" disabled={!!busy} onClick={() => run("pdf", true)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-sunken disabled:opacity-50"><FolderInput size={14} className="text-accent" /> {busy === "pdftrue" ? "Saving…" : "Save to Files as PDF"}</button>
                </>
              )}
            </>
          )}
          {problem && <p className="px-2.5 py-1.5 text-[12px] text-danger">{problem}</p>}
        </div>
      )}
    </div>
  );
}

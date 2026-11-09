import { useQuery } from "@tanstack/react-query";
import { Activity, Search, Sparkles, Workflow, type LucideIcon } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";

export interface MenuPage { to: string; label: string; icon: LucideIcon }
interface Item { key: string; label: string; hint: string; to: string; icon: LucideIcon }

const HITS = 5;

/** Finds a page, workflow, run or agent from anywhere. Results come from the lists this person can already read. */
export function CommandMenu({ pages, onClose }: { pages: MenuPage[]; onClose: () => void }) {
  const { path, link } = useWorkspace();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const wanted = useDeferredValue(query.trim());
  const encoded = encodeURIComponent(wanted);
  const searching = wanted.length > 0;
  const workflows = useQuery({ queryKey: ["menu-workflows", path, wanted], queryFn: () => api(`${path}/workflows?q=${encoded}&limit=${HITS}`), enabled: searching });
  const runs = useQuery({ queryKey: ["menu-runs", path, wanted], queryFn: () => api(`${path}/runs?q=${encoded}&limit=${HITS}`), enabled: searching });
  const agents = useQuery({ queryKey: ["agents", path], queryFn: () => api(`${path}/agents`), enabled: searching });

  useEffect(() => {
    input.current?.focus();
    const start = opener.current;
    return () => start?.focus();
  }, []);

  const items = useMemo<Item[]>(() => {
    const lower = wanted.toLowerCase();
    return [
      ...pages.filter((page) => page.label.toLowerCase().includes(lower)).map((page) => ({ key: page.to, label: page.label, hint: "Page", to: page.to, icon: page.icon })),
      ...(!searching ? [] : (workflows.data?.workflows ?? []).map((item: any) => ({ key: item.id, label: item.name, hint: "Workflow", to: link(`/workflows/${item.id}`), icon: Workflow }))),
      ...(!searching ? [] : (agents.data?.agents ?? []).filter((item: any) => item.name.toLowerCase().includes(lower)).slice(0, HITS).map((item: any) => ({ key: item.name, label: item.name, hint: "Agent", to: link(`/agents/${item.name}`), icon: Sparkles }))),
      ...(!searching ? [] : (runs.data?.runs ?? []).map((item: any) => ({ key: item.id, label: item.workflow_name, hint: `Run · ${new Date(item.created_at).toLocaleDateString()}`, to: link(`/runs/${item.id}`), icon: Activity }))),
    ];
  }, [pages, wanted, searching, workflows.data, agents.data, runs.data, link]);

  const go = (item?: Item) => {
    if (!item) return;
    onClose();
    navigate(item.to);
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((active + 1) % Math.max(1, items.length)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((active - 1 + items.length) % Math.max(1, items.length)); }
    if (event.key === "Enter") { event.preventDefault(); go(items[active]); }
    if (event.key === "Escape") onClose();
  };
  return (
    <div className="enter-fade fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Quick search" className="enter-pop w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={15} className="shrink-0 text-faint" />
          <input ref={input} role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={items[active] ? `command-${active}` : undefined} aria-label="Search pages, workflows, agents and runs" placeholder="Search pages, workflows, agents and runs"
            className="h-11 w-full bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={keys} />
        </div>
        <ul id="command-results" role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto p-1">
          {items.map((item, index) => (
            <li key={item.key} id={`command-${index}`} role="option" aria-selected={index === active}>
              <button type="button" tabIndex={-1} onMouseEnter={() => setActive(index)} onClick={() => go(item)} className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] ${index === active ? "bg-sunken" : ""}`}>
                <item.icon size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                <span className="shrink-0 text-[11px] text-faint">{item.hint}</span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="px-2 py-3 text-center text-[13px] text-muted">Nothing found.</li>}
        </ul>
      </div>
    </div>
  );
}

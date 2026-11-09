import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BarChart3, BookMarked, Cable, Check, ChevronsUpDown, ClipboardCheck, FolderOpen, HelpCircle, LayoutDashboard, LayoutTemplate, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plus, ScrollText, Search, Settings, Sparkles, Workflow } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, NavLink, Navigate, Outlet, useNavigate, useLocation } from "react-router-dom";
import { api } from "../lib/api.ts";
import { brand } from "../lib/brand.ts";
import { appLinksFor, web } from "../lib/extensions.ts";
import { workspacePages } from "../lib/paid-pages.tsx";
import { forgetSavedTables } from "../lib/table.ts";
import { useMe, useWorkspace } from "../lib/workspace.ts";
import { CommandMenu } from "./CommandMenu.tsx";
import { BudgetBanner } from "./BudgetBanner.tsx";
import { PauseBanner } from "./PauseAll.tsx";
import { Logo } from "./Logo.tsx";
import { ThemeSwitch } from "./ThemeSwitch.tsx";
import { Spinner } from "./ui.tsx";

const PAGE_TITLES: [RegExp, string][] = [
  [/\/templates\/[^/]+$/, "Template"], [/\/templates$/, "Templates"], [/\/workflows\/[^/]+$/, "Workflow"], [/\/workflows$/, "Workflows"], [/\/runs\/[^/]+$/, "Run"], [/\/runs$/, "Runs"],
  [/\/approvals$/, "Approvals"], [/\/observability$/, "Usage and costs"], [/\/traces\/[^/]+$/, "Timeline"], [/\/agents\/[^/]+$/, "Agent"], [/\/agents$/, "Agents"], [/\/files$/, "Files"],
  [/\/connections$/, "Connections"], [/\/audit$/, "Audit log"], [/\/settings$/, "Settings"],
];
const RAIL_KEY = "hivelock.rail";
const titleFor = (pathname: string) => PAGE_TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? "";

/**
 * The name beside an icon when the menu is collapsed. It shows at once on hover or keyboard focus, and is drawn
 * against the window, so the menu's own scrolling edge cannot cut it off.
 */
function RailTip({ label, detail, enabled, children }: { label: string; detail?: string; enabled: boolean; children: ReactNode }) {
  const [at, setAt] = useState<DOMRect>();
  if (!enabled) return <>{children}</>;
  const show = (event: { currentTarget: HTMLElement }) => setAt(event.currentTarget.getBoundingClientRect());
  return (
    <div onMouseEnter={show} onMouseLeave={() => setAt(undefined)} onFocus={show} onBlur={() => setAt(undefined)} onClick={() => setAt(undefined)}>
      {children}
      {at && createPortal(
        <div role="tooltip" style={{ top: at.top + at.height / 2, left: at.right + 10 }}
          className="enter-fade pointer-events-none fixed z-[60] hidden -translate-y-1/2 items-center gap-2 rounded-lg bg-[#0d2018] px-2.5 py-1.5 text-[12px] font-medium whitespace-nowrap text-white shadow-lg ring-1 ring-white/10 lg:flex">
          <span aria-hidden="true" className="absolute top-1/2 -left-1 h-2 w-2 -translate-y-1/2 rotate-45 bg-[#0d2018]" />
          {label}
          {detail && <span className="font-normal text-white/60">{detail}</span>}
        </div>,
        document.body,
      )}
    </div>
  );
}

function WorkspaceSwitcher({ compact }: { compact?: boolean }) {
  const me = useMe();
  const { id, workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <RailTip enabled={!!compact && !open} label={workspace?.name ?? ""} detail={workspace?.role ? workspace.role[0]!.toUpperCase() + workspace.role.slice(1) : undefined}>
      <button aria-expanded={open} aria-label={compact ? `Workspace: ${workspace?.name}` : undefined} onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-2 rounded-lg py-1.5 text-left hover:bg-rail-active ${compact ? "lg:justify-center lg:px-0" : ""} px-2`}>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-[12px] font-semibold text-accent-ink">{workspace?.name[0]?.toUpperCase()}</span>
        <span className={`min-w-0 flex-1 ${compact ? "lg:hidden" : ""}`}>
          <span className="block truncate text-[13px] font-medium text-white">{workspace?.name}</span>
          <span className="block text-[11px] text-rail-muted capitalize">{workspace?.role}</span>
        </span>
        <ChevronsUpDown size={14} className={`shrink-0 text-rail-muted ${compact ? "lg:hidden" : ""}`} />
      </button>
      </RailTip>
      {open && <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />}
      {open && (
        <div className={`enter-pop absolute top-full left-0 z-30 mt-1 origin-top rounded-lg border border-line bg-surface p-1 text-ink shadow-lg ${compact ? "w-56 lg:min-w-56" : "right-0"}`}>
          {me.data?.workspaces.map((w) => (
            <Link key={w.id} to={`/w/${w.id}`} onClick={() => setOpen(false)} className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-sunken ${w.id === id ? "font-medium" : ""}`}><span className="truncate">{w.name}</span>{w.id === id && <Check size={14} className="shrink-0 text-accent" />}</Link>
          ))}
          {me.data?.canCreateWorkspaces && <Link to="/new-workspace" onClick={() => setOpen(false)} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-muted hover:bg-sunken"><Plus size={14} /> New workspace</Link>}
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const me = useMe();
  const { link, workspace, path, can } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  // On wide screens the menu can shrink to its icons. The choice is kept for next time.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(RAIL_KEY) === "collapsed"; } catch { return false; } });
  const toggleRail = () => setCollapsed((current) => {
    try { localStorage.setItem(RAIL_KEY, current ? "open" : "collapsed"); } catch {}
    return !current;
  });
  const approvals = useQuery({
    queryKey: ["approvals", path, "count"],
    queryFn: () => api(`${path}/approvals?limit=1`),
    refetchInterval: 10_000,
    enabled: !!workspace,
  });
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((current) => !current);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        toggleRail();
      }
    };
    addEventListener("keydown", open);
    return () => removeEventListener("keydown", open);
  }, []);
  const pageLabel = titleFor(location.pathname);
  useEffect(() => {
    if (workspace) document.title = [pageLabel, workspace.name, brand.name].filter(Boolean).join(" · ");
    return () => { document.title = brand.name; };
  }, [pageLabel, workspace?.name]);

  if (me.isLoading || (!workspace && me.isFetching)) return <Spinner />;
  if (!workspace) return <Navigate to="/" replace />;
  const gate = web.workspaceGate;
  if (gate?.applies(workspace)) return <gate.Component owner={workspace.role === "owner"} onDone={() => client.invalidateQueries()} />;

  const signOut = async () => {
    await api("/api/auth/sign-out", { body: {} });
    await client.resetQueries();
    forgetSavedTables();
    navigate("/sign-in");
  };

  const waiting = (approvals.data?.total ?? 0) + (approvals.data?.chats.length ?? 0);
  const items = [
    { to: link(), label: "Overview", icon: LayoutDashboard, end: true },
    { to: link("/templates"), label: "Templates", icon: LayoutTemplate },
    { to: link("/workflows"), label: "Workflows", icon: Workflow },
    { to: link("/runs"), label: "Runs", icon: Activity },
    { to: link("/approvals"), label: "Approvals", icon: ClipboardCheck, count: waiting },
    { to: link("/observability"), label: "Usage and costs", icon: BarChart3 },
    { to: link("/agents"), label: "Agents", icon: Sparkles },
    { to: link("/files"), label: "Files", icon: FolderOpen },
    { to: link("/memory"), label: "Company memory", icon: BookMarked },
    ...(can("connections:list") ? [{ to: link("/connections"), label: "Connections", icon: Cable }] : []),
    ...workspacePages().filter(({ permission }) => !permission || can(permission)).map(({ to, label, icon }) => ({ to: link(to), label, icon })),
    ...(can("audit:read") ? [{ to: link("/audit"), label: "Audit log", icon: ScrollText }] : []),
    { to: link("/settings"), label: "Settings", icon: Settings },
    { to: link("/help"), label: "Help", icon: HelpCircle },
    ...appLinksFor(me.data).map(({ to, label, icon }) => ({ to, label, icon })),
  ];
  const hide = collapsed ? "lg:hidden" : "";
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  // The builder needs the whole window.
  const fullBleed = /\/workflows\/[^/]+$|\/runs\/[^/]+$|\/agents\/[^/]+$/.test(location.pathname);

  return (
    <div className="flex h-full">
      {menuOpen && <div className="enter-fade fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMenuOpen(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-rail p-3 text-rail-ink transition-[transform,width] duration-200 ease-out lg:static lg:translate-x-0 ${collapsed ? "lg:w-16 lg:px-2" : ""} ${menuOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className={`mb-3 flex items-center gap-2 py-1 font-display text-[15px] font-semibold tracking-tight text-white ${collapsed ? "px-2 lg:flex-col lg:px-0" : "px-2"}`}>
          <Logo size={22} className="shrink-0 text-honey" /> <span className={`min-w-0 flex-1 truncate ${hide}`}>{brand.name}</span>
          <RailTip enabled={collapsed} label="Expand the menu" detail={`${shortcut} \\`}>
            <button type="button" onClick={toggleRail} aria-label={collapsed ? "Expand the menu" : "Collapse the menu"} title={collapsed ? undefined : `Collapse the menu (${shortcut} \\)`}
              className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-rail-muted hover:bg-rail-active hover:text-white lg:flex">
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </RailTip>
        </div>
        <WorkspaceSwitcher compact={collapsed} />
        <div className="mt-3">
          <RailTip enabled={collapsed} label="Search" detail={shortcut === "⌘" ? "⌘K" : "Ctrl K"}>
            <button type="button" onClick={() => setSearching(true)} aria-label="Search"
              className={`press flex h-8 w-full items-center gap-2 rounded-lg border border-white/10 px-2 text-[12px] text-rail-muted hover:bg-rail-active hover:text-white ${collapsed ? "lg:justify-center lg:px-0" : ""}`}>
              <Search size={14} className="shrink-0" /><span className={`flex-1 text-left ${hide}`}>Search</span><kbd className={`font-sans text-[11px] ${hide}`}>{shortcut === "⌘" ? "⌘K" : "Ctrl K"}</kbd>
            </button>
          </RailTip>
        </div>
        <nav aria-label="Main" className="mt-3 min-h-0 flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden">
          {items.map(({ to, label, icon: Icon, end, count }) => (
            <RailTip key={to} enabled={collapsed} label={label} detail={count ? `${count} waiting` : undefined}>
            <NavLink to={to} end={end} onClick={() => setMenuOpen(false)} aria-label={collapsed ? label : undefined}
              className={({ isActive }) => `press rail-link relative flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] ${collapsed ? "lg:justify-center lg:px-0" : ""} ${isActive ? "active bg-rail-active font-medium text-white" : "text-rail-ink hover:bg-rail-active hover:text-white"}`}>
              <Icon size={15} className="shrink-0" />
              <span className={`flex-1 truncate ${hide}`}>{label}</span>
              {!!count && <span aria-label={`${count} waiting`} className={`rounded-full bg-honey px-1.5 text-[11px] font-semibold text-honey-ink tabular-nums ${collapsed ? "lg:absolute lg:top-0.5 lg:right-0.5 lg:px-1 lg:text-[9px] lg:leading-[14px]" : ""}`}>{count}</span>}
            </NavLink>
            </RailTip>
          ))}
        </nav>
        <div className="border-t border-white/10 pt-2">
          {collapsed && <div className="hidden lg:block"><RailTip enabled label="Light / dark mode"><ThemeSwitch compact /></RailTip></div>}
          <div className={hide}><ThemeSwitch /></div>
          <div className={`truncate px-2 text-[12px] text-rail-muted ${hide}`}>{me.data?.user.email}</div>
          <RailTip enabled={collapsed} label="Sign out" detail={me.data?.user.email}>
          <button onClick={signOut} aria-label="Sign out"
            className={`mt-1 flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] text-rail-ink hover:bg-rail-active hover:text-white ${collapsed ? "lg:justify-center lg:px-0" : ""}`}><LogOut size={15} className="shrink-0" /> <span className={hide}>Sign out</span></button>
          </RailTip>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 items-center border-b border-line bg-surface px-2 lg:hidden">
          <button aria-label="Open menu" onClick={() => setMenuOpen(true)} className="rounded-lg p-2 hover:bg-sunken"><Menu size={18} /></button>
          <span className="ml-1 truncate text-[13px] font-medium">{workspace.name}</span>
        </div>
        <PauseBanner />
          <BudgetBanner />
        <main className={`min-h-0 flex-1 ${fullBleed ? "overflow-hidden" : "overflow-y-auto"}`}>
          {/* The canvas pages only fade: a moving ancestor would throw off React Flow's first measurements. */}
          {fullBleed ? <div key={location.pathname} className="enter-fade h-full"><Outlet /></div> : <div key={location.pathname} className="enter-page mx-auto max-w-6xl p-4 sm:p-6 lg:p-8 xl:max-w-7xl 2xl:max-w-[1680px] min-[2200px]:max-w-[2040px] min-[2200px]:px-12"><Outlet /></div>}
        </main>
      </div>
      {searching && <CommandMenu pages={items} onClose={() => setSearching(false)} />}
    </div>
  );
}

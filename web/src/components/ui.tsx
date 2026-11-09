import { AlertCircle, AlertTriangle, Ban, Check, CheckCircle2, Clock, Hourglass, Info, Loader2, Mail, Minus, Play, Webhook, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { capitalize } from "../lib/table.ts";

const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

const variants = {
  primary: "bg-accent text-accent-ink hover:brightness-110 border-transparent",
  secondary: "bg-surface text-ink hover:bg-sunken border-line-strong",
  ghost: "bg-transparent text-muted hover:bg-sunken hover:text-ink border-transparent",
  danger: "bg-surface text-danger hover:bg-danger-soft border-danger/40",
};

export function Button({ variant = "secondary", busy, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={join("inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium whitespace-nowrap press disabled:opacity-50", variants[variant], className)}
    >
      {busy && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  );
}

const fieldClass = "field w-full rounded-[10px] px-3 text-[13px] text-ink placeholder:text-faint focus:outline-none";

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} className={join(fieldClass, "h-9", className)} />;
export const Select = ({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} className={join(fieldClass, "field-select h-9 pr-8", className)} />;
export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} className={join(fieldClass, "py-2 leading-relaxed", className)} />;

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-ink/80">{label}</span>
      {children}
      {help && <span className="mt-1 block text-[12px] leading-snug text-faint">{help}</span>}
    </label>
  );
}

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <section className={join("card-soft rounded-2xl border border-line bg-surface", className)}>{children}</section>
);

const CELLS = 14;

/** How much of something is used, as a row of honeycomb cells. With no share, nothing is being used up, so the cells only show the shape. */
export function Cells({ share, label }: { share?: number; label: string }) {
  const filled = share === undefined ? 0 : Math.max(share > 0 ? 1 : 0, Math.round((Math.min(share, 100) / 100) * CELLS));
  const tone = share === undefined ? "open" : share >= 90 ? "full" : share >= 75 ? "high" : "";
  return (
    <span role="img" aria-label={label} className={join("cells", tone)}>
      {Array.from({ length: CELLS }, (_, cell) => <i key={cell} className={cell < filled ? "on" : undefined} style={{ animationDelay: `${cell * 18}ms` }} />)}
    </span>
  );
}

/** The hover shared by every card that opens something. */
export const cardHover = "lift card-hover";

const tileTones = {
  accent: "bg-accent-soft text-accent", neutral: "bg-sunken text-muted", ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger", info: "bg-info-soft text-info",
};

/** An icon in a soft rounded tile, for headers, cards and empty states. */
export const IconTile = ({ icon: Icon, tone = "accent", size = 32, className }: { icon: LucideIcon; tone?: keyof typeof tileTones; size?: number; className?: string }) => (
  <span aria-hidden="true" style={{ width: size, height: size, borderRadius: size * 0.27 }} className={join("inline-flex shrink-0 items-center justify-center", tileTones[tone], className)}>
    <Icon size={Math.round(size * 0.47)} />
  </span>
);

/** The title of a card or section. The tile also tells the card to show its faint comb. */
export const Heading = ({ icon: Icon, className, children }: { icon: LucideIcon; className?: string; children: ReactNode }) => (
  <h2 className={join("section-head flex items-center gap-2.5 text-[15px] font-semibold tracking-tight", className)}><IconTile icon={Icon} size={28} className="brand-tile" /> {children}</h2>
);

export function PageHeader({ title, description, actions, icon }: { title: string; description?: string; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <IconTile icon={icon} size={36} className="brand-tile" />}
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-0.5 max-w-2xl text-[13px] text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

const tones: Record<string, string> = {
  succeeded: "bg-ok-soft text-ok", done: "bg-ok-soft text-ok", enabled: "bg-ok-soft text-ok", live: "bg-ok-soft text-ok",
  running: "bg-info-soft text-info", pending: "bg-sunken text-muted",
  waiting: "bg-warn-soft text-warn", changed: "bg-warn-soft text-warn",
  failed: "bg-danger-soft text-danger", declined: "bg-danger-soft text-danger",
  cancelled: "bg-sunken text-muted", skipped: "bg-sunken text-faint", disabled: "bg-sunken text-muted", draft: "bg-sunken text-muted",
};
const statusNames: Record<string, string> = { waiting: "Needs approval", succeeded: "Succeeded", running: "Running", failed: "Failed", cancelled: "Cancelled" };
export const statusLabel = (status: string) => statusNames[status] ?? capitalize(status);

const badgeIcons: Record<string, LucideIcon> = { succeeded: Check, done: Check, failed: X, declined: X, waiting: Hourglass, changed: AlertTriangle, cancelled: Ban, skipped: Minus };
const badgeDots = new Set(["running", "live", "enabled", "pending", "disabled"]);

/** A small colored dot. Running ones pulse, and that pulse is the only loop outside the canvas. */
export const StatusDot = ({ running, className }: { running?: boolean; className?: string }) => <span aria-hidden="true" className={join("status-dot", running && "running", className)} />;

/** Pass `icon` where a status color is used for something that is not a status, or null for plain text. */
export const Badge = ({ status, children, icon }: { status: string; children?: ReactNode; icon?: LucideIcon | null }) => {
  const Icon = icon === undefined ? badgeIcons[status] : icon;
  return (
    <span className={join("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap capitalize", tones[status] ?? "bg-sunken text-muted")}>
      {Icon ? <Icon size={11} className="shrink-0" /> : icon === undefined && badgeDots.has(status) && <StatusDot running={status === "running"} />}
      {children ?? statusNames[status] ?? status}
    </span>
  );
};

const triggerIcons: Record<string, LucideIcon> = { manual: Play, schedule: Clock, webhook: Webhook, email: Mail };

/** What started a run. */
export const TriggerLabel = ({ kind }: { kind: string }) => {
  const Icon = triggerIcons[kind] ?? Play;
  return <span className="inline-flex items-center gap-1.5"><Icon size={13} className="shrink-0 text-faint" />{kind}</span>;
};

const noticeIcons = { danger: AlertCircle, warn: AlertTriangle, info: Info, ok: CheckCircle2 };

export const Notice = ({ tone = "danger", icon, children }: { tone?: "danger" | "warn" | "info" | "ok"; icon?: LucideIcon; children: ReactNode }) => {
  const styles = { danger: "bg-danger-soft text-danger", warn: "bg-warn-soft text-warn", info: "bg-info-soft text-info", ok: "bg-ok-soft text-ok" };
  const Icon = icon ?? noticeIcons[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={join("enter-fade flex gap-2 rounded-lg px-3 py-2 text-[13px] leading-snug", styles[tone])}>
      <Icon size={14} className="mt-[3px] shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
};

export const Empty = ({ title, children, action, icon, visual }: { title: string; children?: ReactNode; action?: ReactNode; icon?: LucideIcon; visual?: ReactNode }) => (
  <div className="flex flex-col items-center px-6 py-12 text-center">
    {(visual || icon) && <span className="mb-3 flex">{visual ?? <IconTile icon={icon!} size={44} />}</span>}
    <p className="text-[14px] font-medium">{title}</p>
    {children && <p className="mt-1 max-w-sm text-[13px] text-muted">{children}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const Spinner = () => (
  <div className="flex items-center justify-center py-16 text-faint" role="status" aria-label="Loading">
    <Loader2 size={20} className="animate-spin" />
  </div>
);

const ROW_WIDTHS = ["w-2/5", "w-1/3", "w-1/2", "w-1/4"];

/** Stands in for a table or list. It holds still on purpose: skeletons do not shimmer here. */
export const SkeletonRows = ({ rows = 5 }: { rows?: number }) => (
  <div role="status" aria-label="Loading" className="divide-y divide-line">
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="flex items-center gap-4 px-4 py-3.5">
        <span className={join("skeleton h-3", ROW_WIDTHS[index % ROW_WIDTHS.length])} />
        <span className="skeleton ml-auto h-3 w-16" />
        <span className="skeleton hidden h-3 w-20 sm:block" />
      </div>
    ))}
  </div>
);

export const SkeletonCards = ({ count = 6, className = "grid gap-3 md:grid-cols-2" }: { count?: number; className?: string }) => (
  <div role="status" aria-label="Loading" className={className}>
    {Array.from({ length: count }, (_, index) => (
      <Card key={index} className="p-4">
        <span className="skeleton h-3 w-2/5" />
        <span className="skeleton mt-3 h-3 w-full" />
        <span className="skeleton mt-2 h-3 w-3/5" />
      </Card>
    ))}
  </div>
);

export const SkeletonStats = ({ count = 4 }: { count?: number }) => (
  <div role="status" aria-label="Loading" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
    {Array.from({ length: count }, (_, index) => (
      <Card key={index} className="p-4">
        <span className="skeleton h-3 w-3/5" />
        <span className="skeleton mt-3 h-6 w-2/5" />
      </Card>
    ))}
  </div>
);

/** A stray click or Escape should not lose what was typed, so once anything has changed those two ask first. Cancel and Done stay direct. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const changed = useRef(false);
  const dismiss = useRef(() => {});
  dismiss.current = () => { if (!changed.current || confirm("Discard what you entered here?")) onClose(); };
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss.current(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <div className="enter-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => event.target === event.currentTarget && dismiss.current()}>
      <div role="dialog" aria-modal="true" aria-label={title} onInput={(event) => { if ((event.target as HTMLElement).tagName !== "INPUT" || (event.target as HTMLInputElement).type !== "search") changed.current = true; }} className={join("enter-pop flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-xl", wide ? "max-w-2xl" : "max-w-md")}>
        {/* The title bar stays put and only the body scrolls, so nothing can slide above or under it. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-6 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button type="button" aria-label="Close" className="icon-btn" onClick={() => dismiss.current()}><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-4 pb-6">{children}</div>
      </div>
    </div>
  );
}

export const Code = ({ value }: { value: unknown }) => (
  <pre className="max-h-72 overflow-auto rounded-lg bg-sunken p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
    {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
  </pre>
);

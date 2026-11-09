import { useQuery } from "@tanstack/react-query";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Cable, Check, CircleSlash, GitBranch, Hourglass, Loader2, Play, ShieldCheck, Sparkles, X } from "lucide-react";
import type { ComponentType } from "react";
import { api } from "../lib/api.ts";
import { STEP_BRANCHES, STEP_LABELS } from "../lib/flow.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { ConnectorIcon } from "./ConnectorIcon.tsx";

export const STEP_ICONS: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  start: Play, agent: Sparkles, condition: GitBranch, approval: ShieldCheck, connector: Cable,
};

const STEP_COLORS: Record<string, string> = {
  start: "bg-sunken text-ink", agent: "bg-accent-soft text-accent", condition: "bg-info-soft text-info",
  approval: "bg-warn-soft text-warn", connector: "bg-sunken text-muted",
};

const statusStyle: Record<string, { border: string; icon?: ComponentType<{ size?: number; className?: string }>; text: string; tone: string }> = {
  running: { border: "border-accent pulse-ring", icon: Loader2, text: "Working", tone: "text-accent" },
  pending: { border: "border-accent/60", icon: Hourglass, text: "Queued", tone: "text-muted" },
  waiting: { border: "border-warn", icon: Hourglass, text: "Needs approval", tone: "text-warn" },
  done: { border: "border-ok/60", icon: Check, text: "Done", tone: "text-ok" },
  failed: { border: "border-danger", icon: X, text: "Failed", tone: "text-danger" },
  skipped: { border: "border-line border-dashed opacity-60", icon: CircleSlash, text: "Skipped", tone: "text-faint" },
};

/** A step's icon in its soft tile, the same on the canvas, in the palette and in the settings panel. */
export function StepTile({ type, size = 32 }: { type: string; size?: number }) {
  const Icon = STEP_ICONS[type] ?? Cable;
  return <span aria-hidden="true" style={{ width: size, height: size }} className={`flex shrink-0 items-center justify-center rounded-lg ${STEP_COLORS[type] ?? "bg-sunken"}`}><Icon size={Math.round(size * 0.47)} /></span>;
}

function describe(type: string, config: any): string {
  if (type === "agent") return config.agent ?? "Choose an agent";
  if (type === "condition") return config.path ? `${config.path} ${String(config.operator ?? "").replace("_", " ")} ${config.value ?? ""}` : "Set the condition";
  if (type === "approval") return config.message ?? "Write the question";
  if (type === "connector") return config.action ?? "Choose a connection";
  return "When this workflow starts";
}

/** The connector behind a step. Shares the connections query the pages already make, so nodes add no requests of their own. */
function useStepConnector(connectionId?: string) {
  const { path, can } = useWorkspace();
  const connections = useQuery({ queryKey: ["connections", path], queryFn: () => api(`${path}/connections`), enabled: !!connectionId && can("connections:list") });
  return connections.data?.connections.find((item: any) => item.id === connectionId)?.connector as string | undefined;
}

export function StepNode({ data, selected }: NodeProps) {
  const { stepType, label, config, status } = data as { stepType: string; label: string; config: any; status?: string };
  const connector = useStepConnector(stepType === "connector" ? config.connectionId : undefined);
  const state = status ? statusStyle[status] : undefined;
  const StateIcon = state?.icon;
  const branches = STEP_BRANCHES[stepType];
  return (
    <div className={`w-56 rounded-xl border bg-surface ${state?.border ?? "border-line-strong"} ${selected ? "ring-2 ring-accent/50" : ""}`}>
      {stepType !== "start" && <Handle type="target" position={Position.Left} />}
      <div className="flex items-center gap-2.5 p-2.5">
        {connector ? <ConnectorIcon name={connector} size={32} /> : <StepTile type={stepType} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] leading-tight font-medium">{label}</div>
          <div className="truncate text-[11px] leading-snug text-muted">{describe(stepType, config)}</div>
        </div>
      </div>
      {state && (
        <div className={`flex items-center gap-1 border-t border-line px-2.5 py-1 text-[11px] font-medium ${state.tone}`}>
          {StateIcon && <StateIcon size={11} className={status === "running" ? "animate-spin" : ""} />} {state.text}
        </div>
      )}
      {branches ? branches.map((branch, index) => (
        <Handle key={branch} type="source" id={branch} position={Position.Right} title={branch} style={{ top: `${30 + index * 40}%`, background: branch === "true" || branch === "approved" ? "var(--ok)" : "var(--danger)", borderColor: "var(--surface)" }} />
      )) : <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const nodeTypes = { step: StepNode };
export const stepTitle = (type: string) => STEP_LABELS[type] ?? type;

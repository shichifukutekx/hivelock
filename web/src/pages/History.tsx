import { useQuery } from "@tanstack/react-query";
import { Background, ReactFlow, ReactFlowProvider, type Edge, type Node } from "@xyflow/react";
import { History as HistoryIcon, X } from "lucide-react";
import { useMemo, useState } from "react";
import { nodeTypes } from "../components/StepNode.tsx";
import { Badge, Notice, SkeletonRows, Heading } from "../components/ui.tsx";
import { api, when } from "../lib/api.ts";
import { toCanvas } from "../lib/flow.ts";
import { Locked } from "../lib/edition.tsx";
import { web } from "../lib/extensions.ts";
import { useWorkspace } from "../lib/workspace.ts";

function ReadOnlyCanvas({ definition }: { definition: any }) {
  const canvas = useMemo(() => toCanvas(definition), [definition]);
  return (
    <div className="h-56 overflow-hidden rounded-lg border border-line">
      <ReactFlowProvider>
        <ReactFlow nodes={canvas.nodes as Node[]} edges={canvas.edges as Edge[]} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null}
          fitView fitViewOptions={{ maxZoom: 0.8, padding: 0.2 }} minZoom={0.1}>
          <Background gap={20} color="var(--line-strong)" />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

function VersionDetail({ workflowId, entry, current, others, dirty, locked, onRestored }: { workflowId: string; entry: any; current: number; others: any[]; dirty: boolean; locked: boolean; onRestored: () => void }) {
  const { path } = useWorkspace();
  const detail = useQuery({ queryKey: ["version", workflowId, entry.version], queryFn: () => api(`${path}/workflows/${workflowId}/versions/${entry.version}`), staleTime: Infinity });
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <div>
        <h3 className="text-[13px] font-medium">Version {entry.version}</h3>
        <p className="text-[12px] text-muted">{entry.saved_by_name ?? "Unknown"} · {when(entry.saved_at)}</p>
        {entry.note && <p className="mt-1 text-[13px]">{entry.note}</p>}
      </div>
      {detail.isLoading ? <span role="status" aria-label="Loading" className="skeleton h-56" /> : detail.isError ? <Notice>This version could not be opened.</Notice> : <ReadOnlyCanvas definition={detail.data.version.definition} />}
      {locked || !web.VersionActions
        ? <Locked>Compare and restore are locked.</Locked>
        : <web.VersionActions workflowId={workflowId} entry={entry} current={current} others={others} dirty={dirty} onRestored={onRestored} />}
    </div>
  );
}

/** Saved versions never change. Restoring saves a new one, so the list only grows. */
export function HistoryPanel({ workflowId, dirty, onClose, onRestored }: { workflowId: string; dirty: boolean; onClose: () => void; onRestored: () => void }) {
  const { path } = useWorkspace();
  const history = useQuery({ queryKey: ["versions", workflowId], queryFn: () => api(`${path}/workflows/${workflowId}/versions`) });
  const [selected, setSelected] = useState<number>();
  const versions: any[] = history.data?.versions ?? [];
  const entry = versions.find((item) => item.version === selected);
  return (
    <aside aria-label="Version history" className="enter-side max-h-[60%] shrink-0 space-y-3 overflow-y-auto border-t border-line bg-surface p-4 md:max-h-none md:w-[26rem] md:border-t-0 md:border-l">
      <div className="flex items-center justify-between">
        <Heading icon={HistoryIcon}>History</Heading>
        <button aria-label="Close history" onClick={onClose} className="rounded p-1 text-faint hover:bg-sunken hover:text-ink"><X size={14} /></button>
      </div>
      {history.isLoading ? <SkeletonRows rows={4} /> : history.isError ? <Notice>History could not be loaded.</Notice> : (
        <>
          <p className="text-[12px] text-faint">{history.data.locked
            ? `The latest ${history.data.keep} versions of each workflow can be read here. Older ones stay stored.`
            : `The latest ${history.data.keep} versions of each workflow are kept. Older ones are removed overnight, unless a run in progress used them. A run keeps its own copy either way.`}</p>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {versions.map((item) => (
              <li key={item.version}>
                <button onClick={() => setSelected(item.version === selected ? undefined : item.version)} aria-pressed={item.version === selected} className={`w-full p-2.5 text-left text-[13px] hover:bg-raised ${item.version === selected ? "bg-raised" : ""}`}>
                  <span className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">v{item.version}</span>
                    {item.version === history.data.current && <Badge status="live">Current</Badge>}
                    {item.restored_from !== null && <span className="text-[12px] text-faint">restored from v{item.restored_from}</span>}
                    <span className="ml-auto text-[12px] text-faint">{item.steps} steps</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted">{item.saved_by_name ?? "Unknown"} · {when(item.saved_at)}</span>
                  {item.note && <span className="mt-0.5 block truncate text-[12px]">{item.note}</span>}
                </button>
              </li>
            ))}
          </ul>
          {entry && <VersionDetail key={entry.version} workflowId={workflowId} entry={entry} current={history.data.current} others={versions.filter((item) => item.version !== entry.version)} dirty={dirty} locked={!!history.data.locked} onRestored={onRestored} />}
        </>
      )}
    </aside>
  );
}

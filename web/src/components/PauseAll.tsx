import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePause, Play } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { Button, Field, Input, Modal, Notice } from "./ui.tsx";

const usePause = () => {
  const { path, workspace } = useWorkspace();
  return useQuery<{ paused: boolean; reason: string | null }>({ queryKey: ["pause", path], queryFn: () => api(`${path}/pause`), enabled: !!workspace, refetchInterval: 15_000 });
};

/** Shown on every page while paused, so nobody wonders why nothing is moving. */
export function PauseBanner() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const pause = usePause();
  const resume = useMutation({ mutationFn: () => api(`${path}/resume`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["pause", path] }) });
  if (!pause.data?.paused) return null;
  return (
    <div role="status" className="enter-fade flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-warn-soft px-4 py-2 text-[13px] text-warn">
      <CirclePause size={15} className="shrink-0" />
      <p className="min-w-0 flex-1"><strong className="font-semibold">Everything is paused.</strong> Runs, chats and changes are on hold, and held work carries on after you resume.{pause.data.reason && ` Reason: ${pause.data.reason}`}</p>
      {resume.isError && <span>{resume.error.message}</span>}
      {can("members:manage") ? <Button busy={resume.isPending} onClick={() => resume.mutate()}><Play size={14} /> Resume</Button> : <span>An admin can resume.</span>}
    </div>
  );
}

/** One click and a reason. Stopping is meant to be quick, so anyone who can approve can do it. */
export function PauseButton() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const pause = usePause();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const stop = useMutation({
    mutationFn: () => api(`${path}/pause`, { method: "POST", body: { reason } }),
    onSuccess: () => { setOpen(false); setReason(""); client.invalidateQueries({ queryKey: ["pause", path] }); },
  });
  if (!can("runs:approve") || !pause.data || pause.data.paused) return null;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}><CirclePause size={14} /> Pause all</Button>
      {open && (
        <Modal title="Pause everything in this workspace?" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">
              <li>No new runs or chats start, and schedules and webhooks are refused.</li>
              <li>Runs in progress hold at their next step and carry on after Resume.</li>
              <li>Agents cannot change anything, and approvals cannot be granted. You can still decline.</li>
            </ul>
            <Field label="Reason (optional)"><Input maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
            {stop.isError && <Notice>{stop.error.message}</Notice>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(false)}>Keep running</Button>
              <Button variant="danger" busy={stop.isPending} onClick={() => stop.mutate()}><CirclePause size={14} /> Pause all</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

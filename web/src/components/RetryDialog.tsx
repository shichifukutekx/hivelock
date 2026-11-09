import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";
import { Button, Modal, Notice, Spinner } from "./ui.tsx";

const versionNote = (fromVersion: number, version: number | null) => {
  if (version === null) return undefined;
  return version === fromVersion
    ? `It uses the workflow as saved now, version ${version}, which is the version this run used.`
    : `It uses the workflow as saved now, version ${version}, not version ${fromVersion}, which this run used. Steps may differ.`;
};

/** Asks first, with what the server says this would do: which version runs, and which outside actions would happen a second time. */
function RetryDialog({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { path, link } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const plan = useQuery({ queryKey: ["retry-plan", runId], queryFn: () => api(`${path}/runs/${runId}/retry`), staleTime: 0, gcTime: 0 });
  const effects: { nodeId: string; label: string; finished: boolean }[] = plan.data?.effects ?? [];
  const retry = useMutation({
    mutationFn: () => api(`${path}/runs/${runId}/retry`, { body: { repeatEffects: effects.length > 0 } }),
    onSuccess: ({ runId: newRun }) => {
      client.invalidateQueries({ queryKey: ["runs", path] });
      client.invalidateQueries({ queryKey: ["run", runId] });
      onClose();
      navigate(link(`/runs/${newRun}`));
    },
  });
  const already = plan.data?.retriedAs ?? (retry.error as { body?: { retriedAs?: string } } | null)?.body?.retriedAs;
  return (
    <Modal title="Run this again?" onClose={onClose}>
      {plan.isLoading ? <Spinner /> : plan.isError ? <Notice>{plan.error.message}</Notice> : already ? (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">This run has already been run again, and a run can only be repeated once.</p>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Close</Button>
            <Link to={link(`/runs/${already}`)} onClick={onClose}><Button variant="primary"><ArrowRight size={14} /> Open the new run</Button></Link>
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted">This starts a new run from the beginning with the same input. This run stays as it was, and it can be run again only once.</p>
          {plan.data.version !== null && <p className="text-muted">{versionNote(plan.data.fromVersion, plan.data.version)}</p>}
          {effects.length > 0 && (
            <Notice tone="warn">
              <p className="font-medium">These actions changed something outside this app, and will happen again:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {effects.map(({ nodeId, label, finished }) => <li key={nodeId}>{label}: {finished ? "finished" : "started, and may have happened"}</li>)}
              </ul>
            </Notice>
          )}
          {retry.isError && <Notice>{retry.error.message}</Notice>}
          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant={effects.length ? "danger" : "primary"} busy={retry.isPending} onClick={() => retry.mutate()}><RotateCcw size={14} /> {effects.length ? "Repeat them and run again" : "Run again"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** `start` opens the question, and `dialog` goes anywhere on the page. */
export function useRetryRun() {
  const [runId, setRunId] = useState<string>();
  return { start: setRunId, dialog: runId ? <RetryDialog key={runId} runId={runId} onClose={() => setRunId(undefined)} /> : null };
}

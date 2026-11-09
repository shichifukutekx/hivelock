import { useMutation, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Field, Input, Modal, Notice, SkeletonRows, Textarea } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { inputFields, type WorkflowDefinition } from "../lib/flow.ts";
import { useWorkspace } from "../lib/workspace.ts";

const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, (first) => first.toUpperCase());

/**
 * Starts a workflow. It asks for the values the workflow reads, in plain fields, and JSON stays one click away for anything richer.
 * `beforeRun` saves first when the builder has changes, so what runs is what is on screen.
 */
export function RunModal({ workflowId, definition, beforeRun, onClose }: { workflowId: string; definition?: WorkflowDefinition; beforeRun?: () => Promise<unknown>; onClose: () => void }) {
  const { path, link } = useWorkspace();
  const navigate = useNavigate();
  const saved = useQuery({ queryKey: ["workflow", workflowId], queryFn: () => api(`${path}/workflows/${workflowId}`), enabled: !definition });
  const shape: WorkflowDefinition | undefined = definition ?? saved.data?.workflow.definition;
  const fields = inputFields(shape);
  const [values, setValues] = useState<Record<string, string>>({});
  const [asJson, setAsJson] = useState(false);
  const [json, setJson] = useState("{\n  \n}");
  const [problem, setProblem] = useState("");
  const run = useMutation({
    mutationFn: async (input: unknown) => {
      await beforeRun?.();
      return api(`${path}/workflows/${workflowId}/runs`, { body: { input } });
    },
    onSuccess: ({ runId }) => navigate(link(`/runs/${runId}`)),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem("");
    if (!asJson) return run.mutate(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")));
    try {
      run.mutate(JSON.parse(json || "{}"));
    } catch {
      setProblem("That is not valid JSON. Check for a missing quote or comma.");
    }
  };
  return (
    <Modal title="Run this workflow" onClose={onClose}>
      {!shape ? <SkeletonRows rows={2} /> : (
        <form onSubmit={submit} className="space-y-3">
          {beforeRun && <Notice tone="info">Your changes are saved first, then this version runs.</Notice>}
          {(problem || run.isError) && <Notice>{problem || run.error?.message}</Notice>}
          {asJson ? (
            <Field label="Run input" help="Available to steps as input, for example {{input.customer}}.">
              <Textarea rows={7} className="font-mono" value={json} onChange={(e) => setJson(e.target.value)} />
            </Field>
          ) : fields.length === 0 ? <p className="text-[13px] text-muted">This workflow does not ask for any input.</p> : fields.map((name, index) => (
            <Field key={name} label={words(name)}><Input autoFocus={index === 0} value={values[name] ?? ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} /></Field>
          ))}
          <div className="flex items-center justify-between gap-2">
            <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => setAsJson(!asJson)}>{asJson ? "Use plain fields" : "Use JSON instead"}</button>
            <div className="flex gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" variant="primary" busy={run.isPending}><Play size={14} /> Run now</Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}

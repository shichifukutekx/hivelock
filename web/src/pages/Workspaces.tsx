import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button, Field, IconTile, Input, Notice, Spinner } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { appLinksFor } from "../lib/extensions.ts";
import { useMe } from "../lib/workspace.ts";

export function Home() {
  const me = useMe();
  if (me.isLoading) return <Spinner />;
  const first = me.data?.workspaces[0];
  if (first) return <Navigate to={`/w/${first.id}`} replace />;
  // With no workspace there is no menu, so the page it would have linked to comes first.
  const elsewhere = appLinksFor(me.data)[0];
  if (elsewhere) return <Navigate to={elsewhere.to} replace />;
  if (me.data?.canCreateWorkspaces) return <Navigate to="/new-workspace" replace />;
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="enter-page flex max-w-sm flex-col items-center rounded-2xl border border-line bg-surface p-7 card-soft text-center">
        <span className="mb-3 flex"><IconTile icon={Layers} size={44} /></span>
        <h1 className="text-lg font-semibold tracking-tight">No workspace yet</h1>
        <p className="mt-1 text-[13px] text-muted">Ask your administrator for an invitation link, then open it to join.</p>
      </div>
    </main>
  );
}

const slugFor = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace"}-${Math.random().toString(36).slice(2, 7)}`;

export function NewWorkspace() {
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const client = useQueryClient();
  const create = useMutation({
    mutationFn: () => api("/api/auth/organization/create", { body: { name, slug: slugFor(name) } }),
    onSuccess: async ({ id }) => {
      // Clears the saved list, so the app cannot open the new workspace from a list without it.
      client.removeQueries({ queryKey: ["me"] });
      navigate(`/w/${id}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="enter-page w-full max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-7 card-soft">
        <IconTile icon={Layers} size={36} />
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Create a workspace</h1>
          <p className="mt-1 text-[13px] text-muted">Each project gets its own workflows, connections and people. Workspaces cannot see each other.</p>
        </div>
        {create.isError && <Notice>{create.error.message}</Notice>}
        <Field label="Workspace name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales team" autoFocus required maxLength={80} /></Field>
        <Button type="submit" variant="primary" busy={create.isPending} className="w-full"><Plus size={14} /> Create workspace</Button>
      </form>
    </main>
  );
}

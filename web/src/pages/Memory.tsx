import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Check, Lightbulb, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button, Card, Empty, IconTile, Modal, Notice, PageHeader, SkeletonRows, Textarea } from "../components/ui.tsx";
import { ago, api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";

interface Note { id: string; content: string; status: "active" | "suggested"; suggested_by_agent?: string | null; created_at: string; updated_at: string }

const EXAMPLES = [
  "Our financial year runs from April to March.",
  "Quote prices in euros, without VAT, unless the customer asks otherwise.",
  "Customer replies are signed \"The sales team\", never with a person's name.",
];

/** Notes every agent reads. People write them; agents can only suggest, and a person accepts or declines. */
export function Memory() {
  const { path, can } = useWorkspace();
  const client = useQueryClient();
  const editable = can("agents:write");
  const [editing, setEditing] = useState<{ id?: string; content: string; suggestion?: boolean } | null>(null);
  const list = useQuery({ queryKey: ["company-notes", path], queryFn: () => api<{ notes: Note[]; limit: number }>(`${path}/company-notes`) });
  const refresh = () => client.invalidateQueries({ queryKey: ["company-notes", path] });
  const save = useMutation({
    mutationFn: ({ id, content }: { id?: string; content: string }) =>
      api(id ? `${path}/company-notes/${id}` : `${path}/company-notes`, { method: id ? "PUT" : "POST", body: { content } }),
    onSuccess: () => { setEditing(null); refresh(); },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`${path}/company-notes/${id}`, { method: "DELETE" }), onSuccess: refresh });

  const notes = list.data?.notes ?? [];
  const active = notes.filter((note) => note.status === "active");
  const suggested = notes.filter((note) => note.status === "suggested");
  const busy = (id: string) => (save.isPending && save.variables?.id === id) || (remove.isPending && remove.variables === id);

  return (
    <>
      <PageHeader icon={BookMarked} title="Company memory"
        description="Facts and rules every agent here follows, such as policies, formats and standing deadlines."
        actions={editable && <Button variant="primary" onClick={() => { save.reset(); setEditing({ content: "" }); }}><Plus size={14} /> Add a note</Button>} />
      {(save.isError || remove.isError) && !editing && <div className="mb-3"><Notice>{(save.error ?? remove.error)?.message}</Notice></div>}

      {suggested.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><Lightbulb size={14} className="text-warn" /> Suggested by agents <span className="text-muted">({suggested.length})</span></h2>
          <p className="mb-3 text-[12px] text-muted">Agents use a suggestion only after someone accepts it. You can change the wording first.</p>
          <div className="space-y-2">
            {suggested.map((note) => (
              <Card key={note.id} className="flex flex-wrap items-start justify-between gap-3 border-warn/40 p-4">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <IconTile icon={Sparkles} tone="warn" />
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words text-[14px]">{note.content}</p>
                    <p className="mt-1 text-[12px] text-muted">From {note.suggested_by_agent ?? "an agent"} · {ago(note.created_at)}</p>
                  </div>
                </div>
                {editable && (
                  <div className="flex shrink-0 gap-2">
                    <Button disabled={busy(note.id)} onClick={() => remove.mutate(note.id)}><X size={14} /> Decline</Button>
                    <Button disabled={busy(note.id)} onClick={() => { save.reset(); setEditing({ id: note.id, content: note.content, suggestion: true }); }}><Pencil size={14} /> Edit</Button>
                    <Button variant="primary" busy={busy(note.id)} onClick={() => save.mutate({ id: note.id, content: note.content })}><Check size={14} /> Accept</Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      {list.isLoading ? <Card><SkeletonRows rows={4} /></Card> : active.length === 0 ? (
        <Card>
          <Empty icon={BookMarked} title="No company notes yet"
            action={editable && <Button variant="primary" onClick={() => setEditing({ content: "" })}><Plus size={14} /> Add the first note</Button>}>
            <span className="block">Write down what every agent should know, so nobody has to repeat it in each chat. For example:</span>
            <span className="mt-2 block space-y-1 text-left">{EXAMPLES.map((example) => <span key={example} className="block">“{example}”</span>)}</span>
          </Empty>
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {active.map((note, index) => (
            <div key={note.id} className="group flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 w-6 shrink-0 text-right text-[12px] tabular-nums text-muted">{index + 1}.</span>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-[14px]">{note.content}</p>
                <p className="mt-0.5 text-[12px] text-muted">{note.suggested_by_agent ? `Suggested by ${note.suggested_by_agent}, accepted` : "Added"} {ago(note.updated_at)}</p>
              </div>
              {editable && (
                <div className="flex shrink-0 gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <button type="button" aria-label="Edit note" className="press rounded-md p-1.5 text-muted hover:bg-sunken hover:text-ink" onClick={() => { save.reset(); setEditing({ id: note.id, content: note.content }); }}><Pencil size={14} /></button>
                  <button type="button" aria-label="Remove note" disabled={busy(note.id)} className="press rounded-md p-1.5 text-muted hover:bg-sunken hover:text-danger" onClick={() => remove.mutate(note.id)}><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
      {active.length > 0 && <p className="mt-3 text-[12px] text-muted">{active.length} of {list.data?.limit ?? 100} notes. Agents with memory turned on can suggest new ones as they work.</p>}

      {editing && (
        <Modal title={editing.suggestion ? "Accept with changes" : editing.id ? "Edit note" : "Add a note"} onClose={() => setEditing(null)}>
          <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); save.mutate({ id: editing.id, content: editing.content }); }}>
            <Textarea autoFocus rows={4} maxLength={1000} value={editing.content} onChange={(event) => setEditing({ ...editing, content: event.target.value })}
              placeholder={EXAMPLES[0]} aria-label="Note" className="w-full" />
            <p className="text-[12px] text-muted">One fact or rule, in plain words. Every agent in this workspace reads it. {editing.content.trim().length}/1000</p>
            {save.isError && <Notice>{save.error.message}</Notice>}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setEditing(null)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={save.isPending} disabled={editing.content.trim().length < 5}>{editing.suggestion ? "Accept" : "Save"}</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

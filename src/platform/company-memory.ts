import type { PoolClient } from "pg";
import { redactSecrets } from "./guardrails.ts";
import { seal, unseal } from "./secrets.ts";

/**
 * Company memory: short notes every agent in a workspace reads, such as "Our financial year starts in April"
 * or "Quote prices in euros". People write them. An agent can only suggest one, and it waits until a person accepts it.
 */

export const NOTE_LENGTH = 1_000;
export const MAX_NOTES = 100;
export const MAX_SUGGESTIONS = 25;
/** What reaches each agent, so a long list cannot crowd out its own instructions. */
const PROMPT_BUDGET = 6_000;

/** The one place company notes are sealed. */
export const sealedNote = (masterKey: string, workspaceId: string, text: string) =>
  JSON.stringify(seal(masterKey, workspaceId, redactSecrets(text.trim().slice(0, NOTE_LENGTH)).text));

/** Accepted notes, oldest first so the list reads in the order it was built, cut to fit the prompt. */
export async function activeNotes(db: PoolClient, masterKey: string, workspaceId: string) {
  const { rows } = await db.query("select content from company_notes where status = 'active' order by created_at, id limit $1", [MAX_NOTES]);
  const notes: string[] = [];
  let used = 0;
  for (const row of rows) {
    const text = String(unseal(masterKey, workspaceId, row.content) ?? "").trim();
    if (!text || used + text.length > PROMPT_BUDGET) continue;
    used += text.length;
    notes.push(text);
  }
  return notes;
}

/** The part of every agent's instructions that carries company memory. Empty when there is none. */
export function companyMemoryText(notes: string[]) {
  if (!notes.length) return "";
  return `\n\nCompany memory. People in this workspace wrote or approved these notes for every agent. Follow them unless the person you are helping says otherwise:\n${notes.map((note) => `- ${note.replace(/\s*\n\s*/g, " ")}`).join("\n")}`;
}

/** Queues an agent's suggestion for a person. Repeats and a full queue are answered plainly, not stored. */
export async function suggestNote(db: PoolClient, masterKey: string, workspaceId: string, agentName: string, text: string) {
  const note = text.trim();
  if (note.length < 5) return "That note is too short to be useful.";
  const { rows } = await db.query("select content from company_notes where status = 'suggested'");
  if (rows.length >= MAX_SUGGESTIONS) return "Several suggestions are already waiting for a person, so this one was not added.";
  const known = [...rows, ...(await db.query("select content from company_notes where status = 'active'")).rows]
    .map((row) => String(unseal(masterKey, workspaceId, row.content) ?? "").trim().toLowerCase());
  if (known.includes(note.slice(0, NOTE_LENGTH).toLowerCase())) return "Company memory already has that note.";
  await db.query(
    "insert into company_notes (workspace_id, content, status, suggested_by_agent) values ($1, $2, 'suggested', $3)",
    [workspaceId, sealedNote(masterKey, workspaceId, note), agentName],
  );
  return "Suggested. A person will see it under Company memory, and agents use it only once it is accepted.";
}

import type { Pool } from "pg";
import type { AgentDefinition } from "../agents/types.ts";
import { activeNotes, companyMemoryText } from "./company-memory.ts";
import { capabilityTools } from "./connectors/agent-tools.ts";
import { inWorkspace } from "./db.ts";
import { assertNotPaused, reserveStorage } from "./limits.ts";
import { DATA_NOTICE, markAsData } from "./engine/template.ts";
import { redactPersonalData, redactSecrets } from "./guardrails.ts";
import type { NetworkPolicy } from "./net/safe-fetch.ts";
import type { Knowledge } from "./knowledge.ts";
import { workspaceModels } from "./model-providers.ts";
import { recordSpan, type TraceKind } from "./observability.ts";
import { unseal } from "./secrets.ts";

const MAX_MEMORIES = 30;
const GROUNDING_RULES = `

Rules for answering from documents:
- Passages found for this message are listed below. If they do not answer it, call search_knowledge with different words before saying the documents do not cover something.
- An earlier reply saying something is not covered may be wrong, so judge each question from the passages alone.
- State only what the passages say. Never add details, reasons, conditions or examples of your own, however likely they seem.
- If the passages do not answer part of the question, say that the documents do not cover that part.
- Name the file for each fact.`;

interface Source {
  pool: Pool;
  workspaceId: string;
  masterKey: string;
  network: NetworkPolicy;
  search?: Knowledge["search"];
}

/** Adds an agent's skills, company memory and its own memories to its instructions. Memories stay marked as data, so they cannot act as commands. */
export const agentInstructions = ({ pool, workspaceId, masterKey }: Source) => async (agent: AgentDefinition) => {
  const { skills, memories, company } = await inWorkspace(pool, workspaceId, async (db) => ({
    skills: agent.skills?.length ? (await db.query("select name, instructions from agent_skills where name = any($1) order by name", [agent.skills])).rows : [],
    memories: agent.memory ? (await db.query("select content from agent_memories where agent_name = $1 order by created_at desc limit $2", [agent.name, MAX_MEMORIES])).rows : [],
    company: await activeNotes(db, masterKey, workspaceId),
  }));
  const parts = skills.map((skill) => `\n\nSkill "${skill.name}":\n${skill.instructions}`);
  // Agents have no clock, so anything about due dates or age would otherwise be a guess.
  parts.push(`\n\nThe current time is ${new Date().toISOString().slice(0, 16)} UTC.`);
  parts.push(companyMemoryText(company));
  if (agent.knowledge) parts.push(GROUNDING_RULES);
  if (memories.length) {
    const notes = memories.map((m) => markAsData(String(unseal(masterKey, workspaceId, m.content)))).join("\n");
    parts.push(`\n\nThings you were asked to remember:\n${notes}\n\n${DATA_NOTICE}`);
  }
  return parts.join("");
};

/** Searches on every message, so finding the documents does not depend on a model choosing to look. */
const documentContext = ({ workspaceId, search }: Source) => async (agent: AgentDefinition, prompt: string) => {
  if (!agent.knowledge || !search) return "";
  const found = await search(workspaceId, prompt).catch(() => []);
  if (!found.length) return "\n\nNo passages matched this message.";
  const passages = found.map((item) => `${item.file}, part ${item.part}:\n${markAsData(redactSecrets(item.text).text)}`);
  return `\n\nPassages found for this message:\n${passages.join("\n\n")}\n\n${DATA_NOTICE}`;
};

export const runOptions = (source: Source) => ({
  contextFor: documentContext(source),
  agentTools: capabilityTools(source, source.search),
  instructionsFor: agentInstructions(source),
  modelsFor: workspaceModels(source.pool, source.workspaceId, source.masterKey),
  // An agent may already be running when someone presses Pause all, so every approved action is checked at the last moment.
  beforeApprovedAction: () => inWorkspace(source.pool, source.workspaceId, (db) => assertNotPaused(db, source.workspaceId)),
  // Files an agent saves count like uploads, so the storage limit holds however a file arrives.
  recordWrite: (bytes: number) => reserveStorage(source.pool, source.workspaceId, bytes),
});

/** The last check on an agent's answer. Credentials always go, and personal data goes if the workspace says so. */
export async function checkAnswer({ pool, workspaceId }: Source, traceId: string, traceKind: TraceKind, agent: string, answer: string) {
  const secrets = redactSecrets(answer);
  const { rows: [settings] } = await inWorkspace(pool, workspaceId, (db) => db.query("select redact_personal_data from workspace_settings where workspace_id = $1", [workspaceId]));
  const personal = settings?.redact_personal_data ? redactPersonalData(secrets.text) : { text: secrets.text, found: 0 };
  if (secrets.found) await recordSpan(pool, workspaceId, traceId, traceKind, { kind: "guardrail", name: "secret_removed", agent, status: "refused" });
  if (personal.found) await recordSpan(pool, workspaceId, traceId, traceKind, { kind: "guardrail", name: "personal_data_removed", agent, status: "refused" });
  return personal.text;
}

import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { BlueprintStep, Template } from "./types.ts";

export const MAX_CUSTOM_TEMPLATES = 200;
const PREFIX = "custom-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const customRowId = (templateId: string) => {
  const id = templateId.startsWith(PREFIX) ? templateId.slice(PREFIX.length) : "";
  return UUID.test(id) ? id : undefined;
};

export interface CustomRow {
  id: string;
  base_template_id: string;
  name: string;
  outcome: string;
  description: string;
  instructions: string | null;
  prompts: Record<string, string>;
  cron: string | null;
}

export const customEdit = z.object({
  name: z.string().trim().min(3).max(80),
  outcome: z.string().trim().min(20).max(160).regex(/^[^\r\n]*$/),
  description: z.string().trim().min(20).max(1_000),
  instructions: z.string().trim().min(200).max(6_000).optional(),
  prompts: z.record(z.string(), z.string().trim().min(1).max(4_000)).default({}),
  cron: z.string().trim().max(100).optional(),
});
export type CustomEdit = z.infer<typeof customEdit>;

const references = (text: string) => [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]!);
const placeholders = (text: string) => [...text.matchAll(/\[\[([^\]]*)\]\]/g)].map((match) => match[1]!);
const agentSteps = (template: Template) => (template.workflow?.steps ?? []).filter((step): step is Extract<BlueprintStep, { type: "agent" }> => step.type === "agent");

const fiveFieldCron = (cron: string) => {
  if (cron.split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
};

/** Says what is wrong with an edit, in words for the person making it. */
export function editProblem(base: Template, edit: CustomEdit) {
  const asked = new Set(base.questions.map((question) => question.key));
  const unknown = (text: string) => placeholders(text).find((key) => !asked.has(key));
  if (edit.instructions !== undefined) {
    if (!base.agent) return "This template has no agent to give instructions to.";
    if (edit.instructions.includes("{{")) return "Agent instructions cannot use {{ }}. Those belong in a step.";
    if (unknown(edit.instructions) !== undefined) return "The instructions use a [[value]] this template does not ask for.";
  }
  const steps = new Map(agentSteps(base).map((step) => [step.id, step]));
  for (const [id, prompt] of Object.entries(edit.prompts)) {
    const step = steps.get(id);
    if (!step) return "Only an agent step's prompt can be changed.";
    const allowed = new Set(references(step.prompt));
    // A step can only use what the original step used, so it never reads something that does not exist at that point.
    if (references(prompt).some((path) => !allowed.has(path))) return `The prompt for "${step.label}" uses a {{value}} that step cannot read.`;
    if (unknown(prompt) !== undefined) return `The prompt for "${step.label}" uses a [[value]] this template does not ask for.`;
  }
  if (edit.cron !== undefined) {
    if (base.run.kind !== "schedule") return "This template does not run on a schedule.";
    if (!fiveFieldCron(edit.cron)) return "That schedule is not valid.";
  }
  return undefined;
}

const agentNameFrom = (name: string, fallback: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  return /^[a-z][a-z0-9-]{2,}$/.test(slug) ? slug : fallback;
};

/** The original, with only the saved words changed. Everything that decides what runs comes from the code. */
export function customTemplate(base: Template, row: CustomRow): Template {
  return {
    ...base,
    id: `${PREFIX}${row.id}`,
    name: row.name,
    outcome: row.outcome,
    description: row.description,
    custom: { baseId: base.id, baseName: base.name },
    run: base.run.kind === "schedule" && row.cron ? { ...base.run, cron: row.cron, note: "On the schedule saved in this template." } : base.run,
    agent: base.agent && { ...base.agent, name: agentNameFrom(row.name, base.agent.name), instructions: row.instructions ?? base.agent.instructions },
    workflow: base.workflow && {
      ...base.workflow,
      steps: base.workflow.steps.map((step) => (step.type === "agent" && row.prompts[step.id] ? { ...step, prompt: row.prompts[step.id]! } : step)),
    },
  };
}

import type { ModelRole } from "../../config.ts";

export const CATEGORIES = {
  sales: "Sales",
  support: "Customer support",
  finance: "Finance",
  hr: "People and HR",
  operations: "Operations and purchasing",
  quality: "Quality and compliance",
  legal: "Legal",
  it: "IT and security",
  engineering: "Engineering",
  marketing: "Marketing",
  executive: "Executive",
} as const;

export type Category = keyof typeof CATEGORIES;
export type Difficulty = "starter" | "intermediate" | "advanced";

/** A connection the person chooses when installing. */
export interface Slot {
  key: string;
  connector: string;
  purpose: string;
}

/** A value the person fills in. Each kind has a strict shape, so an answer can only ever be a value. */
export interface Question {
  key: string;
  label: string;
  help?: string;
  kind: "text" | "email" | "channel" | "id" | "number" | "choice";
  default?: string | number;
  optional?: boolean;
  options?: string[];
  min?: number;
  max?: number;
}

/** How a person would start it. Only advice: installing creates no trigger. */
export type RunHint =
  | { kind: "chat"; note: string }
  | { kind: "channel"; note: string }
  | { kind: "manual"; note: string; input: Record<string, string> }
  | { kind: "webhook"; note: string; input: Record<string, string> }
  | { kind: "schedule"; note: string; cron: string }
  | { kind: "email"; note: string };

export interface AgentBlueprint {
  name: string;
  description: string;
  /** The name people see. The template's name when left out. */
  title?: string;
  /** Example first messages, offered as one-click starts in a chat. */
  starters?: string[];
  model: ModelRole;
  /** The job itself. Grounding and data rules are added at install, so no template can leave them out. */
  instructions: string;
  /** Actions on the chosen connections, written as [slot, action]. */
  tools?: [string, string][];
  /** Workspace file tools. Saving asks a person first. */
  files?: ("list_files" | "read_file" | "save_file")[];
  knowledge?: boolean;
  /** The output feeds a medical, legal, financial or HR decision, so the agent is told a person decides. */
  humanDecides?: boolean;
}

export type BlueprintStep =
  | { id: string; type: "agent"; label: string; prompt: string }
  | { id: string; type: "approval"; label: string; message: string }
  | { id: string; type: "condition"; label: string; path: string; operator: "equals" | "not_equals" | "contains" | "greater_than" | "less_than" | "exists"; value?: string | number | boolean }
  | { id: string; type: "connector"; label: string; slot: string; action: string; params: Record<string, unknown> };

export interface Blueprint {
  steps: BlueprintStep[];
  edges: { from: string; to: string; when?: string }[];
}

export interface Template {
  id: string;
  name: string;
  /** One line: what a person gets. */
  outcome: string;
  /** What it does, in two or three plain sentences. */
  description: string;
  category: Category;
  role: string;
  difficulty: Difficulty;
  connections: Slot[];
  questions: Question[];
  run: RunHint;
  agent?: AgentBlueprint;
  workflow?: Blueprint;
  /** Set on a workspace's edited copy. */
  custom?: { baseId: string; baseName: string };
}

export const slot = (key: string, connector: string, purpose: string): Slot => ({ key, connector, purpose });

export const ask = {
  text: (key: string, label: string, help?: string, extra: Partial<Question> = {}): Question => ({ key, label, help, kind: "text", ...extra }),
  email: (key: string, label: string, help?: string): Question => ({ key, label, help, kind: "email" }),
  channel: (key: string, label = "Slack channel", help = "For example #sales or a channel id."): Question => ({ key, label, help, kind: "channel" }),
  id: (key: string, label: string, help?: string): Question => ({ key, label, help, kind: "id" }),
  number: (key: string, label: string, value: number, min: number, max: number, help?: string): Question => ({ key, label, help, kind: "number", default: value, min, max }),
  choice: (key: string, label: string, options: string[], help?: string): Question => ({ key, label, help, kind: "choice", options, default: options[0] }),
};

export const think = (id: string, label: string, prompt: string): BlueprintStep => ({ id, type: "agent", label, prompt });
export const approve = (id: string, label: string, message: string): BlueprintStep => ({ id, type: "approval", label, message });
export const call = (id: string, label: string, slotKey: string, action: string, params: Record<string, unknown>): BlueprintStep =>
  ({ id, type: "connector", label, slot: slotKey, action, params });

type Link = BlueprintStep | Fork;
interface Fork { step: BlueprintStep & { type: "condition" }; yes: Link[]; no?: Link[] }

/** A condition. Each side runs its own steps and the workflow ends there, so a branch cannot rejoin past an approval. */
export const fork = (id: string, label: string, test: { path: string; operator: "contains" | "greater_than" | "less_than" | "equals" | "not_equals" | "exists"; value?: string | number | boolean }, yes: Link[], no?: Link[]): Fork =>
  ({ step: { id, type: "condition", label, ...test }, yes, no });

/** Lays steps out in order from the start step. Each approval's next step follows its approved branch. */
export function flow(...links: Link[]): Blueprint {
  const steps: BlueprintStep[] = [];
  const edges: Blueprint["edges"] = [];
  const walk = (from: string, branch: string | undefined, rest: Link[]) => {
    let previous = from;
    let when = branch;
    for (const link of rest) {
      const step = "step" in link ? link.step : link;
      steps.push(step);
      edges.push({ from: previous, to: step.id, ...(when ? { when } : {}) });
      if ("step" in link) {
        walk(step.id, "true", link.yes);
        if (link.no) walk(step.id, "false", link.no);
        return;
      }
      previous = step.id;
      when = step.type === "approval" ? "approved" : undefined;
    }
  };
  walk("start", undefined, links);
  return { steps, edges };
}

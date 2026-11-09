import { engineeringTemplates } from "./engineering.ts";
import { executiveTemplates } from "./executive.ts";
import { financeTemplates } from "./finance.ts";
import { hrTemplates } from "./hr.ts";
import { itTemplates } from "./it.ts";
import { legalTemplates } from "./legal.ts";
import { marketingTemplates } from "./marketing.ts";
import { operationsTemplates } from "./operations.ts";
import { qualityTemplates } from "./quality.ts";
import { salesTemplates } from "./sales.ts";
import { supportTemplates } from "./support.ts";
import type { Template } from "./types.ts";

/** Add a new category's file here. */
export const templates: Template[] = [
  ...salesTemplates, ...supportTemplates, ...financeTemplates, ...hrTemplates, ...operationsTemplates, ...qualityTemplates,
  ...legalTemplates, ...itTemplates, ...engineeringTemplates, ...marketingTemplates, ...executiveTemplates,
];

const byId = new Map(templates.map((template) => [template.id, template]));
export const getTemplate = (id: string) => byId.get(id);

const byAgent = new Map(templates.flatMap((template) => (template.agent ? [[template.agent.name, template] as const] : [])));
/** The template an agent was installed from, going by its name. A second copy is named like "name-2". */
export const templateOfAgent = (agentName: string) => byAgent.get(agentName) ?? byAgent.get(agentName.replace(/-\d+$/, ""));

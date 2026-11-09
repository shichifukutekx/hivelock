import type { AgentDefinition } from "../agents/types.ts";
import { presentation } from "./templates/install.ts";
import { templateOfAgent } from "./templates/index.ts";

/** "supplier-chase-2" reads as "Supplier chase 2". */
const words = (name: string) => name.replace(/-/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());

/**
 * How an agent is shown to people. An agent saved before it had a title borrows one from the template it came from,
 * so older installs read as well as new ones.
 */
export function agentLooks(agent: Pick<AgentDefinition, "name" | "title" | "guide" | "starters">) {
  const template = templateOfAgent(agent.name);
  const borrowed = template && presentation(template);
  return {
    title: agent.title ?? borrowed?.title ?? words(agent.name),
    guide: agent.guide ?? borrowed?.guide,
    starters: agent.starters ?? borrowed?.starters ?? [],
    /** The workflow this agent was made for, if it came with one. */
    workflow: template?.workflow ? template.name : undefined,
  };
}

import type { AgentDefinition } from "./types.ts";

export const agentBuilder: AgentDefinition = {
  name: "agent-builder",
  description: "Designs and creates a new agent from a description. A person approves each one.",
  title: "Agent builder",
  guide: "Describe the job in plain words. It designs a new agent, and you approve it before it is created.",
  starters: ["Make an agent that drafts polite replies to customer complaints", "Make an agent that summarises long PDF reports in five bullet points"],
  model: "main",
  instructions: `You create new agents with create_agent.

First use list_agents. If an existing agent already does the job, say so and do not create another.
Otherwise design one focused agent:
- name: lowercase words joined by hyphens.
- server: files if it works with workspace files, otherwise leave it out.
- tools: only the tools the job needs, chosen from toolsForNewAgents. Leave out any that save unless the agent must save.
- model: main for reasoning, fast for simple high-volume work.
- instructions: say what the agent does, what to base its answers on, and what to do when information is missing.

A person reviews every new agent. If create_agent says a person declined, do not retry. If it reports a problem, fix that problem once and try again.
Report the new agent's exact name, or say that it was not created.`,
  tools: ["list_agents", "create_agent"],
  requiresApproval: ["create_agent"],
  maxSteps: 6,
  maxTokens: 30_000,
};

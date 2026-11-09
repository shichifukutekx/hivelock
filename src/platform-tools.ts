import type { StructuredToolInterface } from "@langchain/core/tools";
import type { AgentDefinition } from "./agents/types.ts";
import { toolCatalog, type AgentDirectory } from "./agents/registry.ts";
import { DATA_NOTICE, markAsData } from "./platform/engine/template.ts";
import { redactSecrets } from "./platform/guardrails.ts";
import { guardedTool, type ToolContext } from "./tools.ts";

export type RunChild = (agent: AgentDefinition, task: string) => Promise<string>;

const NEW_AGENT_FIELDS = ["name", "description", "server", "tools", "model", "instructions"];
/** The model chooses only these. Connections, memory and the like are not in the tool's schema, and a model can send them anyway. */
const newAgent = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([field]) => NEW_AGENT_FIELDS.includes(field)));

/** Tools the platform itself provides. They run here, not in an MCP server, because they act on the team. */
export function platformTools(context: ToolContext, runChild: RunChild, directory: AgentDirectory): StructuredToolInterface[] {
  const { agent } = context;
  const available: StructuredToolInterface[] = [
    guardedTool(context, {
      name: "list_agents",
      description: "List the agents on the team, what each one does, and the tools a new agent can be given.",
      schema: { type: "object", properties: {} },
      run: async () =>
        JSON.stringify({
          agents: (await directory.list())
            .filter((a) => a.name !== agent.name)
            .map(({ name, description, tools }) => ({ name, description, tools })),
          toolsForNewAgents: toolCatalog,
        }),
    }),
    guardedTool(context, {
      name: "delegate",
      description: "Give one task to another agent and wait for its answer. Include everything it needs in the task.",
      schema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Exact agent name from list_agents." },
          task: { type: "string", description: "The full task, with all details and file names." },
        },
        required: ["agent", "task"],
      },
      run: async (args) => {
        const target = await directory.get(String(args.agent));
        if (!target) throw new Error(`There is no agent named ${args.agent}. Use list_agents.`);
        const off = await directory.turnedOff?.(target.name);
        if (off) return off;
        // Only a top-level orchestrator delegates, so work can never loop between agents.
        if (target.tools.includes("delegate")) throw new Error("A managing agent cannot be given work.");
        // A helper's answer can repeat whatever its tools read, so it is data here too.
        return `${markAsData(redactSecrets(await runChild(target, String(args.task))).text)}\n\n${DATA_NOTICE}`;
      },
    }),
    guardedTool(context, {
      name: "create_agent",
      description: "Create a new agent. A person reviews it first. It gets only the listed tools and cannot create or manage agents.",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string", description: "One sentence on what the agent does." },
          server: { type: "string", enum: Object.keys(toolCatalog).filter((name) => name !== "rfq") },
          tools: { type: "array", items: { type: "string" } },
          model: { type: "string", enum: ["main", "fast", "coding"] },
          instructions: { type: "string" },
        },
        required: ["name", "description", "model", "instructions"],
      },
      // Shown to the person: the agent exactly as it would run, including the limits this code sets.
      display: (args) => directory.prepare(newAgent(args)),
      run: async (args) => {
        const created = await directory.save(newAgent(args));
        return `Created agent ${created.name}. It can now be given work.`;
      },
    }),
  ];
  return available.filter((t) => agent.tools.includes(t.name));
}

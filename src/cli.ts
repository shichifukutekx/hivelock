import { createInterface } from "node:readline/promises";
import { getAgent, listAgents } from "./agents/registry.ts";
import { hostedMode } from "./config.ts";
import { runAgent, type Approver } from "./runtime.ts";

if (hostedMode()) throw new Error("The command line does not run in hosted mode.");

const [agentName, ...words] = process.argv.slice(2);
const agent = getAgent(agentName ?? "");
const prompt = words.join(" ");

if (!agent || !prompt) {
  console.error(`Usage: npm run agent -- <agent> "<request>"\nAgents: ${listAgents().map((a) => a.name).join(", ")}`);
  process.exit(1);
}

const approveInTerminal: Approver = async ({ tool, args }) => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nThe agent wants to run ${tool}:\n${JSON.stringify(args, null, 2)}`);
  const answer = await terminal.question("Allow this? (y/N) ");
  terminal.close();
  return answer.trim().toLowerCase() === "y";
};

console.log(await runAgent(agent, prompt, approveInTerminal));

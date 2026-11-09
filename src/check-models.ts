import { pathToFileURL } from "node:url";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { kimiTarget, nvidiaTarget, type ModelTarget } from "./config.ts";

/** Candidates for agent work, all listed by NVIDIA's models endpoint. */
const candidates = [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
  "z-ai/glm-5.3-flash",
  "moonshotai/kimi-k2.6",
  "mistralai/mistral-large-4-1t-a52b",
  "minimaxai/minimax-m3.1-flash",
  "deepseek-ai/deepseek-v4.1-flash",
  "nvidia/nemotron-3.5-bolt-e4b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "poolside/laguna-xs-2.1",
];

const probe = tool(async () => "", {
  name: "read_document",
  description: "Read a company document by file name.",
  schema: z.object({ name: z.string() }),
});

export interface CheckResult {
  model: string;
  status: "tools work" | "no tool call" | "error";
  seconds: number;
  detail?: string;
}

/** Sends one harmless prompt and checks whether the model calls the tool correctly. */
export async function checkModel(target: ModelTarget): Promise<CheckResult> {
  const { model } = target;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  try {
    const response = await new ChatOpenAI({
      model,
      apiKey: target.apiKey,
      configuration: { baseURL: target.baseUrl, fetch: target.fetch },
      modelKwargs: target.extraBody,
      maxRetries: 0,
      timeout: 90_000,
    })
      .bindTools([probe])
      .invoke("Use your tool to read the document named policy.txt.");
    const call = response.tool_calls?.[0];
    const correct = call?.name === "read_document" && call.args.name === "policy.txt";
    return { model, status: correct ? "tools work" : "no tool call", seconds: seconds() };
  } catch (error) {
    return { model, status: "error", seconds: seconds(), detail: String(error).split("\n")[0]?.slice(0, 100) };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const kimi = kimiTarget();
  const targets = [...candidates.map(nvidiaTarget), ...(kimi ? [kimi] : [])];
  for (const target of targets) {
    const { status, seconds, detail } = await checkModel(target);
    const name = `${target.provider}: ${target.model}`;
    console.log(`${status.padEnd(13)} ${String(seconds).padStart(5)}s  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

import { randomUUID } from "node:crypto";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { concat } from "@langchain/core/utils/stream";
import { type BaseCheckpointSaver, Command, END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import type { AgentDefinition } from "./agents/types.ts";
import { audit } from "./audit.ts";
import { fileDirectory, type AgentDirectory } from "./agents/registry.ts";
import { modelChain, type ModelPolicy, type ModelTarget } from "./config.ts";
import { platformTools } from "./platform-tools.ts";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { connectTools, type ActivityListener, type ApprovalRequest, type EventListener, type ToolContext, type ToolFolders } from "./tools.ts";

/** How many identical tool calls one run may make before it is stopped. */
export const MAX_REPEATS = 3;
/** Keys in a fixed order, so the same inputs always read the same. */
const stableJson = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value) ?? "null";

export type Approver = (request: ApprovalRequest) => Promise<boolean>;

/** Runs that share an id and memory continue one conversation. */
export interface Conversation {
  id: string;
  memory: BaseCheckpointSaver;
}

export interface RunOptions {
  conversation?: Conversation;
  /** Set when another agent started this run. */
  parentRunId?: string;
  /** Where this run finds other agents. Defaults to the local files. */
  directory?: AgentDirectory;
  policy?: ModelPolicy;
  folders?: ToolFolders;
  /** Earlier turns of a conversation. */
  history?: { role: "user" | "assistant"; content: string }[];
  /** Builds the tools each agent is entitled to, including helpers it delegates to. */
  agentTools?: (agent: AgentDefinition) => Promise<(context: ToolContext) => StructuredToolInterface[]>;
  /** Adds to each agent's instructions for this run, such as its skills and memories. */
  instructionsFor?: (agent: AgentDefinition) => Promise<string>;
  /** Adds material found for this exact request, such as document passages. */
  contextFor?: (agent: AgentDefinition, prompt: string) => Promise<string>;
  /** Where models come from for this run. Defaults to the server's environment settings. */
  modelsFor?: (role: AgentDefinition["model"], policy?: ModelPolicy) => Promise<ModelTarget[]>;
  /** Receives this agent's text as it is written. Helper agents' text is not passed on. */
  onToken?: (text: string) => void;
  beforeApprovedAction?: ToolContext["beforeApprovedAction"];
  recordWrite?: ToolContext["recordWrite"];
}

/** A single question to the models for a role, with the usual fallbacks. */
export async function askModel(role: AgentDefinition["model"], system: string, user: string, policy?: ModelPolicy, modelsFor?: RunOptions["modelsFor"]) {
  const [first, ...rest] = (modelsFor ? await modelsFor(role, policy) : modelChain(role, policy)) as [ModelTarget, ...ModelTarget[]];
  const client = (target: ModelTarget) => new ChatOpenAI({
    model: target.model, apiKey: target.apiKey, configuration: { baseURL: target.baseUrl, fetch: target.fetch }, modelKwargs: target.extraBody, timeout: 120_000, maxRetries: 2,
  });
  const model = rest.length ? client(first).withFallbacks(rest.map(client)) : client(first);
  const response = await model.invoke([new SystemMessage(system), new HumanMessage(user)]);
  return { text: typeof response.content === "string" ? response.content : JSON.stringify(response.content), tokens: response.usage_metadata?.total_tokens ?? 0 };
}

/**
 * The request asks for one tool call at a time, but a provider can ignore that. Calls made together run together, and resuming after an approval
 * runs them again, so an approved action could happen twice. Only the first is kept, in every place a message records it.
 */
function onlyFirstToolCall(message: AIMessage) {
  if ((message.tool_calls?.length ?? 0) < 2) return message;
  const [first] = message.tool_calls!;
  message.tool_calls = [first!];
  const raw = message.additional_kwargs.tool_calls;
  if (raw) message.additional_kwargs.tool_calls = raw.filter((call) => call.id === first!.id);
  const chunked = message as AIMessage & { tool_call_chunks?: { id?: string; index?: number }[] };
  if (chunked.tool_call_chunks) chunked.tool_call_chunks = [];
  return message;
}

export async function runAgent(
  agent: AgentDefinition,
  prompt: string,
  approve: Approver,
  onEvent: EventListener = () => {},
  { conversation, parentRunId, directory = fileDirectory, policy, folders, history = [], agentTools, instructionsFor, contextFor, modelsFor, onToken, beforeApprovedAction, recordWrite }: RunOptions = {},
): Promise<string> {
  const [primaryTarget, ...fallbackTargets] = (modelsFor ? await modelsFor(agent.model, policy) : modelChain(agent.model, policy)) as [ModelTarget, ...ModelTarget[]];
  const runId = randomUUID();
  const emit: ActivityListener = (activity) =>
    onEvent({ ...activity, runId, parentRunId, agent: agent.name, at: new Date().toISOString() });

  // The child runs outside this graph's context, so it is an independent run and not part of this graph.
  const runChild = (child: AgentDefinition, task: string) =>
    AsyncLocalStorageProviderSingleton.getInstance().run(undefined, () =>
      runAgent(child, task, approve, onEvent, { parentRunId: runId, directory, policy, folders, agentTools, instructionsFor, contextFor, modelsFor, beforeApprovedAction, recordWrite }),
    );

  const context = { agent, runId, onActivity: emit, folders, beforeApprovedAction, recordWrite };
  const { tools, close } = await connectTools(context, [
    ...platformTools(context, runChild, directory),
    ...((await agentTools?.(agent))?.(context) ?? []),
  ]);

  const chatModel = (target: ModelTarget) =>
    new ChatOpenAI({
      model: target.model,
      apiKey: target.apiKey,
      configuration: { baseURL: target.baseUrl, fetch: target.fetch },
      modelKwargs: target.extraBody,
      timeout: 120_000,
      maxRetries: 2,
    }).bindTools(tools, { parallel_tool_calls: false });

  const primary = chatModel(primaryTarget);
  const model = fallbackTargets.length ? primary.withFallbacks(fallbackTargets.map(chatModel)) : primary;

  const extraInstructions = `${(await instructionsFor?.(agent)) ?? ""}${(await contextFor?.(agent, prompt)) ?? ""}`;

  /** Streams when someone is watching. A server that cannot stream simply gets a normal request instead. */
  const generate = async (messages: Parameters<typeof model.invoke>[0]) => {
    if (!onToken) return model.invoke(messages);
    let full: Awaited<ReturnType<typeof model.invoke>> | undefined;
    let sent = false;
    try {
      for await (const chunk of await model.stream(messages)) {
        full = full ? concat(full as never, chunk as never) : chunk;
        if (typeof chunk.content === "string" && chunk.content) {
          sent = true;
          onToken(chunk.content);
        }
      }
    } catch (error) {
      if (sent) throw error;
      return model.invoke(messages);
    }
    return full && (full.content || full.tool_calls?.length) ? full : model.invoke(messages);
  };

  // Counted per run: messages from earlier turns of a conversation must not use up this run's budget.
  let used = 0;
  // The same call with the same inputs a third time means the agent is going round in circles,
  // so the run stops there instead of spending until its step or token limit.
  const repeats = new Map<string, number>();

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    if (used > agent.maxTokens) throw new Error(`Token limit reached (${used} of ${agent.maxTokens}).`);

    const started = performance.now();
    const messages = [new SystemMessage(agent.instructions + extraInstructions), ...state.messages];
    const response = onlyFirstToolCall((await generate(messages)) as AIMessage);
    used += response.usage_metadata?.total_tokens ?? 0;
    for (const call of response.tool_calls ?? []) {
      const key = `${call.name}:${stableJson(call.args)}`;
      const seen = (repeats.get(key) ?? 0) + 1;
      repeats.set(key, seen);
      if (seen >= MAX_REPEATS) {
        audit(runId, "loop_stopped", { tool: call.name, repeats: seen });
        throw new Error(`Stopped: the agent asked for the same ${call.name} step ${seen} times with the same details, so it was going round in circles. Try rewording the request.`);
      }
    }
    audit(runId, "model_call", {
      role: agent.model,
      model: response.response_metadata?.model_name,
      usage: response.usage_metadata,
    });
    emit({
      type: "model",
      model: response.response_metadata?.model_name,
      tokens: response.usage_metadata?.total_tokens,
      inputTokens: response.usage_metadata?.input_tokens,
      outputTokens: response.usage_metadata?.output_tokens,
      ms: Math.round(performance.now() - started),
    });
    return { messages: [response] };
  };

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("model", callModel)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "model")
    .addConditionalEdges("model", toolsCondition, ["tools", END])
    .addEdge("tools", "model")
    .compile({ checkpointer: conversation?.memory ?? new MemorySaver() });

  const config = { configurable: { thread_id: conversation?.id ?? runId }, recursionLimit: agent.maxSteps * 2 + 1 };
  audit(runId, "run_started", { agent: agent.name, prompt, conversationId: conversation?.id, parentRunId });
  emit({ type: "started", prompt });

  try {
    const earlier = history.map(({ role, content }) => (role === "user" ? new HumanMessage(content) : new AIMessage(content)));
    let input: Parameters<typeof graph.invoke>[0] = { messages: [...earlier, new HumanMessage(prompt)] };
    for (;;) {
      const result = await graph.invoke(input, config);
      const pending = ((result as { __interrupt__?: unknown }).__interrupt__ ?? []) as {
        id: string;
        value: ApprovalRequest;
      }[];
      if (pending.length === 0) {
        const last = result.messages.at(-1);
        const answer = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
        audit(runId, "run_finished", { answer });
        emit({ type: "finished", answer });
        return answer;
      }
      const decisions: Record<string, boolean> = {};
      for (const item of pending) {
        emit({ type: "approval_needed", ...item.value });
        decisions[item.id] = await approve(item.value);
        emit({ type: "approval_decided", tool: item.value.tool, approved: decisions[item.id]! });
      }
      input = new Command({ resume: decisions });
    }
  } catch (error) {
    audit(runId, "run_failed", { error: String(error) });
    emit({ type: "failed", message: String(error) });
    throw error;
  } finally {
    await close();
  }
}

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { hostedMode, modelChain, type ModelPolicy, type ModelRole, type ModelTarget } from "../config.ts";
import { PermanentError } from "./connectors/types.ts";
import { inWorkspace } from "./db.ts";
import { BlockedAddress, safeFetch } from "./net/safe-fetch.ts";
import { decryptSecret, encryptSecret } from "./secrets.ts";
import { plainError, serviceProblem } from "./plain-errors.ts";

const THINKING_OFF = { thinking: { type: "disabled" } };

/** Starting points only. Anything that speaks the OpenAI chat API can be added as a custom provider. */
interface PresetModels { main?: string; fast?: string; coding?: string; embedding?: string }

/**
 * Model names come from each provider's own model page, checked on 2026-11-07. Main is the provider's most capable model,
 * fast is its cheapest good one. Providers without published names here are found with "Find models" instead.
 */
export const PROVIDER_PRESETS: { id: string; name: string; baseUrl: string; needsKey: boolean; local: boolean; extraBody: Record<string, unknown>; models?: PresetModels }[] = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true, local: false, extraBody: {},
    models: { main: "gpt-6-astra", fast: "gpt-6-luna", coding: "gpt-6-astra", embedding: "text-embedding-3-small" } },
  { id: "anthropic", name: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", needsKey: true, local: false, extraBody: {},
    models: { main: "claude-opus-5-5", fast: "claude-haiku-5-5", coding: "claude-opus-5-5" } },
  { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, local: false, extraBody: {},
    models: { main: "gemini-3.8-flash", fast: "gemini-3.5-flash-lite", coding: "gemini-4-argon", embedding: "gemini-embedding-001" } },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true, local: false, extraBody: {},
    models: { main: "mistral-large-latest", fast: "mistral-small-latest", embedding: "mistral-embed" } },
  { id: "xai", name: "xAI Grok", baseUrl: "https://api.x.ai/v1", needsKey: true, local: false, extraBody: {} },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", needsKey: true, local: false, extraBody: {},
    models: { main: "deepseek-reasoner", fast: "deepseek-chat" } },
  { id: "kimi", name: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1", needsKey: true, local: false, extraBody: THINKING_OFF },
  { id: "qwen", name: "Alibaba Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", needsKey: true, local: false, extraBody: {} },
  { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, local: false, extraBody: {} },
  { id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", needsKey: true, local: false, extraBody: {} },
  { id: "together", name: "Together AI", baseUrl: "https://api.together.xyz/v1", needsKey: true, local: false, extraBody: {} },
  { id: "fireworks", name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1", needsKey: true, local: false, extraBody: {} },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, local: false, extraBody: {} },
  { id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", needsKey: true, local: false, extraBody: {} },
  { id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", needsKey: false, local: true, extraBody: {} },
  { id: "lmstudio", name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", needsKey: false, local: true, extraBody: {} },
  { id: "custom", name: "Custom server", baseUrl: "", needsKey: false, local: false, extraBody: {} },
];

const modelName = z.string().trim().max(200).optional();
const roleModels = z.object({ main: modelName, fast: modelName, coding: modelName, embedding: modelName });
export const providerBody = z.object({
  /** Left out, it becomes the server's host name. */
  name: z.string().trim().max(80).optional(),
  preset: z.string().max(40).default("custom"),
  baseUrl: z.url().refine((value) => /^https?:\/\//.test(value), "must start with http or https"),
  /** Left out when editing, which keeps the saved key. */
  apiKey: z.string().min(1).max(4_000).optional(),
  models: roleModels,
  extraBody: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
  confidentialAllowed: z.boolean().default(false),
  inputPrice: z.number().min(0).max(100_000).nullable().optional(),
  outputPrice: z.number().min(0).max(100_000).nullable().optional(),
});
export type ProviderBody = z.infer<typeof providerBody>;

// Keys are bound to their provider, so a stored key cannot be moved to another address.
export const keyName = (id: string) => `model-provider:${id}`;
const NO_KEY = "not-needed";
const MODEL_TIMEOUT_MS = 120_000;
const MAX_MODEL_REPLY = 20 * 1024 * 1024;

export const sealKey = (masterKey: string, workspaceId: string, id: string, apiKey: string) =>
  encryptSecret(masterKey, workspaceId, keyName(id), apiKey);

function openKey(masterKey: string, workspaceId: string, row: any) {
  if (!row.key_ciphertext) return NO_KEY;
  return decryptSecret(masterKey, workspaceId, keyName(row.id), { ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag });
}

/**
 * A self-hosted server belongs to one company, so its admins can use any model address, local ones included.
 * Customers share a hosted server, so there the private network stays closed.
 */
export const modelNetwork = () => ({
  anyAddress: !hostedMode(),
  allowedPrivateHosts: (process.env.ALLOWED_MODEL_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
});

/** Every model call goes through the network guard, and a key can only go to its own address. */
export const guardedModelFetch = (baseUrl: string) => ((url: string | URL, init?: RequestInit) =>
  safeFetch(url, init, { ...modelNetwork(), onlyOrigin: new URL(baseUrl).origin, timeoutMs: MODEL_TIMEOUT_MS, maxBytes: MAX_MODEL_REPLY, stream: true })) as typeof fetch;

export function explainConnection(error: unknown) {
  if (error instanceof BlockedAddress) {
    return hostedMode() ? `${error.message} The hosted service cannot reach private addresses.` : `${error.message} Cloud metadata addresses are always refused.`;
  }
  return plainError(error, "The AI provider");
}

export const keyOf = openKey;

const toTarget = (masterKey: string, workspaceId: string, row: any, role: ModelRole): ModelTarget => ({
  provider: row.name,
  baseUrl: row.base_url,
  apiKey: openKey(masterKey, workspaceId, row),
  model: row.models[role] || row.models.main,
  extraBody: row.extra_body,
  fetch: guardedModelFetch(row.base_url),
});

export const targetOf = toTarget;

/** Whether the server's own settings hold a model a workspace with no providers can use. Says nothing about which. */
export const serverModels = () => !hostedMode() && ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL_MAIN"].every((name) => !!process.env[name]?.trim());

export type ModelsFor = (role: ModelRole, policy?: ModelPolicy) => Promise<ModelTarget[]>;

/**
 * The models a run may use, in priority order. A workspace with no providers falls back to the server's
 * environment, which keeps older installs working. Once it has any, the environment is ignored completely.
 */
export const workspaceModels = (pool: Pool, workspaceId: string, masterKey: string): ModelsFor => async (role, policy) => {
  const rows = await inWorkspace(pool, workspaceId, async (db) => (await db.query("select * from model_providers order by priority, created_at")).rows);
  if (!rows.length) {
    if (hostedMode()) throw new PermanentError("Add your own AI provider key in Settings to run agents.");
    if (!serverModels()) throw new PermanentError("No AI model is set up yet. Add one in Settings, under AI models, then run this again.");
    return modelChain(role, policy);
  }
  const usable = rows.filter((row) => row.enabled && (!policy?.confidential || row.confidential_allowed));
  if (!usable.length) {
    throw new PermanentError(policy?.confidential
      ? "Confidential mode is on, but no AI provider is cleared for confidential work. Change this in Settings."
      : "No AI provider is turned on. Add or turn one on in Settings.");
  }
  return usable.map((row) => toTarget(masterKey, workspaceId, row, role));
};

/** Fills in what a person left empty. Only the address is needed, as long as the server can say which models it has. */
export async function completeProvider(body: ProviderBody, apiKey: string | undefined) {
  const name = body.name || new URL(body.baseUrl).hostname;
  if (body.models.main) return { ...body, name, models: { ...body.models, main: body.models.main } };
  const first = await discoverModels(body.baseUrl, apiKey).catch(() => [])
  if (!first[0]) throw new Error("This server did not list its models, so enter a model name.");
  return { ...body, name, models: { ...body.models, main: first[0] } };
}

export const providerRow = async (db: PoolClient, id: string) => (await db.query("select * from model_providers where id = $1", [id])).rows[0];

/** Asks a server which models it offers. */
export async function discoverModels(baseUrl: string, apiKey: string | undefined) {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : {};
  // Some servers list models a page at a time: Anthropic with has_more and last_id, Google with a page token.
  const ids: unknown[] = [];
  let next = "";
  for (let page = 0; page < 10; page += 1) {
    const response = await guardedModelFetch(baseUrl)(`${url}${next}`, { headers });
    if (!response.ok) {
      if (page === 0) throw new Error(serviceProblem("The AI provider", response.status));
      break;
    }
    const body = await response.json() as { data?: { id?: unknown }[]; has_more?: boolean; last_id?: string; next_page_token?: string; nextPageToken?: string };
    ids.push(...(body.data ?? []).map((item) => item.id));
    const token = body.next_page_token ?? body.nextPageToken;
    if (body.has_more && body.last_id) next = `?limit=1000&after_id=${encodeURIComponent(body.last_id)}`;
    else if (token) next = `?page_token=${encodeURIComponent(token)}`;
    else break;
  }
  const body = { data: ids.map((id) => ({ id })) };
  // Some servers, Google's among them, can name a model "models/x" where a request expects "x".
  return [...new Set((body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string").map((id) => id.replace(/^models\//, "")))].slice(0, 500);
}

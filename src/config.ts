import dotenv from "dotenv";

dotenv.config({ quiet: true });

/**
 * The multi-tenant cloud version. Read here because the agent code has no platform settings object.
 * Any other value is refused: "True" or "1" would otherwise start a hosted server with none of the hosted rules.
 */
export const HOSTED_MODE_VALUES = ["true", "false", ""] as const;
export function hostedMode() {
  const value = process.env.HOSTED_MODE ?? "";
  if (!(HOSTED_MODE_VALUES as readonly string[]).includes(value)) throw new Error("HOSTED_MODE must be true, false or empty.");
  return value === "true";
}
hostedMode();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing. Copy .env.example to .env and fill it in.`);
  return value;
}

export type ModelRole = "main" | "fast" | "coding" | "kimi";

export interface ModelTarget {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
  /** Replaces the network layer, so a workspace's model calls pass through the guard. */
  fetch?: typeof fetch;
}

function jsonEnv(name: string): Record<string, unknown> {
  return JSON.parse(process.env[name]?.trim() || "{}");
}

export function nvidiaTarget(model: string): ModelTarget {
  return {
    provider: "nvidia",
    baseUrl: required("LLM_BASE_URL"),
    apiKey: required("LLM_API_KEY"),
    model,
    extraBody: jsonEnv("LLM_EXTRA_BODY"),
  };
}

/** Returns undefined when no Kimi key is set, which turns Kimi off. */
export function kimiTarget(): ModelTarget | undefined {
  const apiKey = process.env.KIMI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    provider: "kimi",
    baseUrl: required("KIMI_BASE_URL"),
    apiKey,
    model: required("KIMI_MODEL"),
    extraBody: jsonEnv("KIMI_EXTRA_BODY"),
  };
}

export interface ModelPolicy {
  /** Keeps work away from the NVIDIA trial, whose terms do not allow confidential data. */
  confidential?: boolean;
}

/** The models to try for a role, in order. */
export function modelChain(role: ModelRole, { confidential = false }: ModelPolicy = {}): ModelTarget[] {
  const chain = fullChain(role);
  if (!confidential) return chain;
  const allowed = chain.filter((target) => target.provider !== "nvidia");
  if (allowed.length === 0) throw new Error("Confidential mode needs a model with private data terms. Add one in Settings, under AI models.");
  return allowed;
}

function fullChain(role: ModelRole): ModelTarget[] {
  const fallbackName = process.env.LLM_MODEL_FALLBACK?.trim();
  const backup = fallbackName ? nvidiaTarget(fallbackName) : undefined;
  const kimi = kimiTarget();

  if (role === "kimi") {
    if (!kimi) throw new Error("KIMI_API_KEY is missing, but this agent uses the kimi role.");
    return [kimi, backup].filter((t) => t !== undefined);
  }
  // Kimi leads when its key is set. NVIDIA models follow as fallbacks.
  // The fast and coding models are optional: without one, that work uses the main model rather than failing.
  const named = process.env[`LLM_MODEL_${role.toUpperCase()}`]?.trim();
  const nvidia = nvidiaTarget(named || required("LLM_MODEL_MAIN"));
  return [kimi, nvidia, backup].filter((t) => t !== undefined);
}

export const paths = {
  documents: () => process.env.DOCUMENTS_DIR ?? "data/documents",
  rfqs: () => process.env.RFQS_DIR ?? "data/rfqs",
  agents: () => process.env.AGENTS_DIR ?? "data/agents",
  output: () => process.env.OUTPUT_DIR ?? "output",
  auditLog: () => process.env.AUDIT_LOG ?? "logs/audit.jsonl",
};

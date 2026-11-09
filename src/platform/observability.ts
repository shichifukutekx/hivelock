import type { Pool } from "pg";
import { inWorkspace } from "./db.ts";

export type TraceKind = "run" | "chat" | "eval";

interface Span {
  kind: "model" | "tool" | "guardrail" | "agent";
  name: string;
  agent?: string;
  status?: "ok" | "error" | "refused";
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  risk?: number;
}

type Prices = Record<string, { input: number; output: number }>;

/** Prices per million tokens, from the workspace's providers, then the server's settings. */
async function loadPrices(pool: Pool, workspaceId: string): Promise<Prices> {
  let prices: Prices = {};
  try {
    prices = JSON.parse(process.env.MODEL_PRICES || "{}");
  } catch {}
  const rows = await inWorkspace(pool, workspaceId, async (db) => (await db.query("select models, input_price, output_price from model_providers where input_price is not null and output_price is not null")).rows);
  for (const row of rows) {
    for (const model of Object.values(row.models)) {
      if (typeof model === "string" && model) prices[model] = { input: Number(row.input_price), output: Number(row.output_price) };
    }
  }
  return prices;
}

/** An unknown price stays unknown rather than being guessed. */
function priceOf(prices: Prices, model: string, inputTokens: number, outputTokens: number): number | null {
  const price = prices[model];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
}

const RISKY_WORDS = /\b(delete|drop|truncate|remove|destroy|refund|charge|payment|transfer|wire|grant|revoke|password|secret|production|prod)\b/i;
const WRITE_TOOLS = /(save|write|send|post|execute|create|update|delete|remember)/i;
const BULK = /\b(all|every|\*)\b/i;

/** A 0 to 1 score for a tool call, from what the tool does and what it was asked to do. It informs people and decides nothing. */
export function riskScore(tool: string, args: unknown) {
  const text = (JSON.stringify(args ?? {}) ?? "").slice(0, 20_000);
  const method = (args as { method?: string } | undefined)?.method;
  const changes = WRITE_TOOLS.test(tool) || (typeof method === "string" && !["GET", "HEAD"].includes(method.toUpperCase()));
  let score = changes ? 0.4 : 0.05;
  if (tool.startsWith("mcp_")) score += 0.2;
  if (RISKY_WORDS.test(text)) score += 0.3;
  if (BULK.test(text) && changes) score += 0.15;
  return Math.min(1, Number(score.toFixed(2)));
}

// Sent in batches to the operator's collector. Measurements only, never content.
const pending: object[] = [];
let flushing: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  flushing = undefined;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const batch = pending.splice(0, 500);
  if (!endpoint || !batch.length) return;
  await fetch(`${endpoint.replace(/\/$/, "")}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-platform" } }] }, scopeSpans: [{ scope: { name: "agent-platform" }, spans: batch }] }],
    }),
    signal: AbortSignal.timeout(5_000),
  }).catch((error) => console.error(JSON.stringify({ level: "warn", event: "otel_export_failed", message: error.message })));
}

function exportSpan(traceId: string, span: Span) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const end = BigInt(Date.now()) * 1_000_000n;
  const attribute = (key: string, value: unknown) => (value === undefined || value === null ? [] : [{ key, value: typeof value === "number" ? { doubleValue: value } : { stringValue: String(value) } }]);
  pending.push({
    traceId: traceId.replace(/-/g, ""),
    spanId: crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    name: `${span.kind} ${span.name}`,
    startTimeUnixNano: String(end - BigInt(span.durationMs ?? 0) * 1_000_000n),
    endTimeUnixNano: String(end),
    status: { code: span.status === "error" ? 2 : 1 },
    attributes: [
      ...attribute("agent.name", span.agent),
      ...attribute("gen_ai.usage.input_tokens", span.inputTokens),
      ...attribute("gen_ai.usage.output_tokens", span.outputTokens),
      ...attribute("agent.tool.risk", span.risk),
    ],
  });
  flushing ??= setTimeout(() => void flush(), 1_000);
}

export const flushSpans = flush;

export async function recordSpan(pool: Pool, workspaceId: string, traceId: string, traceKind: TraceKind, span: Span) {
  await inWorkspace(pool, workspaceId, (db) => db.query(
    `insert into spans (workspace_id, trace_id, trace_kind, kind, name, agent, status, duration_ms, input_tokens, output_tokens, cost_usd, risk)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [workspaceId, traceId, traceKind, span.kind, span.name, span.agent ?? null, span.status ?? "ok", span.durationMs ?? null, span.inputTokens ?? null, span.outputTokens ?? null, span.costUsd ?? null, span.risk ?? null],
  ));
  exportSpan(traceId, span);
}

/** Turns an agent's event stream into spans. A failure here is logged and never stops the agent. */
export function spanRecorder(pool: Pool, workspaceId: string, traceId: string, traceKind: TraceKind) {
  const argsByRun = new Map<string, unknown>();
  let prices: Prices | undefined;
  return async (event: any) => {
    try {
      if (event.type === "model") {
        prices ??= await loadPrices(pool, workspaceId);
        await recordSpan(pool, workspaceId, traceId, traceKind, {
          kind: "model", name: event.model ?? "unknown", agent: event.agent, durationMs: event.ms,
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
          costUsd: event.model ? priceOf(prices, event.model, event.inputTokens ?? 0, event.outputTokens ?? 0) : null,
        });
      } else if (event.type === "tool_started") {
        argsByRun.set(`${event.runId}:${event.tool}`, event.args);
      } else if (event.type === "tool_finished") {
        const key = `${event.runId}:${event.tool}`;
        await recordSpan(pool, workspaceId, traceId, traceKind, {
          kind: "tool", name: event.tool, agent: event.agent, durationMs: event.ms, status: event.isError ? "error" : "ok",
          risk: riskScore(event.tool, argsByRun.get(key)),
        });
        argsByRun.delete(key);
      } else if (event.type === "approval_decided" && !event.approved) {
        await recordSpan(pool, workspaceId, traceId, traceKind, { kind: "tool", name: event.tool, agent: event.agent, status: "refused", risk: riskScore(event.tool, {}) });
      } else if (event.type === "failed") {
        await recordSpan(pool, workspaceId, traceId, traceKind, { kind: "agent", name: event.agent ?? "agent", agent: event.agent, status: "error" });
      }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "span_lost", message: (error as Error).message }));
    }
  };
}

/** Tells the operator something went wrong. Names and ids only, never content. */
export async function sendAlert(alert: { type: string; workspaceId: string; id: string; name?: string }) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...alert, at: new Date().toISOString() }), signal: AbortSignal.timeout(5_000) })
    .catch((error) => console.error(JSON.stringify({ level: "warn", event: "alert_failed", message: error.message })));
}

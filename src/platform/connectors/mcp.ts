import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { safeFetch, type NetworkPolicy } from "../net/safe-fetch.ts";
import { PermanentError, registerConnector } from "./types.ts";

const credentials = z.object({ url: z.url(), bearerToken: z.string().optional() });
type Credentials = z.infer<typeof credentials>;

const MAX_TOOLS = 100;
const MAX_DESCRIPTION = 2_000;
const MAX_OUTPUT = 50_000;
const toolCall = z.object({ tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).default({}) });

export interface ReviewedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  fingerprint: string;
}

/** Changes whenever a tool's meaning changes, so a server cannot swap a reviewed tool for something else. */
const fingerprint = (tool: { name: string; description?: string; inputSchema?: unknown }) =>
  createHash("sha256").update(JSON.stringify([tool.name, tool.description ?? "", tool.inputSchema ?? {}])).digest("hex");

async function withClient<T>(c: Credentials, network: NetworkPolicy, work: (client: Client) => Promise<T>): Promise<T> {
  const origin = new URL(c.url).origin;
  const transport = new StreamableHTTPClientTransport(new URL(c.url), {
    fetch: (url, init) => safeFetch(url as string | URL, init, { ...network, onlyOrigin: origin }) as never,
    requestInit: c.bearerToken ? { headers: { authorization: `Bearer ${c.bearerToken}` } } : undefined,
  });
  const client = new Client({ name: "agent-platform", version: "0.1.0" });
  await client.connect(transport as never);
  try {
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function discoverTools(connection: unknown, network: NetworkPolicy): Promise<ReviewedTool[]> {
  return withClient(credentials.parse(connection), network, async (client) => {
    const { tools } = await client.listTools();
    return tools.slice(0, MAX_TOOLS).map((tool) => ({
      name: tool.name,
      description: (tool.description ?? "").slice(0, MAX_DESCRIPTION),
      inputSchema: tool.inputSchema,
      fingerprint: fingerprint(tool),
    }));
  });
}

/** Calls one reviewed tool, after checking it is still exactly what a person approved. */
export async function callReviewedTool(connection: unknown, network: NetworkPolicy, tool: { name: string; fingerprint: string }, args: Record<string, unknown>) {
  return withClient(credentials.parse(connection), network, async (client) => {
    const { tools } = await client.listTools();
    const current = tools.find((t) => t.name === tool.name);
    if (!current || fingerprint(current) !== tool.fingerprint) {
      throw new PermanentError(`The tool ${tool.name} changed on the server, so it needs a new review.`);
    }
    const result = await client.callTool({ name: tool.name, arguments: args });
    const blocks = (result.content ?? []) as { type: string; text?: string }[];
    const text = blocks.map((b) => b.text ?? `[${b.type}]`).join("\n").slice(0, MAX_OUTPUT);
    if (result.isError) throw new PermanentError(text || `The tool ${tool.name} failed.`);
    return text;
  });
}

registerConnector({
  name: "mcp",
  label: "Custom MCP server",
  category: "mcp",
  description: "Paste the URL of any MCP server. Each of its tools stays off until a person turns it on.",
  fields: [
    { name: "url", label: "Server URL", type: "url", required: true },
    { name: "bearerToken", label: "Access token", type: "password" },
  ],
  credentials,
  // Tool calls need the review record, so they run through the connector step, not these actions.
  actions: {
    call_tool: {
      label: "Use a reviewed tool",
      changesData: true,
      params: toolCall,
      run: async () => {
        throw new PermanentError("MCP tools run through a reviewed tool record.");
      },
    },
  },
  test: async (connection, { network }) => {
    await discoverTools(connection, network);
  },
});

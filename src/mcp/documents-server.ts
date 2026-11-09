import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerSaveReport } from "./save-report.ts";

const documentsDir = resolve(process.env.DOCUMENTS_DIR ?? "data/documents");
const MAX_CHARS = 50_000;

/** Resolves links too, so a path or symlink cannot escape the documents folder. */
async function safeDocumentPath(name: string): Promise<string> {
  const root = await realpath(documentsDir);
  const target = await realpath(join(root, name));
  if (!target.startsWith(root + sep)) throw new Error("That file is outside the documents folder.");
  return target;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const server = new McpServer({ name: "documents", version: "0.1.0" });

server.registerTool(
  "list_documents",
  { description: "List the available company documents.", inputSchema: {} },
  async () => {
    const entries = await readdir(documentsDir, { withFileTypes: true });
    return text(entries.filter((e) => e.isFile()).map((e) => e.name).join("\n") || "No documents found.");
  },
);

server.registerTool(
  "read_document",
  { description: "Read a company document by file name.", inputSchema: { name: z.string() } },
  async ({ name }) => text((await readFile(await safeDocumentPath(name), "utf8")).slice(0, MAX_CHARS)),
);

registerSaveReport(server);

await server.connect(new StdioServerTransport());
